/**
 * commands: часть TelegramBridge, подключается миксином к прототипу.
 */
import { NOTIFY_MODES } from '../config.js'
import { botCommands, languageFromTelegram, normalizeLanguage, translate } from '../i18n.js'
import { callWithRetry } from '../tg/client.js'
import { sendDocument } from '../tg/files.js'
import { escapeHtml } from '../tg/html.js'
import { webhookInfo } from '../tg/poll.js'
import path from 'node:path'
import { MAX_TEXT } from './kernel.js'

export const commands = {
async handleMessage(message, updateId, token) {
  const chatId = message.chat?.id
  const fromId = message.from?.id
  if (chatId === undefined || fromId === undefined) return
  if (message.from?.is_bot === true) return

  const owner = this.ownerId()
  if (owner === 0) {
    // Fail-closed: бот без настроенного владельца не привязывает первого встречного.
    this.log.warn(`ownerId не задан; сообщение от ${fromId} в чате ${chatId} отклонено`)
    if (message.chat?.type !== 'private') return
    await this.send(
      chatId,
      this.say(chatId, message.message_thread_id, 'ownerMissing'),
      message.message_thread_id,
    )
    return
  }
  // /pair доступен и незнакомцу: в этом его смысл, код проверяет сам обработчик.
  const pairing = /^\/pair(@\w+)?(\s|$)/i.test(String(message.text ?? '').trim())
  if (!pairing && !this.isAllowed(fromId, owner)) {
    this.log.warn(`чужой from=${fromId} — игнор (владелец ${owner}, allowlist ${this.cfg().allowedUsers.length})`)
    return
  }
  // Группы и каналы не годятся ни для привязки владельца, ни для уведомлений:
  // их видят посторонние.
  if (message.chat?.type !== 'private') {
    this.log.warn(`чат ${chatId} типа ${message.chat?.type ?? '?'} — только приватный`)
    return
  }

  const threadId = message.message_thread_id

  // Определённый язык клиента — отдельно от явного выбора /lang: иначе он
  // навсегда перекрывает настройку панели, как было до langVersion 2.
  // Записываем до публикации меню: chat-scope ниже выбирает язык через langFor.
  const langKey = this.bindingKey(chatId, threadId)
  const detected = languageFromTelegram(message.from?.language_code)
  if (this.state.langDetected?.[langKey] !== detected) {
    this.state.langDetected = { ...(this.state.langDetected ?? {}), [langKey]: detected }
    await this.saveState()
  }

  // ownerChatId — адрес инициативных сообщений агента; менять его может только владелец.
  if (fromId === this.ownerId() && this.state.ownerChatId !== chatId) {
    this.state.ownerChatId = chatId
    await this.saveState()
    const token = await this.token()
    if (token !== undefined) await this.publishCommandsForChat(token, chatId)
  }

  // Ответ на вопрос агента: текст, написанный вместо кнопки.
  const answerText = String(message.text ?? '').trim()
  if (answerText !== '' && !answerText.startsWith('/')) {
    const pending = this.pendingQuestionFor(chatId, threadId)
    if (pending !== undefined && this.answerQuestionByText(pending, answerText)) {
      await this.send(chatId, this.say(chatId, threadId, 'questionAccepted'), threadId)
      return
    }
  }
  const incoming = await this.readIncomingMedia(message, chatId, threadId)
  if (incoming === undefined) return
  const text = incoming.text
  // Тексты задач в логе — утечка: по умолчанию пишем только длину.
  const preview = this.cfg().logMessages ? ` text=${JSON.stringify(text.slice(0, 120))}` : ` len=${text.length}`
  this.log.info(`message chat=${chatId} from=${fromId}${preview} parts=${incoming.parts.length}`)
  if (text === '' && incoming.parts.length === 0) {
    await this.send(chatId, this.say(chatId, threadId, 'textOnly'), threadId)
    return
  }

  if (text.startsWith('/')) {
    await this.handleCommand(text, { chatId, threadId, message, fromId, token })
    return
  }

  await this.forwardTask(chatId, threadId, text, updateId, incoming.parts)
},

async handleCommand(text, { chatId, threadId, message, fromId, token }) {
  // Аргументы не логируем: там бывает код подключения и текст задачи.
  this.log.info(`command ${text.split(/\s+/)[0].slice(0, 32)}`)
  const [rawCommand, ...rest] = text.split(/\s+/)
  const command = rawCommand.slice(1).split('@')[0].toLowerCase()
  const argument = rest.join(' ').trim()

  switch (command) {
    case 'start':
      await this.send(chatId, this.say(chatId, threadId, 'start'), threadId, this.mainKeyboard(chatId, threadId))
      return
    case 'help':
      await this.send(chatId, this.say(chatId, threadId, 'help'), threadId, this.mainKeyboard(chatId, threadId))
      return
    case 'status':
      await this.send(chatId, await this.statusText(chatId, threadId), threadId)
      return
    case 'new':
      await this.createAndBind(chatId, threadId, argument)
      return
    case 'sessions':
      await this.sendSessionList(chatId, threadId)
      return
    case 'use':
      if (fromId !== this.ownerId() && argument !== '') {
        await this.send(chatId, this.say(chatId, threadId, 'ownerOnlySwitch'), threadId)
        return
      }
      await this.useSession(chatId, threadId, argument)
      return
    case 'pair': {
      const code = argument.trim()
      const configured = this.cfg().pairingCode
      const say = (key, params) => this.say(chatId, threadId, key, params)
      if (configured === '') {
        await this.send(chatId, say('pairDisabled'), threadId)
        return
      }
      if (fromId !== this.ownerId() && this.cfg().allowedUsers.includes(fromId)) {
        await this.send(chatId, say('pairAlready'), threadId)
        return
      }
      if (code !== configured) {
        // Код не пишем в лог: он равен паролю на вход.
        this.log.warn(`pair: неверный код от ${fromId}`)
        await this.send(chatId, say('pairWrong'), threadId)
        return
      }
      const users = this.cfg().allowedUsers
      if (!users.includes(fromId)) {
        const saved = await this.persistConfig({ allowedUsers: [...users, fromId].join(',') })
        if (!saved) {
          await this.send(chatId, say('pairFailed'), threadId)
          return
        }
      }
      this.log.info(`pair: подключён ${fromId}`)
      await this.send(chatId, say('paired'), threadId)
      return
    }
    case 'steer': {
      const text = argument.trim()
      const binding = this.bindingFor(chatId, threadId)
      if (binding?.sessionId === undefined) {
        await this.send(chatId, this.say(chatId, threadId, 'steerNoSession'), threadId)
        return
      }
      if (text === '') {
        await this.send(chatId, this.say(chatId, threadId, 'steerUsage'), threadId)
        return
      }
      try {
        await this.promptWithTimeout(
          binding.sessionId,
          `tg-steer-${Date.now()}`,
          text,
        )
        this.log.info(`steer → ${binding.sessionId}: ${text.slice(0, 60)}`)
        await this.send(chatId, this.say(chatId, threadId, 'steerSent'), threadId)
      } catch (error) {
        this.log.warn(`steer failed: ${String(error)}`)
        await this.send(chatId, this.say(chatId, threadId, 'steerFailed', {
          error: escapeHtml(String(error?.message ?? error)),
        }), threadId)
      }
      return
    }
    case 'mute':
    case 'unmute': {
      const key = this.bindingKey(chatId, threadId)
      const muted = command === 'mute'
      this.state.mute = this.state.mute ?? {}
      this.state.mute[key] = muted
      await this.saveState()
      this.log.info(`mute ${key} = ${muted}`)
      await this.send(chatId, this.say(chatId, threadId, muted ? 'mutedOn' : 'mutedOff'), threadId)
      return
    }
    case 'unbind':
      await this.unbindChat(chatId, threadId, argument)
      return
    case 'peek':
      if (fromId !== this.ownerId()) {
        await this.send(chatId, this.say(chatId, threadId, 'ownerOnlyPeek'), threadId)
        return
      }
      await this.peekSession(chatId, threadId, argument)
      return
    case 'stop':
      await this.stopSession(chatId, threadId)
      return
    case 'notify': {
      const key = this.bindingKey(chatId, threadId)
      const mode = argument.toLowerCase()
      const next = mode === 'on' ? true : mode === 'off' ? false : this.state.notify[key] !== true
      this.state.notify[key] = next
      await this.saveState()
      this.log.info(`notify ${key} = ${next}`)
      await this.send(chatId, this.say(chatId, threadId, next ? 'notifyOn' : 'notifyOff'), threadId)
      return
    }
    case 'model':
      await this.modelPicker(chatId, threadId, argument)
      return
    case 'cost':
      await this.send(chatId, await this.costText(chatId, threadId), threadId)
      return
    case 'doctor': {
      const cfg = this.cfg()
      const info = await webhookInfo(token, { baseUrl: this.apiBase() }).catch(() => undefined)
      const age = this.state.diagnostics?.lastUpdateAt
        ? Math.round((Date.now() - this.state.diagnostics.lastUpdateAt) / 1000)
        : undefined
      const lines = [
        this.say(chatId, threadId, 'doctorTitle'),
        `bot: @${this.botName ?? '?'}`,
        `webhook: ${info?.url ? 'set' : 'none'}`,
        `owner: ${this.ownerId()}`,
        `allowlist: ${cfg.allowedUsers.length}`,
        `workspace: ${await this.workspacePath()}`,
        `poll: ${cfg.enabled ? 'on' : 'off'} · offset: ${this.state.offset ?? '—'}`,
        `last update: ${age === undefined ? '—' : `${age}s ago`}`,
        `rich: ${cfg.richMessages ? 'on' : 'off'} · tables: ${cfg.richTables ? 'on' : 'off'}`,
        `log: ${this.log.file}`,
      ]
      await this.send(chatId, `<pre>${escapeHtml(lines.join('\n'))}</pre>`, threadId)
      return
    }
    case 'lang': {
      const selected = normalizeLanguage(argument.toLowerCase())
        ?? (this.langFor(chatId, threadId) === 'ru' ? 'en' : 'ru')
      this.state.lang = { ...(this.state.lang ?? {}), [this.bindingKey(chatId, threadId)]: selected }
      await this.saveState()
      // chat-scope меню иначе останется на прежнем языке: у Telegram он важнее language-scope.
      if (token !== undefined) await this.publishCommandsForChat(token, chatId)
      await this.send(chatId, translate(selected, 'langSet', { lang: selected }), threadId)
      return
    }
    case 'log': {
      // Лог может содержать тексты задач и id: показываем только владельцу.
      if (fromId !== this.ownerId()) {
        await this.send(chatId, this.say(chatId, threadId, 'logOwnerOnly'), threadId)
        return
      }
      const count = Math.min(Math.max(Number(argument) || 25, 1), 80)
      const tail = this.log.tail(count)
      await this.send(chatId, tail === ''
        ? this.say(chatId, threadId, 'logEmpty')
        : `<pre>${escapeHtml(tail.length > MAX_TEXT ? tail.slice(-MAX_TEXT) : tail)}</pre>`, threadId)
      return
    }
    case 'quiet': {
      const mode = NOTIFY_MODES.includes(argument) ? argument : this.nextQuietMode()
      const saved = await this.persistConfig({ notifyMode: mode })
      await this.send(chatId, this.say(chatId, threadId, saved ? 'quietSet' : 'quietFailed', {
        mode: saved ? mode : this.cfg().notifyMode,
      }), threadId)
      return
    }
    default:
      if (message !== undefined) {
        await this.send(chatId, this.say(chatId, threadId, 'unknownCommand'), threadId)
      }
  }
},

async handleCallback(callback, token) {
  const data = callback.data ?? ''
  const chatId = callback.message?.chat?.id
  const threadId = callback.message?.message_thread_id
  if (chatId === undefined) return
  await callWithRetry(token, 'answerCallbackQuery', {
    callback_query_id: callback.id,
  }, { baseUrl: this.apiBase() }).catch(() => {})

  // Кнопки нажимает тот, кто работает с ботом: владелец или участник allowlist.
  if (!this.isAllowed(callback.from?.id)) return
  if (data === 'new') {
    await this.createAndBind(chatId, threadId, '')
    return
  }
  if (data === 'list') {
    await this.sendSessionList(chatId, threadId)
    return
  }
  if (data === 'status') {
    await this.send(chatId, await this.statusText(chatId, threadId), threadId)
    return
  }
  if (data.startsWith('ap:')) {
    const [, id, decision] = data.split(':')
    const pending = this.pendingApprovals.get(id)
    if (pending === undefined) {
      await this.send(chatId, this.say(chatId, threadId, 'approvalExpired'), threadId)
      return
    }
    const outcome = decision === 'y' ? 'allowed-once' : 'rejected'
    pending.resolve(outcome)
    this.log.info(`approval ${id}: ${outcome}`)
    await this.send(chatId, this.say(chatId, threadId, decision === 'y' ? 'approvalAllowed' : 'approvalRejected'), threadId)
    return
  }
  if (data.startsWith('md:')) {
    await this.selectModelByIndex(chatId, threadId, Number(data.slice(3)))
    return
  }
  if (data.startsWith('qq:')) {
    const [, id, index, option] = data.split(':')
    const pending = this.pendingQuestions.get(id)
    if (pending === undefined) {
      await this.send(chatId, this.say(chatId, threadId, 'questionExpired'), threadId)
      return
    }
    await this.answerQuestionByButton(pending, Number(index), Number(option))
    return
  }
  if (data.startsWith('qd:')) {
    const [, id, index] = data.split(':')
    const pending = this.pendingQuestions.get(id)
    if (pending === undefined) return
    const question = pending.questions[Number(index)]
    if (question === undefined) return
    const answer = pending.answers.get(String(question.id))
    if (answer === undefined || answer.selected.length === 0) {
      await this.send(chatId, this.say(chatId, threadId, 'questionEmpty'), threadId)
      return
    }
    if (this.openQuestions(pending).length === 0) this.finishQuestions(pending)
    return
  }
  if (data === 'notify') {
    const key = this.bindingKey(chatId, threadId)
    this.state.notify[key] = this.state.notify[key] !== true
    this.log.info(`notify ${key} = ${this.state.notify[key]} (кнопка)`)
    await this.saveState()
    await this.send(
      chatId,
      this.say(chatId, threadId, this.state.notify[key] ? 'notifyOnShort' : 'notifyOffShort'),
      threadId,
    )
    return
  }
  if (data.startsWith('use:')) {
    const sessionId = this.resolveButtonSession(chatId, threadId, Number(data.slice(4)))
    if (sessionId !== undefined) await this.useSession(chatId, threadId, sessionId)
  }
},

/**
 * Публикует меню команд.
 *
 * Telegram хранит список на сервере: default-scope видят все, language_code-scope —
 * только носители языка. Старый бот мог оставить свой список в default scope
 * (так было с Hermes), поэтому сначала перезаписываем default нашими командами,
 * затем добавляем английский скоуп и чистим русский, если он остался с прошлого раза.
 */
async publishCommands(token) {
  const call = (params) => callWithRetry(token, 'setMyCommands', params, {
    attempts: 2,
    baseUrl: this.apiBase(),
  })
  try {
    await call({ commands: botCommands('ru') })
    await call({ commands: botCommands('en'), language_code: 'en' })
    await callWithRetry(token, 'deleteMyCommands', { language_code: 'ru' }, {
      attempts: 2,
      baseUrl: this.apiBase(),
    })
    // Chat-scope приоритетнее default: обновляем его при каждом старте, иначе
    // в старых чатах висит прошлый список без новых команд.
    const chats = new Set([...Object.keys(this.state.bindings ?? {}).map((key) => Number(key.split(':')[0]))])
    if (this.state.ownerChatId !== undefined) chats.add(Number(this.state.ownerChatId))
    for (const chatId of chats) {
      if (Number.isInteger(chatId) && chatId > 0) await this.publishCommandsForChat(token, chatId)
    }
    this.log.info(`menu: команды опубликованы (default + en, чатов ${chats.size})`)
  } catch (error) {
    this.log.warn(`setMyCommands: ${String(error)}`)
  }
},

/**
 * Команды для конкретного чата: у chat-scope приоритет выше default,
 * поэтому меню не зависит от того, что бот ставил раньше и что закэшировал клиент.
 */
async publishCommandsForChat(token, chatId) {
  try {
    // Chat-scope приоритетнее language-scope: список должен быть на языке чата,
    // иначе английский набор из default scope в этом чате никогда не покажется.
    await callWithRetry(token, 'setMyCommands', {
      commands: botCommands(this.langFor(chatId)),
      scope: { type: 'chat', chat_id: chatId },
    }, { attempts: 2, baseUrl: this.apiBase() })
  } catch (error) {
    this.log.warn(`setMyCommands(chat ${chatId}): ${String(error)}`)
  }
},

/**
 * Отправка по просьбе агента (инструмент telegram_send).
 * @param {string} [text]
 * @param {string} [file] абсолютный путь
 */
async sendToOwner(text, file) {
  const target = this.ownerTarget()
  if (target === undefined) throw new Error('нет привязанного чата: сначала /start')
  const token = await this.token()
  if (token === undefined) throw new Error('токен не настроен')
  const sent = []
  if (typeof text === 'string' && text.trim() !== '') {
    await this.deliverAnswer(target, text.trim())
    sent.push('text')
  }
  if (typeof file === 'string' && file !== '') {
    const message = await sendDocument(token, {
      chatId: target.chatId,
      threadId: target.threadId,
      path: file,
      baseUrl: this.apiBase(),
    })
    this.log.info(`tool telegram_send: файл ${file} → ${target.chatId}`)
    sent.push(`file:${message?.message_id ?? '?'}`)
  }
  if (sent.length === 0) throw new Error('нужен text или file')
  return { ok: true, sent }
},

ownerTarget() {
  if (this.state.ownerChatId !== undefined) return { chatId: this.state.ownerChatId, threadId: undefined }
  const target = this.notificationTargets()[0]
  return target === undefined ? undefined : { chatId: target.chatId, threadId: target.threadId }
}

}
