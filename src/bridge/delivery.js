/**
 * delivery: часть TelegramBridge, подключается миксином к прототипу.
 */
import { NOTIFY_MODES } from '../config.js'
import { callWithRetry } from '../tg/client.js'
import { downgradeHeadings, escapeHtml, hardLineBreaks, markdownToHtml, normalizeBlocks, splitHtml, tablesToList } from '../tg/html.js'
import { RichUnsupportedError, sendRichMessage } from '../tg/rich.js'
import { createCardStreamer } from '../tg/stream.js'
import { formatTokens } from './kernel.js'
import { extractText, MAX_TEXT } from './kernel.js'

export const delivery = {
async send(chatId, html, threadId, replyMarkup) {
  const token = await this.token()
  if (token === undefined) return undefined
  for (const [index, part] of splitHtml(html, MAX_TEXT).entries()) {
    try {
      await callWithRetry(token, 'sendMessage', {
        chat_id: chatId,
        text: part,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...(index === 0 && replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      }, { baseUrl: this.apiBase() })
    } catch (error) {
      this.ctx.logger.warn('telegram: send failed: %s', String(error))
      this.log.error(`send ${chatId}: ${String(error)}`)
      return undefined
    }
  }
  return true
},

/**
 * Пробует отправить финал rich-сообщением (markdown с таблицами).
 *
 * Между блоками ставится пустая строка — до того, как заголовки превратились
 * в жирную строку: иначе граница блока теряется.
 *
 * @returns {Promise<boolean>} true — отправлено; false — нужен HTML-фолбэк.
 */
async sendRichFinal(chatId, threadId, markdown) {
  if (!this.cfg().richMessages || this.richSupported === false) return false
  const token = await this.token()
  if (token === undefined) return false
  try {
    const cfg = this.cfg()
    let body = normalizeBlocks(markdown)
    // Нативных таблиц нет или они выключены — отдаём списком, а не код-блоком.
    if (!cfg.richTables) body = tablesToList(body)
    if (!cfg.richHeadings) body = downgradeHeadings(body)
    body = hardLineBreaks(body)
    await sendRichMessage(token, {
      chatId,
      threadId,
      markdown: body,
      baseUrl: this.apiBase(),
    })
    this.richSupported = true
    this.log.info(`rich final → ${chatId}: ${markdown.length} символов`)
    return true
  } catch (error) {
    if (error instanceof RichUnsupportedError) {
      this.richSupported = false
      this.log.warn('rich messages не поддерживаются сервером — перехожу на HTML')
      return false
    }
    if (error?.status === 400) {
      this.log.warn(`rich отклонил разметку: ${String(error.body?.description ?? error)}`)
      return false
    }
    this.log.error(`rich send failed: ${String(error)}`)
    return false
  }
},

/** Финальная доставка ответа: rich с таблицами, иначе обычный HTML. */
async deliverAnswer(chat, text, header) {
  if (this.muted(chat.chatId, chat.threadId)) {
    this.log.info(`mute: финал в ${chat.chatId} не отправлен`)
    return
  }
  const markdown = header === undefined ? text : `${header}\n\n${text}`
  if (text !== '' && await this.sendRichFinal(chat.chatId, chat.threadId, markdown)) return
  const html = header === undefined
    ? markdownToHtml(text)
    : `<b>${escapeHtml(header)}</b>${text === '' ? '' : `\n\n${markdownToHtml(text)}`}`
  await this.send(chat.chatId, html, chat.threadId)
},

async typing(chatId, threadId) {
  const token = await this.token()
  if (token === undefined) return
  await callWithRetry(token, 'sendChatAction', {
    chat_id: chatId,
    action: 'typing',
    ...(threadId ? { message_thread_id: threadId } : {}),
  }, { baseUrl: this.apiBase() }).catch(() => {})
},

async statusText(chatId, threadId) {
  const cfg = this.cfg()
  const say = (key, params) => this.say(chatId, threadId, key, params)
  const binding = this.bindingFor(chatId, threadId)
  const lines = [say('status', {
    bot: this.botName ? `@${escapeHtml(this.botName)}` : '—',
    workspace: escapeHtml(await this.workspacePath()),
    notify: this.notifyEnabled(chatId, threadId) ? say('on') : say('off'),
    mute: this.muted(chatId, threadId) ? say('yes') : say('no'),
    mode: cfg.notifyMode,
    allow: cfg.allowNewSessions ? say('yes') : say('no'),
  })]
  if (binding?.sessionId !== undefined) {
    const summary = await this.sessionSummary(binding.sessionId)
    lines.push(say('statusSession', {
      title: escapeHtml(summary?.title ?? binding.sessionId),
      running: summary?.running === true ? say('yes') : say('no'),
    }))
  } else {
    lines.push(say('statusNoSession'))
  }
  const model = this.state.model?.[binding?.sessionId]
  if (model !== undefined) {
    lines.push(say('statusModel', { model: escapeHtml(`${model.provider}/${model.model}`) }))
  }
  const { session } = this.usageOf(binding?.sessionId)
  if (session.input + session.output > 0) {
    lines.push(say('statusTokens', {
      input: formatTokens(session.input),
      output: formatTokens(session.output),
    }))
  }
  return lines.join('\n')
},

mainKeyboard(chatId, threadId) {
  return {
    inline_keyboard: [
      [
        { text: this.say(chatId, threadId, 'buttonSessions'), callback_data: 'list' },
        { text: this.say(chatId, threadId, 'buttonNew'), callback_data: 'new' },
      ],
      [
        { text: this.say(chatId, threadId, 'buttonStatus'), callback_data: 'status' },
        { text: this.say(chatId, threadId, 'buttonNotify'), callback_data: 'notify' },
      ],
    ],
  }
},

nextQuietMode() {
  const modes = NOTIFY_MODES
  const current = this.cfg().notifyMode
  return modes[(modes.indexOf(current) + 1) % modes.length]
},

async onAssistantStream(agent, frame) {
  if (this.disposed) return
  const sessionId = agent?.id
  if (sessionId === undefined) return

  // Токены считаем всегда, даже если чат не привязан: /cost должен знать расход.
  if (frame.type === 'chunk' && frame.chunk?.type === 'usage') {
    this.addUsage(sessionId, frame.chunk.usage)
    return
  }

  const chat = this.boundChat(sessionId)
  if (chat === undefined) return
  // Карточку прогресса показываем только там, где ждут: ответ на свою задачу
  // или чат с включёнными уведомлениями.
  if (this.muted(chat.chatId, chat.threadId)) return
  const fromBot = this.botTurns.has(sessionId)
  if (!fromBot && !this.notifyEnabled(chat.chatId, chat.threadId)) return

  if (frame.type === 'start') {
    this.startTypingPulse(sessionId, chat.chatId, chat.threadId)
    if (this.turns.has(sessionId)) return
    const turn = { text: '', chatId: chat.chatId, threadId: chat.threadId, streamer: undefined }
    this.turns.set(sessionId, turn)
    if (!this.cfg().streaming) return
    const token = await this.token()
    if (token === undefined || this.turns.get(sessionId) !== turn) return
    turn.streamer = createCardStreamer({
      token,
      baseUrl: this.apiBase(),
      chatId: chat.chatId,
      messageThreadId: chat.threadId,
    })
    if (turn.text !== '') turn.streamer.append(turn.text)
    return
  }

  const turn = this.turns.get(sessionId)
  if (turn === undefined) return

  if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
    const delta = frame.chunk.text ?? ''
    turn.text += delta
    turn.streamer?.append(delta)
    return
  }

  if (frame.type === 'end' && frame.outcome?.kind === 'abandoned') {
    await turn.streamer?.discard?.()
    this.turns.delete(sessionId)
  }
},

async onSessionEvent(session, event) {
  if (this.disposed) return
  const sessionId = session?.id
  if (sessionId === undefined) return

  // Durable-текст пишем синхронно и до await: turn/end может прийти сразу следом.
  if (event.type === 'assistant/message') {
    const text = extractText(event.data?.message)
    if (text !== '') this.rememberAssistant(sessionId, event.data?.turn, text)
    return
  }

  const bound = this.boundChat(sessionId)

  if (event.type === 'tool/call') {
    if (bound === undefined) return
    if (!this.notifyEnabled(bound.chatId, bound.threadId)) return
    const toolName = event.data?.name
    if (toolName !== undefined) {
      this.turns.get(sessionId)?.streamer?.setStatus(
        this.say(bound.chatId, bound.threadId, 'statusToolNamed', { tool: escapeHtml(String(toolName)) }),
      )
    }
    if (this.cfg().notifyMode === 'verbose') {
      const name = event.data?.name ?? 'tool'
      await this.typing(bound.chatId, bound.threadId)
      await this.send(bound.chatId, this.say(bound.chatId, bound.threadId, 'statusToolNamed', {
        tool: escapeHtml(String(name)),
      }), bound.threadId)
    }
    return
  }

  if (event.type !== 'turn/end') return

  const reason = event.data?.reason ?? { kind: 'completed' }
  const turn = this.turns.get(sessionId)
  this.turns.delete(sessionId)
  this.stopTypingPulse(sessionId)
  this.log.info(`turn/end ${sessionId}: ${reason.kind}`)

  const fromBot = this.botTurns.has(sessionId)
  this.botTurns.delete(sessionId)
  const remembered = this.lastAssistant.get(sessionId)
  this.lastAssistant.delete(sessionId)
  const text = (remembered?.text ?? turn?.text ?? '').trim()
  const mode = this.cfg().notifyMode

  /** Текст уходит в ответ на задачу из чата либо в чаты с уведомлениями. */
  const deliver = async (markdown, header) => {
    if (fromBot && bound !== undefined) {
      await this.deliverAnswer(bound, markdown, header)
      return
    }
    if (bound === undefined && !(await this.isWorkspaceSession(sessionId))) return
    if (mode === 'off') return
    for (const target of this.notificationTargets()) {
      await this.deliverAnswer(target, markdown, header)
    }
  }

  if (reason.kind === 'error') {
    await turn?.streamer?.discard?.()
    const message = reason.error?.message ?? reason.error?.code ?? 'error'
    await deliver(this.say(bound?.chatId ?? this.notificationTargets()[0]?.chatId ?? 0, bound?.threadId, 'errorPrefix', { error: message }))
    return
  }

  if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
    await turn?.streamer?.discard?.()
    if (fromBot) await deliver(this.say(bound?.chatId ?? this.notificationTargets()[0]?.chatId ?? 0, bound?.threadId, 'aborted'))
    return
  }

  if (reason.kind === 'blocked') {
    await turn?.streamer?.discard?.()
    await deliver(this.say(bound?.chatId ?? this.notificationTargets()[0]?.chatId ?? 0, bound?.threadId, 'blocked'))
    return
  }

  if (fromBot && bound !== undefined) {
    if (turn?.streamer !== undefined) {
      const rich = text !== '' && await this.sendRichFinal(bound.chatId, bound.threadId, text)
      if (rich) {
        await turn.streamer.discard()
        this.log.info(`final ${sessionId}: rich, ${text.length} символов`)
        return
      }
      try {
        await turn.streamer.finish(text)
        this.log.info(`final ${sessionId}: ${text.length} символов, карточка закрыта`)
      } catch (error) {
        this.log.error(`final ${sessionId}: ${String(error)}`)
        if (text !== '') await this.send(bound.chatId, markdownToHtml(text), bound.threadId)
      }
      return
    }
    if (text === '') {
      await this.send(bound.chatId, this.say(bound.chatId, bound.threadId, 'emptyTurn'), bound.threadId)
    } else {
      await this.deliverAnswer(bound, text)
    }
    return
  }

  if (bound === undefined && !(await this.isWorkspaceSession(sessionId))) return
  if (mode === 'off' || mode === 'quiet') return
  const summary = await this.sessionSummary(sessionId)
  const langChat = bound?.chatId ?? this.notificationTargets()[0]?.chatId ?? 0
  const header = summary?.title
    ? this.say(langChat, bound?.threadId, 'doneTitle', { title: summary.title })
    : this.say(langChat, bound?.threadId, 'done')
  for (const target of this.notificationTargets()) {
    await this.deliverAnswer(target, text, header)
  }
}
}
