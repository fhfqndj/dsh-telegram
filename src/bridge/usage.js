/**
 * usage: часть TelegramBridge, подключается миксином к прототипу.
 */
import { formatTokens } from './kernel.js'

export const usage = {
addUsage(sessionId, usage) {
  if (usage === undefined || usage === null) return
  const current = this.state.usage?.[sessionId] ?? {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0,
  }
  const number = (value) => (Number.isFinite(value) ? Number(value) : 0)
  const next = {
    input: current.input + number(usage.inputTokens),
    output: current.output + number(usage.outputTokens),
    cacheRead: current.cacheRead + number(usage.cacheReadTokens),
    cacheWrite: current.cacheWrite + number(usage.cacheWriteTokens),
    reasoning: current.reasoning + number(usage.reasoningTokens),
    requests: current.requests + 1,
    at: Date.now(),
  }
  this.state.usage = this.state.usage ?? {}
  this.state.usage[sessionId] = next
  // Пишем на диск редко: usage приходит на каждом шаге.
  if (this.usageDirty !== true) {
    this.usageDirty = true
    setTimeout(() => {
      this.usageDirty = false
      void this.saveState().catch(() => {})
    }, 5000).unref?.()
  }
},

/**
 * Чистит накопленное: расход и модели по старым сессиям, биндинги удалённых сессий.
 *
 * Запускается на старте и раз в шесть часов. `retentionDays = 0` отключает чистку
 * записей о расходе; биндинги на несуществующие сессии убираются всегда.
 *
 * @returns {Promise<{usage: number, model: number, bindings: number}>}
 */
usageOf(sessionId) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }
  const session = this.state.usage?.[sessionId] ?? zero
  const total = Object.values(this.state.usage ?? {}).reduce((sum, item) => ({
    input: sum.input + (item.input ?? 0),
    output: sum.output + (item.output ?? 0),
    cacheRead: sum.cacheRead + (item.cacheRead ?? 0),
    cacheWrite: sum.cacheWrite + (item.cacheWrite ?? 0),
    reasoning: sum.reasoning + (item.reasoning ?? 0),
    requests: sum.requests + (item.requests ?? 0),
  }), zero)
  return { session, total, sessions: Object.keys(this.state.usage ?? {}).length }
},

/**
 * Каталог моделей: провайдеры и их модели.
 * @returns {Promise<{provider: string, models: string[]}[]>}
 */
async costText(chatId, threadId) {
  const say = (key, params) => this.say(chatId, threadId, key, params)
  const binding = this.bindingFor(chatId, threadId)
  const { session, total, sessions } = this.usageOf(binding?.sessionId)
  const all = total.input + total.output
  const lines = []
  if (binding?.sessionId === undefined) {
    lines.push(say('costNoSession'))
  } else {
    lines.push(say('costSession', {
      input: formatTokens(session.input),
      output: formatTokens(session.output),
      cache: formatTokens(session.cacheRead),
      requests: String(session.requests),
    }))
  }
  lines.push(say('costTotal', {
    total: formatTokens(all),
    sessions: String(sessions),
    requests: String(total.requests),
  }))
  if (total.reasoning > 0) lines.push(say('costReasoning', { reasoning: formatTokens(total.reasoning) }))
  return lines.join('\n')
},

async pruneState() {
  const days = this.cfg().retentionDays
  const now = Date.now()
  const limit = days > 0 ? now - days * 24 * 60 * 60 * 1000 : undefined
  const removed = { usage: 0, model: 0, bindings: 0 }

  if (limit !== undefined) {
    for (const [sessionId, record] of Object.entries(this.state.usage ?? {})) {
      const at = Number(record?.at ?? 0)
      if (at !== 0 && at < limit) {
        delete this.state.usage[sessionId]
        removed.usage += 1
      }
    }
    for (const sessionId of Object.keys(this.state.model ?? {})) {
      if (this.state.usage?.[sessionId] === undefined) {
        delete this.state.model[sessionId]
        removed.model += 1
      }
    }
  }

  // Биндинги на исчезнувшие сессии: иначе /sessions показывает мёртвые ссылки.
  try {
    const items = await this.listAllSessions()
    const alive = new Set(items.map((item) => item.sessionId))
    const staleAfter = now - 24 * 60 * 60 * 1000
    for (const [key, binding] of Object.entries(this.state.bindings ?? {})) {
      const sessionId = binding?.sessionId
      if (sessionId === undefined) continue
      // Проверяем только старые биндинги: свежие могут быть ещё не в списке.
      if (alive.has(sessionId)) continue
      const boundAt = Number(binding?.at ?? 0)
      if (boundAt === 0) {
        // Старая запись без метки: помечаем сейчас и удалим на следующем проходе.
        binding.at = now
        continue
      }
      if (boundAt > staleAfter) continue
      delete this.state.bindings[key]
      removed.bindings += 1
    }
  } catch (error) {
    this.log.warn(`prune: сессии недоступны — ${String(error)}`)
  }

  if (removed.usage + removed.model + removed.bindings > 0) {
    await this.saveState()
    this.log.info(`prune: usage=${removed.usage} model=${removed.model} bindings=${removed.bindings} (храним ${days} дн.)`)
  }
  return removed
}

/** Расход по сессии и суммарно по всем сессиям. */
}
