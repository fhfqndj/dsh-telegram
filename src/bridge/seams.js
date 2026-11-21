/**
 * seams: часть TelegramBridge, подключается миксином к прототипу.
 */
import { callWithRetry } from '../tg/client.js'
import { escapeHtml } from '../tg/html.js'
import { SAFE_TOOLS, matchesTool } from './kernel.js'

export const seams = {
async onApprovalRequest(request, next) {
  const cfg = this.cfg()
  const sessionId = request?.agent?.id
  if (!cfg.approvals || sessionId === undefined) return next()
  const chat = this.boundChat(sessionId)
  if (chat === undefined) return next()

  const tool = String(request.toolName ?? request.tool ?? 'tool')

  // Политика: сначала запреты, потом авторазрешение, только затем вопрос.
  const decision = this.decideApproval(tool, cfg)
  if (decision !== undefined) {
    this.log.info(`approval ${tool}: ${decision} (политика ${cfg.approvalsPosture})`)
    if (decision === 'rejected') {
      await this.send(
        chat.chatId,
        this.say(chat.chatId, chat.threadId, 'approvalDenied', { tool: escapeHtml(tool) }),
        chat.threadId,
      )
    }
    return decision
  }

  const id = (this.approvalSeq += 1).toString(36)
  const reason = request.displayReason ?? request.reason ?? ''
  const text = this.say(chat.chatId, chat.threadId, 'approvalTitle', {
    tool: escapeHtml(tool),
    reason: reason === '' ? '' : `\n${escapeHtml(String(reason))}`,
  })

  this.turns.get(sessionId)?.streamer?.setStatus(
    this.say(chat.chatId, chat.threadId, 'statusWaitingApproval'),
  )
  const sent = await this.send(chat.chatId, text, chat.threadId, {
    inline_keyboard: [[
      { text: this.say(chat.chatId, chat.threadId, 'approveYes'), callback_data: `ap:${id}:y` },
      { text: this.say(chat.chatId, chat.threadId, 'approveNo'), callback_data: `ap:${id}:n` },
    ]],
  })
  if (sent === undefined) return next()

  this.log.info(`approval ${id}: ${tool} в ${sessionId}`)
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      this.pendingApprovals.delete(id)
      this.log.warn(`approval ${id}: таймаут → отказ`)
      resolve('rejected')
    }, 5 * 60_000)
    const onAbort = () => {
      clearTimeout(timeout)
      this.pendingApprovals.delete(id)
      resolve('cancelled')
    }
    if (request.signal?.aborted) { onAbort(); return }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    this.pendingApprovals.set(id, {
      resolve: (outcome) => {
        clearTimeout(timeout)
        request.signal?.removeEventListener('abort', onAbort)
        this.pendingApprovals.delete(id)
        resolve(outcome)
      },
      chatId: chat.chatId,
      threadId: chat.threadId,
    })
  })
}


/**
 * Вопрос агента из Telegram: карточка с кнопками вариантов и свободный ответ.
 * Возвращает { answers } для seam `user-questions/request`; без привязанного
 * чата уступает следующему ответчику (Web UI).
 */,

decideApproval(tool, cfg) {
  const name = String(tool).toLowerCase()
  if (cfg.approvalsDeny.some((pattern) => matchesTool(name, pattern))) return 'rejected'
  if (cfg.approvalsAllow.some((pattern) => matchesTool(name, pattern))) return 'allowed-once'
  if (cfg.approvalsPosture === 'yolo') return 'allowed-once'
  if (cfg.approvalsPosture === 'trusted' && SAFE_TOOLS.has(name)) return 'allowed-once'
  return undefined
},

/**
 * Копит расход токенов по сессии.
 * @param {string} sessionId
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number,
 *   cacheWriteTokens?: number, reasoningTokens?: number}} usage
 */
async onQuestionRequest(request, next) {
  const cfg = this.cfg()
  const sessionId = request?.agent?.id
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (!cfg.questions || sessionId === undefined || questions.length === 0) return next()
  const chat = this.boundChat(sessionId)
  if (chat === undefined) return next()
  const token = await this.token()
  if (token === undefined) return next()

  const id = (this.questionSeq += 1).toString(36)
  const pending = {
    id,
    chatId: chat.chatId,
    threadId: chat.threadId,
    questions,
    answers: new Map(),
    resolve: undefined,
  }

  // Каждый вопрос — отдельной карточкой: длинный список кнопок Telegram режет.
  for (let index = 0; index < questions.length; index += 1) {
    await this.sendQuestionCard(pending, index)
  }
  this.log.info(`question ${id}: ${questions.length} шт. в ${chat.chatId}`)

  return await new Promise((resolve) => {
    const settle = (answers) => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      this.pendingQuestions.delete(id)
      resolve({ answers })
    }
    const skipAll = () => questions.map((question) => ({ id: String(question.id), selected: [] }))
    const timer = setTimeout(() => {
      this.log.warn(`question ${id}: таймаут → пропуск`)
      if (this.pendingQuestions.has(id)) settle(skipAll())
    }, 10 * 60_000)
    const onAbort = () => {
      if (this.pendingQuestions.has(id)) settle(skipAll())
    }
    if (request.signal?.aborted === true) { onAbort(); return }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    pending.resolve = (answers) => settle(answers)
    this.pendingQuestions.set(id, pending)
  })
},

async sendQuestionCard(pending, index) {
  const token = await this.token()
  if (token === undefined) return
  const question = pending.questions[index]
  const text = this.say(pending.chatId, pending.threadId, 'questionCard', {
    header: question.header === undefined ? '' : `<b>${escapeHtml(String(question.header))}</b>\n`,
    question: escapeHtml(String(question.question)),
    hint: this.say(pending.chatId, pending.threadId, 'questionHint'),
  })
  const options = Array.isArray(question.options) ? question.options : []
  const keyboard = []
  for (let option = 0; option < options.length; option += 1) {
    const label = String(options[option].label ?? '')
    keyboard.push([{
      text: label.length > 40 ? `${label.slice(0, 39)}…` : label,
      callback_data: `qq:${pending.id}:${index}:${option}`,
    }])
  }
  await callWithRetry(token, 'sendMessage', {
    chat_id: pending.chatId,
    ...(pending.threadId ? { message_thread_id: pending.threadId } : {}),
    text,
    parse_mode: 'HTML',
    ...(keyboard.length === 0 ? {} : { reply_markup: { inline_keyboard: keyboard } }),
  }, { baseUrl: this.apiBase() }).catch((error) => {
    this.log.warn(`question ${pending.id}: карточка не ушла — ${String(error)}`)
  })
},

/** Сколько вопросов ещё без ответа. */
openQuestions(pending) {
  return pending.questions.filter((question) => !pending.answers.has(String(question.id)))
},

finishQuestions(pending) {
  const answers = pending.questions.map((question) => {
    const answer = pending.answers.get(String(question.id))
    return {
      id: String(question.id),
      selected: answer?.selected ?? [],
      ...(answer?.custom === undefined ? {} : { custom: answer.custom }),
    }
  })
  this.log.info(`question ${pending.id}: отвечен`)
  pending.resolve?.(answers)
},

async answerQuestionByButton(pending, index, option) {
  const question = pending.questions[index]
  if (question === undefined) return
  const options = Array.isArray(question.options) ? question.options : []
  const label = options[option]?.label
  if (label === undefined) return
  const key = String(question.id)
  const current = pending.answers.get(key) ?? { selected: [] }

  if (question.multiSelect === true) {
    const selected = current.selected.includes(label)
      ? current.selected.filter((item) => item !== label)
      : [...current.selected, label]
    pending.answers.set(key, { selected })
    const text = this.say(pending.chatId, pending.threadId, 'questionChosen', {
      question: escapeHtml(String(question.question)),
      value: escapeHtml(selected.length === 0 ? '—' : selected.join(', ')),
    })
    await this.send(pending.chatId, text, pending.threadId, {
      inline_keyboard: [[
        { text: this.say(pending.chatId, pending.threadId, 'questionDone'), callback_data: `qd:${pending.id}:${index}` },
      ]],
    })
    return
  }

  pending.answers.set(key, { selected: [label] })
  this.log.info(`question ${pending.id}: выбран «${label}»`)
  if (this.openQuestions(pending).length === 0) this.finishQuestions(pending)
},

answerQuestionByText(pending, text) {
  const open = this.openQuestions(pending)[0]
  if (open === undefined) return false
  pending.answers.set(String(open.id), { selected: [], custom: text })
  this.log.info(`question ${pending.id}: свободный ответ`)
  if (this.openQuestions(pending).length === 0) this.finishQuestions(pending)
  return true
},

pendingQuestionFor(chatId, threadId) {
  for (const pending of this.pendingQuestions.values()) {
    if (pending.chatId !== chatId) continue
    if ((pending.threadId ?? 0) !== (threadId ?? 0)) continue
    return pending
  }
  return undefined
}

/**
 * Решение политики без вопроса в чат.
 *
 * `undefined` — спрашиваем. Иначе готовый исход: `rejected` для denylist,
 * `allowed-once` для allowlist, посттуры trusted (только чтение) и yolo.
 *
 * @param {string} tool имя инструмента
 * @param {object} cfg прочитанный конфиг
 * @returns {'rejected' | 'allowed-once' | undefined}
 */
}
