/**
 * sessions: часть TelegramBridge, подключается миксином к прототипу.
 */
import { downloadFile, imageMediaType, safeFileName } from '../tg/files.js'
import { escapeHtml } from '../tg/html.js'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SESSION_BUTTON_TTL_MS, extractText } from './kernel.js'

export const sessions = {
/**
 * Каталог для новых сессий и список /sessions.
 *
 * Явный workspacePath важнее всего. Пустое значение раньше брало первый
 * зарегистрированный workspace — а это может быть чужой проект, поэтому
 * теперь берём каталог последней активной сессии, и только если сессий нет,
 * первый зарегистрированный.
 */
async workspacePath() {
  const configured = this.cfg().workspacePath
  if (configured !== '') return configured
  try {
    const items = await this.listAllSessions()
    const latest = [...items].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
    if (latest?.cwd !== undefined) return latest.cwd
  } catch {
  }
  try {
    const workspaces = this.ctx.workspaceRegistry.list()
    if (workspaces.length > 0) return workspaces[0].path
  } catch {
    // реестр может быть недоступен — работаем от домашнего каталога
  }
  return os.homedir()
},

async createSession(title) {
  const cwd = await this.workspacePath()
  // Если каталог принадлежит зарегистрированному workspace — создаём внутри него,
  // иначе сессия появляется в Desktop вне группы workspace.
  try {
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace !== undefined) {
      const created = await this.ctx.sessionController.create({
        workspaceId: workspace.id,
        ...(title ? { title } : {}),
      })
      this.log.info(`session ${created.sessionId} создана в workspace ${workspace.path}`)
      return created.sessionId
    }
  } catch (error) {
    this.log.warn(`resolveByPath(${cwd}): ${String(error)}`)
  }
  const created = await this.ctx.sessionController.create({ cwd, ...(title ? { title } : {}) })
  this.log.info(`session ${created.sessionId} создана по cwd ${cwd}`)
  return created.sessionId
},

async createAndBind(chatId, threadId, title) {
  const cfg = this.cfg()
  if (!cfg.allowNewSessions) {
    await this.send(chatId, this.say(chatId, threadId, 'noActiveSession'), threadId)
    return undefined
  }
  try {
    const sessionId = await this.createSession(title)
    await this.bind(chatId, threadId, sessionId)
    await this.send(chatId, this.say(chatId, threadId, 'sessionCreated', {
      id: escapeHtml(sessionId),
      title: title ? `\n${escapeHtml(title)}` : '',
    }), threadId)
    return sessionId
  } catch (error) {
    await this.send(chatId, this.say(chatId, threadId, 'sessionCreateFailed', {
      error: escapeHtml(String(error?.message ?? error)),
    }), threadId)
    return undefined
  }
},

/**
 * Принимает фото и документы из чата: фото уходит в промпт картинкой,
 * документ сохраняется в workspace и передаётся путём.
 * @returns {Promise<{parts: object[], text: string} | undefined>} undefined — уже ответили
 */
async readIncomingMedia(message, chatId, threadId) {
  const token = await this.token()
  if (token === undefined) return { parts: [], text: '' }
  const say = (key, params) => this.say(chatId, threadId, key, params)
  const parts = []
  let text = (message.text ?? message.caption ?? '').trim()

  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined
  if (photo !== undefined) {
    try {
      const file = await downloadFile(token, photo.file_id, { baseUrl: this.apiBase() })
      const mediaType = imageMediaType(file.filePath) ?? 'image/jpeg'
      parts.push({ type: 'image', mediaType, data: file.buffer.toString('base64'), name: 'photo' })
    } catch (error) {
      this.log.error(`photo: ${String(error)}`)
      await this.send(chatId, say('fileFailed', { error: escapeHtml(String(error?.message ?? error)) }), threadId)
      return undefined
    }
  }

  if (message.document !== undefined) {
    try {
      const file = await downloadFile(token, message.document.file_id, { baseUrl: this.apiBase() })
      const dir = path.join(await this.workspacePath(), '.telegram-inbox')
      await mkdir(dir, { recursive: true })
      const target = path.join(dir, `${Date.now()}-${safeFileName(file.filePath, 'document')}`)
      await writeFile(target, file.buffer, { mode: 0o600 })
      text = [text, say('fileSaved', { path: escapeHtml(target) })].filter(Boolean).join('\n\n')
    } catch (error) {
      this.log.error(`document: ${String(error)}`)
      await this.send(chatId, say('fileFailed', { error: escapeHtml(String(error?.message ?? error)) }), threadId)
      return undefined
    }
  }

  if (message.voice !== undefined || message.video !== undefined || message.audio !== undefined || message.sticker !== undefined) {
    // Уже ответили отказом: второе сообщение «понимаю только текст» было бы шумом.
    await this.send(chatId, say('unsupportedMedia'), threadId)
    return undefined
  }

  return { parts, text }
},

async forwardTask(chatId, threadId, text, updateId, parts = []) {
  let binding = this.bindingFor(chatId, threadId)
  if (binding?.sessionId === undefined) {
    if (!this.cfg().allowNewSessions) {
      await this.send(chatId, this.say(chatId, threadId, 'noActiveSession'), threadId)
      return
    }
    const sessionId = await this.createAndBind(chatId, threadId, text.slice(0, 60))
    if (sessionId === undefined) return
    binding = { sessionId }
  }

  let sessionId = binding.sessionId
  const requestId = `tg-${chatId}-${updateId}`
  try {
    await this.promptWithTimeout(sessionId, requestId, text, parts)
    this.botTurns.add(sessionId)
    this.log.info(`prompt → ${sessionId} (${text.length} символов)`)
    await this.typing(chatId, threadId)
  } catch (error) {
    const raw = String(error?.message ?? error)
    const message = raw === 'timeout' ? this.say(chatId, threadId, 'promptTimeout') : raw
    // Сессия могла быть удалена или перенесена: снимаем привязку и заводим новую.
    if (/not-found|not found|no such session/i.test(message) && this.cfg().allowNewSessions) {
      this.log.warn(`привязка ${sessionId} устарела: ${message}`)
      delete this.state.bindings[this.bindingKey(chatId, threadId)]
      await this.saveState()
      const fresh = await this.createAndBind(chatId, threadId, text.slice(0, 60))
      if (fresh !== undefined) {
        try {
          await this.promptWithTimeout(fresh, requestId, text, parts)
          this.botTurns.add(fresh)
          return
        } catch (retryError) {
          this.log.error(`prompt ${fresh}: ${String(retryError)}`)
        }
      }
      return
    }
    this.log.error(`prompt ${sessionId}: ${message}`)
    await this.send(chatId, this.say(chatId, threadId, 'promptFailed', { error: escapeHtml(message) }), threadId)
  }
},

async promptWithTimeout(sessionId, requestId, text, parts = []) {
  const timeout = AbortSignal.timeout(30_000)
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([this.signal(), timeout]) : timeout
  try {
    await this.ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }, ...parts],
    }, signal)
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error('timeout')
    }
    throw error
  }
},

async stopSession(chatId, threadId) {
  const binding = this.bindingFor(chatId, threadId)
  if (binding?.sessionId === undefined) {
    await this.send(chatId, this.say(chatId, threadId, 'stopNoSession'), threadId)
    return
  }
  try {
    await this.ctx.sessionController.cancel({ sessionId: binding.sessionId })
    await this.send(chatId, this.say(chatId, threadId, 'stopped'), threadId)
  } catch (error) {
    await this.send(chatId, this.say(chatId, threadId, 'stopFailed', {
      error: escapeHtml(String(error?.message ?? error)),
    }), threadId)
  }
}


/** Все сессии без выбора workspace: используется и списком, и фолбэком workspace. */,

async listAllSessions() {
  try {
    const value = await this.ctx.sessionController.list({}, this.signal())
    return Array.isArray(value?.items) ? value.items : []
  } catch (error) {
    this.ctx.logger.warn('telegram: list failed: %s', String(error))
    return []
  }
},

async listSessions() {
  const workspacePath = await this.workspacePath()
  const rows = await this.listAllSessions()
  // Только свой workspace: чужие сессии не показываем и не привязываем.
  return rows
    .filter((row) => typeof row.cwd === 'string' && path.resolve(row.cwd) === path.resolve(workspacePath))
    .filter((row) => row.parentSessionId === undefined && row.origin !== 'subagent')
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .map((row) => ({
      sessionId: row.sessionId,
      cwd: row.cwd,
      title: row.projections?.values?.title ?? this.say(this.state.ownerChatId ?? 0, undefined, 'untitled'),
      running: row.running === true,
      updatedAt: row.updatedAt ?? 0,
      blank: row.blank === true,
    }))
},

async sessionSummary(sessionId) {
  const items = await this.listSessions()
  return items.find((item) => item.sessionId === sessionId)
},

async sendSessionList(chatId, threadId) {
  const items = (await this.listSessions()).slice(0, 8)
  if (items.length === 0) {
    await this.send(chatId, this.say(chatId, threadId, 'sessionsEmpty'), threadId)
    return
  }
  this.sessionButtons.set(this.bindingKey(chatId, threadId), {
    at: Date.now(),
    items: items.map((item) => item.sessionId),
  })
  const keyboard = items.map((item, index) => [{
    text: `${item.running ? '▶ ' : ''}${index + 1}. ${item.title.slice(0, 40)}`,
    callback_data: `use:${index}`,
  }])
  const lines = items.map((item, index) =>
    `${index + 1}. <b>${escapeHtml(item.title)}</b>${item.running ? ` ${this.say(chatId, threadId, 'runningMark')}` : ''}\n<code>${escapeHtml(item.sessionId)}</code>`,
  )
  await this.send(chatId, lines.join('\n\n'), threadId, { inline_keyboard: keyboard })
},

resolveButtonSession(chatId, threadId, index) {
  const stored = this.sessionButtons.get(this.bindingKey(chatId, threadId))
  if (stored === undefined || Date.now() - stored.at > SESSION_BUTTON_TTL_MS) return undefined
  return stored.items[index]
},

async useSession(chatId, threadId, argument) {
  if (argument === '') {
    await this.sendSessionList(chatId, threadId)
    return
  }
  let sessionId = argument
  if (/^\d+$/.test(argument)) {
    const index = Number(argument) - 1
    sessionId = this.resolveButtonSession(chatId, threadId, index) ?? argument
  }
  const summary = await this.sessionSummary(sessionId)
  if (summary === undefined) {
    await this.send(chatId, this.say(chatId, threadId, 'sessionNotFound', { id: escapeHtml(sessionId) }), threadId)
    return
  }
  await this.bind(chatId, threadId, sessionId)
  await this.send(chatId, this.say(chatId, threadId, 'switched', {
    title: escapeHtml(summary.title),
    id: escapeHtml(sessionId),
  }), threadId)
},

/**
 * Снимает привязку чата к сессии.
 *
 * Без аргумента только показывает текущую привязку: снятие по факту вызова
 * было бы сюрпризом. `all` чистит все ключи этого чата, включая топики.
 *
 * @param {number|string} chatId
 * @param {number|undefined} threadId
 * @param {string} argument
 */
async unbindChat(chatId, threadId, argument) {
  const say = (key, params) => this.say(chatId, threadId, key, params)
  const binding = this.bindingFor(chatId, threadId)
  const value = argument.trim()

  if (value === '') {
    if (binding?.sessionId === undefined) {
      await this.send(chatId, say('unboundNone'), threadId)
      return
    }
    const summary = await this.sessionSummary(binding.sessionId)
    await this.send(chatId, say('unboundCurrent', {
      title: escapeHtml(summary?.title ?? binding.sessionId),
      id: escapeHtml(binding.sessionId),
    }), threadId)
    return
  }

  if (value.toLowerCase() === 'all') {
    const prefix = `${chatId}:`
    let removed = 0
    for (const key of Object.keys(this.state.bindings)) {
      if (!key.startsWith(prefix)) continue
      delete this.state.bindings[key]
      removed += 1
    }
    await this.saveState()
    this.log.info(`unbind all: ${removed} ключей чата ${chatId}`)
    await this.send(chatId, say('unboundAll', { count: String(removed) }), threadId)
    return
  }

  const target = value.replace(/^@/, '')
  if (binding?.sessionId !== target) {
    await this.send(chatId, say('unboundMismatch', { id: escapeHtml(target) }), threadId)
    return
  }
  delete this.state.bindings[this.bindingKey(chatId, threadId)]
  await this.saveState()
  this.log.info(`unbind: ${target} из чата ${chatId}`)
  await this.send(chatId, say('unbound', { id: escapeHtml(target) }), threadId)
},

async peekSession(chatId, threadId, argument) {
  let sessionId = argument
  if (/^\d+$/.test(argument)) {
    sessionId = this.resolveButtonSession(chatId, threadId, Number(argument) - 1) ?? argument
  }
  if (sessionId === '') {
    await this.send(chatId, this.say(chatId, threadId, 'peekNeedArg'), threadId)
    return
  }
  const summary = await this.sessionSummary(sessionId)
  if (summary === undefined) {
    await this.send(chatId, this.say(chatId, threadId, 'sessionNotFound', { id: escapeHtml(sessionId) }), threadId)
    return
  }
  const lang = this.langFor(chatId, threadId)
  const locale = lang === 'en' ? 'en-GB' : 'ru-RU'
  const updated = summary.updatedAt
    ? new Date(summary.updatedAt).toLocaleString(locale)
    : this.say(chatId, threadId, 'unknownTime')
  const say = (key, params) => this.say(chatId, threadId, key, params)
  const head = [
    `<b>${escapeHtml(summary.title)}</b>`,
    `<code>${escapeHtml(sessionId)}</code>`,
    say('peekUpdated', {
      time: escapeHtml(updated),
      running: summary.running ? say('yes') : say('no'),
    }),
    summary.blank ? say('peekEmpty') : '',
  ].filter(Boolean).join('\n')

  const tail = await this.historyTail(sessionId, chatId, threadId)
  await this.send(chatId, tail === '' ? head : `${head}\n\n${tail}`, threadId)
},

/** Последние сообщения сессии для /peek: только чтение, без активации агента. */
async historyTail(sessionId, chatId, threadId) {
  const events = this.ctx.sessionController.events
  if (typeof events !== 'function') return ''
  try {
    const page = await events.call(this.ctx.sessionController, {
      address: { kind: 'session', sessionId },
      maxMessages: 6,
    }, this.signal())
    const records = Array.isArray(page?.records) ? page.records : []
    const lines = []
    for (const record of records) {
      if (record?.type !== 'event') continue
      const event = record.event
      const text = extractText(event?.data?.message) || extractText(event?.data)
      if (text === '') continue
      const who = event.type === 'user/message'
        ? this.say(chatId, threadId, 'whoUser')
        : event.type === 'assistant/message' ? this.say(chatId, threadId, 'whoAgent') : undefined
      if (who === undefined) continue
      lines.push(`<b>${who}:</b> ${escapeHtml(text.slice(0, 220))}`)
    }
    return lines.slice(-6).join('\n\n')
  } catch (error) {
    this.ctx.logger.warn('telegram: peek failed: %s', String(error))
    return ''
  }
},

async isWorkspaceSession(sessionId) {
  const now = Date.now()
  if (!this.workspaceCache.ids.has(sessionId) && now - this.workspaceCache.at > 60_000) {
    try {
      const items = await this.listSessions()
      this.workspaceCache = { ids: new Set(items.map((item) => item.sessionId)), at: now }
    } catch {
      this.workspaceCache.at = now
    }
  }
  return this.workspaceCache.ids.has(sessionId)
}

/** Включены ли уведомления в этом чате. */
/** Чат замьючен: ответы и карточки не идут, вопросы и подтверждения — идут. */
}
