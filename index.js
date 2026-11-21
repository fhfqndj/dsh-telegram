/**
 * Host-часть Telegram-моста.
 *
 * Плагин держит long-polling бота, превращает сообщения владельца в сообщения
 * сессиям DeepSeek Harness, ретранслирует ответ агента в чат и присылает
 * уведомления о завершении работы. Секрет (токен) читается из хранилища
 * credentials, а не из патча профиля.
 *
 * @module dsh-telegram
 */

import os from 'node:os'
import path from 'node:path'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { callWithRetry, sleep } from './src/tg/client.js'
import {
  downgradeHeadings, escapeHtml, hardLineBreaks, markdownToHtml, normalizeBlocks, splitHtml,
  tablesToList,
} from './src/tg/html.js'
import { botIdentity, clearWebhook, createPoller, webhookInfo } from './src/tg/poll.js'
import { createCardStreamer } from './src/tg/stream.js'
import { createFileLogger } from './src/log.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { downloadFile, imageMediaType, safeFileName, sendDocument } from './src/tg/files.js'
import { RichUnsupportedError, sendRichMessage } from './src/tg/rich.js'
import { botCommands, languageFromTelegram, normalizeLanguage, translate } from './src/i18n.js'
import { Config, NOTIFY_MODES, readConfig } from './src/config.js'
import { access } from './src/bridge/access.js'
import { commands } from './src/bridge/commands.js'
import { core } from './src/bridge/core.js'
import { delivery } from './src/bridge/delivery.js'
import { model } from './src/bridge/model.js'
import { seams } from './src/bridge/seams.js'
import { sessions } from './src/bridge/sessions.js'
import { usage } from './src/bridge/usage.js'
import { SAFE_TOOLS, TOKEN_REF, formatTokens, matchesTool } from './src/bridge/kernel.js'

export { Config } from './src/config.js'

export const name = 'telegram'

/** Сервисы, без которых мост не имеет смысла. */
export const inject = ['credentials', 'sessionController', 'workspaceRegistry']

const STATE_DIR = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(STATE_DIR, 'telegram-bridge.json')

export function hostSupported(ctx) {
  if (typeof ctx?.get !== 'function') return false
  return ctx.get('sessionController') !== undefined && ctx.get('credentials') !== undefined
}

export function apply(ctx, config) {
  if (!hostSupported(ctx)) {
    ctx.logger?.warn?.('dsh-telegram: хост слишком старый — нужен dsh >= 0.2.2-rc.1 (нет sessionController или credentials)')
    return
  }
  const bridge = new TelegramBridge(ctx, config)

  ctx.effect(() => {
    const controller = new AbortController()
    void bridge.run(controller.signal).catch((error) => {
      ctx.logger.warn('telegram: loop stopped: %s', String(error))
    })
    return () => {
      controller.abort()
      bridge.dispose()
    }
  }, 'telegram: bot loop')

  ctx.on('credentials/reference-updated', (ref) => {
    if (ref !== TOKEN_REF) return
    bridge.tokenCache = undefined
    bridge.log.info('credential TELEGRAM_BOT_TOKEN обновлён — перезапускаю поллер')
    // Останавливаем текущий цикл: следующий виток run() возьмёт новый токен.
    bridge.pollerAbort?.abort()
  })

  // Любое исключение в обработчике раньше уходило в Host и валило приложение:
  // теперь оно остаётся в файловом логе плагина.
  const guard = (name, run) => {
    try {
      const result = run()
      if (result !== undefined && typeof result.then === 'function') {
        result.catch((error) => bridge.internalError(name, error))
      }
    } catch (error) {
      bridge.internalError(name, error)
    }
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    guard('assistant-stream', () => bridge.onAssistantStream(agent, frame))
  })

  ctx.on('session/event', (session, event) => {
    guard('session/event', () => bridge.onSessionEvent(session, event))
  })

  // Каталог моделей DSH: нужен для пикера /model.
  ctx.inject(['llm'], (child) => {
    bridge.llm = child.llm
  })

  // Инструмент агента: отправить текст и/или файл владельцу в Telegram.
  ctx.inject(['tools'], (child) => {
    child.tools.register(defineTool({
      name: 'telegram_send',
      description: 'Send a message and/or a local file to the Telegram owner chat.',
      parameters: {
        text: { type: 'string', description: 'Message text' },
        file: { type: 'string', description: 'Absolute path to a file to send as a document' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return await bridge.sendToOwner(args.text, args.file)
      },
    }))
  })

  // prepend: иначе запрос сначала забирает веб-клиент, и в Telegram он не доходит.
  ctx.on('user-questions/request', (request, next) => {
    return bridge.onQuestionRequest(request, next).catch((error) => {
      bridge.internalError('user-questions/request', error)
      return next()
    })
  }, true)

  ctx.on('approval/request', (request, next) => {
    let result
    try {
      result = bridge.onApprovalRequest(request, next)
    } catch (error) {
      bridge.internalError('approval/request', error)
      return next()
    }
    return result
  }, true)
}

class TelegramBridge {
  constructor(ctx, config, options = {}) {
    this.ctx = ctx
    this.config = config
    /** Файл состояния: выносится в опцию, чтобы тесты не писали в домашний каталог. */
    this.stateFile = options.stateFile ?? STATE_FILE
    this.log = options.log ?? createFileLogger(path.join(STATE_DIR, 'logs'))
    /** @type {{ offset?: number, bindings: Record<string, { sessionId: string, title?: string }>, ownerId: number, ownerChatId?: number, diagnostics?: object }} */
    this.state = { bindings: {}, notify: {}, lang: {}, ownerId: 0 }
    this.loaded = false
    this.saveChain = Promise.resolve()
    this.botName = undefined
    /** @type {Map<string, { text: string, chatId: string | number, threadId?: number, streamer: any, delivered: boolean }>} */
    this.turns = new Map()
    /** @type {Map<string, { at: number, items: string[] }>} */
    this.sessionButtons = new Map()
    /** Сессии, в которые мы только что написали из чата: их финал уже доставлен ответом. */
    this.botTurns = new Set()
    /** Последний текст ассистента по сессии — для уведомлений о работе не из чата. */
    this.lastAssistant = new Map()
    /** Кэш сессий текущего workspace: чтобы уведомлять и о работе, начатой в Desktop. */
    this.workspaceCache = { ids: new Set(), at: 0 }
    /** Таймеры индикатора «печатает…» по сессиям. */
    this.typingPulse = new Map()
    /** Поддерживает ли сервер rich messages: undefined — ещё не проверяли. */
    this.richSupported = undefined
    /** Ожидающие подтверждения: id → {resolve, chatId, threadId, messageId, timer}. */
    this.pendingApprovals = new Map()
    this.approvalSeq = 0
    this.questionSeq = 0
    this.pendingQuestions = new Map()
    this.modelButtons = new Map()
    this.tokenCache = undefined
    this.disposed = false
    this.calls = new AbortController()
  }

  /** База Bot API: облачный Telegram или локальный сервер для проверки. */

  async run(signal) {
    await this.loadState()
    while (!signal.aborted && !this.disposed) {
      const cfg = this.cfg()
      if (!cfg.enabled) {
        await sleep(3000)
        continue
      }
      const token = await this.token()
      if (token === undefined || token === '') {
        this.log.info('token: отсутствует в credentials, жду 5 с')
        await sleep(5000)
        continue
      }

      try {
        await clearWebhook(token, { baseUrl: this.apiBase() })
        const me = await botIdentity(token, { baseUrl: this.apiBase() })
        this.botName = me?.username
        this.state.diagnostics = {
          ...this.state.diagnostics,
          botUsername: me?.username,
          startedAt: Date.now(),
          lastError: undefined,
        }
        await this.saveState()
        await this.publishCommands(token)
        const info = await webhookInfo(token, { baseUrl: this.apiBase() }).catch(() => undefined)
        this.ctx.logger.info(
          'telegram: polling as @%s (webhook=%s)',
          me?.username ?? '?',
          info?.url ? 'set' : 'none',
        )
        await this.pruneState()
        if (this.pruneTimer === undefined) {
          this.pruneTimer = setInterval(() => { void this.pruneState().catch(() => {}) }, 6 * 60 * 60 * 1000)
          this.pruneTimer.unref?.()
        }
        this.log.info(`start: @${me?.username ?? '?'} webhook=${info?.url ? 'set' : 'none'} owner=${this.ownerId()} workspace=${this.cfg().workspacePath || '(первый)'}`)
      } catch (error) {
        this.ctx.logger.warn('telegram: startup failed: %s', String(error))
        this.log.error(`startup: ${String(error)}`)
        await sleep(10000)
        continue
      }

      const restart = new AbortController()
      this.pollerAbort = restart
      const poller = createPoller({
        token,
        state: this.state,
        persistOffset: () => this.saveStateSoon(),
        isStopped: () => signal.aborted || this.disposed || restart.signal.aborted || !this.cfg().enabled,
        baseUrl: this.apiBase(),
        onUpdate: (update) => this.handleUpdate(update, token),
        onEvent: (event) => {
          if (event.kind === 'error' || event.kind === 'unauthorized') {
            this.ctx.logger.warn('telegram: %s: %s', event.kind, String(event.error ?? ''))
            this.log.warn(`poll ${event.kind}: ${String(event.error ?? '')}`)
          }
          if (event.kind === 'conflict') {
            this.ctx.logger.warn('telegram: 409 conflict — второй поллер или установленный webhook')
            this.log.warn('poll conflict 409: второй поллер с этим токеном или установленный webhook')
          }
          if (event.kind === 'handler-failed') {
            this.log.error(`update ${event.updateId}: обработчик упал: ${String(event.error)}`)
          }
          if (event.kind === 'rate-limited') {
            this.log.warn(`poll 429: ждём ${event.retryAfter ?? 1} с`)
          }
        },
      })
      await poller.start()
      poller.stop()
      this.pollerAbort = undefined
      await sleep(2000)
    }
  }

  dispose() {
    this.disposed = true
    this.calls.abort()
    // Таймер ретенции иначе переживает перезагрузку плагина и держит ссылку на объект.
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
    }
    for (const sessionId of [...this.typingPulse.keys()]) this.stopTypingPulse(sessionId)
    for (const turn of this.turns.values()) {
      void turn.streamer?.discard?.()
    }
    this.turns.clear()
    // Висящие запросы закрываем сразу: иначе seam-ответчик ждёт таймаут 5–10 минут.
    for (const pending of this.pendingApprovals.values()) pending.resolve('cancelled')
    this.pendingApprovals.clear()
    for (const pending of this.pendingQuestions.values()) pending.resolve(undefined)
    this.pendingQuestions.clear()
  }

  
  async handleUpdate(update, token) {
    this.log.info(`update ${update.update_id} ${update.message ? 'message' : update.callback_query ? 'callback' : 'other'}`)
    this.state.diagnostics = {
      ...this.state.diagnostics,
      lastUpdateAt: Date.now(),
      lastUpdateId: update.update_id,
    }
    if (update.callback_query !== undefined) {
      await this.handleCallback(update.callback_query, token)
      return
    }
    if (update.message !== undefined) {
      await this.handleMessage(update.message, update.update_id, token)
    }
  }
}

// Мост собран из миксинов: каждый модуль в src/bridge отвечает за свою часть.
Object.assign(
  TelegramBridge.prototype,
  core, access, sessions, delivery, commands, seams, model, usage,
)

export { TelegramBridge }
