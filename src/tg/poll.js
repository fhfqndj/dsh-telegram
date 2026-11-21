/**
 * Long polling для одного бота.
 *
 * Правила, которые здесь зашиты (см. docs/DESIGN.md):
 * - offset двигается только после успешной обработки апдейта;
 * - дедуп по update_id в памяти (после рестарта защищает детерминированный requestId промпта);
 * - упавший обработчик не превращается в busy-loop: пауза, а после нескольких
 *   неудач «ядовитый» апдейт пропускается, чтобы не блокировать очередь;
 * - 409 (второй поллер) — пауза и повтор, 401 (плохой токен) — остановка;
 * - у каждого запроса есть таймаут, а stop() действительно прекращает цикл.
 */

import { TelegramError, callWithRetry, sleep } from './client.js'

const DEFAULT_ALLOWED_UPDATES = ['message', 'callback_query']
const LONG_POLL_TIMEOUT_MS = 40_000
const MAX_ATTEMPTS_PER_UPDATE = 3

/**
 * @param {object} options
 * @param {string} options.token
 * @param {(update: any) => Promise<void> | void} options.onUpdate
 * @param {{ offset?: number }} [options.state] изменяемый объект: поллер пишет сюда offset
 * @param {() => Promise<void> | void} [options.persistOffset] вызывается после сдвига offset
 * @param {() => boolean} [options.isStopped] внешнее условие остановки (например, бот выключен)
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.allowedUpdates]
 * @param {number} [options.conflictDelayMs]
 * @param {number} [options.failureDelayMs]
 * @param {(event: object) => void} [options.onEvent] телеметрия: polling/error/conflict/poison
 */
export function createPoller(options) {
  const state = options.state ?? { offset: undefined }
  const allowedUpdates = options.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES
  const externalStop = options.isStopped ?? (() => options.signal?.aborted === true)
  const onEvent = options.onEvent ?? (() => {})
  const conflictDelayMs = options.conflictDelayMs ?? 3000
  const failureDelayMs = options.failureDelayMs ?? 1000
  const seen = new Set()
  const local = new AbortController()
  /** @type {Map<number, number>} попытки обработки одного апдейта */
  const attempts = new Map()
  let running = false

  const stopped = () => local.signal.aborted || externalStop()

  async function processBatch(updates) {
    for (const update of updates) {
      if (seen.has(update.update_id)) {
        state.offset = update.update_id + 1
        continue
      }
      try {
        await options.onUpdate(update)
      } catch (error) {
        const tried = (attempts.get(update.update_id) ?? 0) + 1
        attempts.set(update.update_id, tried)
        onEvent({ kind: 'handler-failed', updateId: update.update_id, attempt: tried, error })
        if (tried < MAX_ATTEMPTS_PER_UPDATE) return false
        // «Ядовитый» апдейт: пропускаем, иначе очередь встанет навсегда.
        onEvent({ kind: 'poison', updateId: update.update_id, attempt: tried, error })
        seen.add(update.update_id)
        state.offset = update.update_id + 1
        attempts.delete(update.update_id)
        await options.persistOffset?.()
        continue
      }
      attempts.delete(update.update_id)
      seen.add(update.update_id)
      if (seen.size > 5000) seen.delete(seen.values().next().value)
      state.offset = update.update_id + 1
      await options.persistOffset?.()
    }
    return true
  }

  async function loop() {
    if (running) return
    running = true
    try {
      while (!stopped()) {
        try {
          const timeout = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS)
          const signal = typeof AbortSignal.any === 'function'
            ? AbortSignal.any([local.signal, timeout])
            : timeout
          const updates = await callWithRetry(options.token, 'getUpdates', {
            offset: state.offset,
            limit: 100,
            timeout: 25,
            allowed_updates: allowedUpdates,
          }, {
            attempts: 3,
            fetchImpl: options.fetchImpl,
            baseUrl: options.baseUrl,
            signal,
          })
          if (Array.isArray(updates) && updates.length > 0) {
            const done = await processBatch(updates)
            if (!done) {
              await sleep(failureDelayMs)
              continue
            }
          }
          onEvent({ kind: 'polling' })
        } catch (error) {
          if (stopped()) break
          if (error instanceof TelegramError) {
            if (error.status === 401) {
              onEvent({ kind: 'unauthorized', error })
              break
            }
            if (error.status === 409) {
              onEvent({ kind: 'conflict', error })
              await sleep(conflictDelayMs)
              continue
            }
            if (error.status === 429) {
              onEvent({ kind: 'rate-limited', retryAfter: error.retryAfter })
              await sleep((error.retryAfter ?? 1) * 1000)
              continue
            }
            onEvent({ kind: 'error', error })
            await sleep(failureDelayMs)
            continue
          }
          onEvent({ kind: 'error', error })
          await sleep(failureDelayMs)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start: loop,
        stop() {
      local.abort()
    },
    get offset() {
      return state.offset
    },
  }
}

/**
 * Снимает вебхук, иначе getUpdates отвечает 409.
 * @param {string} token
 * @param {{ baseUrl?: string }} [options]
 */
export async function clearWebhook(token, options = {}) {
  return callWithRetry(token, 'deleteWebhook', { drop_pending_updates: false }, {
    attempts: 2,
    baseUrl: options.baseUrl,
    signal: AbortSignal.timeout(15_000),
  })
}

/**
 * Диагностика: пустой url означает, что бот на long polling.
 * @param {string} token
 * @param {{ baseUrl?: string }} [options]
 */
export async function webhookInfo(token, options = {}) {
  return callWithRetry(token, 'getWebhookInfo', {}, {
    attempts: 2,
    baseUrl: options.baseUrl,
    signal: AbortSignal.timeout(15_000),
  })
}

export async function botIdentity(token, options = {}) {
  return callWithRetry(token, 'getMe', {}, {
    attempts: 2,
    baseUrl: options.baseUrl,
    signal: AbortSignal.timeout(15_000),
  })
}
