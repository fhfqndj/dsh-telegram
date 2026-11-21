import test from 'node:test'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { TelegramBridge } from '../index.js'

const ref = (value) => ({ get: () => value })

function makeConfig(overrides = {}) {
  const values = {
    enabled: true,
    ownerId: 0,
    workspacePath: '/w',
    notifyMode: 'normal',
    allowNewSessions: true,
    streaming: false,
    richMessages: true,
    richTables: true,
    richHeadings: false,
    approvals: true,
    questions: true,
    approvalsPosture: 'ask',
    approvalsAllow: '',
    approvalsDeny: '',
    language: 'auto',
    allowedUsers: '',
    ...overrides,
  }
  // Каждое поле — volatile-ссылка, как в реальном конфиге плагина.
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)]))
}

function makeHarness(options = {}) {
  const calls = []
  const prompts = []
  const created = []
  const configWrites = []
  const items = options.items ?? [
    { sessionId: 's1', cwd: '/w', updatedAt: 2, running: false, projections: { values: { title: 'Первая' } } },
    { sessionId: 's2', cwd: '/w', updatedAt: 1, running: false, projections: { values: { title: 'Вторая' } } },
    { sessionId: 'x9', cwd: '/other', updatedAt: 3, running: false, projections: { values: { title: 'Чужая' } } },
  ]

  const editor = {
    entries: () => [{ options: { id: 'telegram' } }],
    edit: async (_entry, change) => {
      configWrites.push(change({}))
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    credentials: { resolve: async () => ({ value: 'TOKEN' }) },
    workspaceRegistry: {
      list: () => [{ path: '/w', id: 'w1' }],
      resolveByPath: async (target) => (target === '/w' ? { id: 'w1', path: '/w' } : undefined),
    },
    sessionController: {
      list: async () => ({ items }),
      create: async (request) => {
        created.push(request)
        return { sessionId: 'new-1' }
      },
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
      cancel: async () => ({ accepted: true }),
      events: async () => ({
        records: [
          { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: 'старый вопрос' }] } } },
          { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'старый ответ' }] } } } },
        ],
      }),
      resolveAgent: async () => ({ agent: { id: 'new-1' } }),
    },
    get: (name) => (name === 'configEditor' ? editor : undefined),
  }

  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()
    const params = init?.body ? JSON.parse(init.body) : {}
    calls.push({ method, params })
    return { status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) }
  }

  const stateFile = options.stateFile
    ?? path.join(tmpdir(), `dsh-telegram-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`)
  const lines = []
  const log = {
    info: (message) => lines.push(`INFO ${message}`),
    warn: (message) => lines.push(`WARN ${message}`),
    error: (message) => lines.push(`ERROR ${message}`),
    tail: (count = 40) => lines.slice(-count).join('\n'),
    file: '/dev/null',
  }
  const bridge = new TelegramBridge(ctx, makeConfig(options.config), { stateFile, log })
  bridge.loaded = true
  return { bridge, calls, prompts, created, configWrites, items, lines }
}

/** Текст любого исходящего сообщения: обычного или rich. */
/** Достаёт текст из любого вида rich-сообщения: blocks, markdown или html. */
function richText(node) {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(richText).join(' ')
  const parts = []
  if (typeof node.text === 'string') parts.push(node.text)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text') continue
    if (typeof value === 'string') parts.push(value)
    else if (typeof value === 'object' && value !== null) parts.push(richText(value))
  }
  return parts.join(' ')
}

const sentText = (call) => call.params.text
  ?? (call.params.rich_message === undefined ? undefined : richText(call.params.rich_message))
  ?? ''

const message = (id, text, chatId = 100, fromId = 555) => ({
  chat: { id: chatId, type: 'private' },
  from: { id: fromId },
  text,
})

test('задачи из чата: новая сессия, привязка и промпт', async () => {
  const { bridge, prompts, created, items } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, 'почини сборку'), 1, 'TOKEN')

  assert.equal(created.length, 1, 'сессия создана один раз')
  assert.equal(created[0].workspaceId, 'w1', 'сессия в workspace, а не вне группы')
  assert.equal(prompts.at(-1).sessionId, 'new-1')
  assert.deepEqual(prompts.at(-1).content, [{ type: 'text', text: 'почини сборку' }])
  assert.equal(bridge.bindingFor(100, undefined).sessionId, 'new-1')
  assert.equal(items.length, 3, 'список сессий не мутируется')
})

test('чужие сессии не видны и не привязываются', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/sessions'), 2, 'TOKEN')
  const list = sentText(calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.ok(!list.includes('x9'), 'сессия другого workspace не показана')

  await bridge.handleMessage(message(555, '/use x9'), 3, 'TOKEN')
  assert.equal(bridge.bindingFor(100, undefined), undefined)
})

test('доступ: владелец, allowlist, fail-closed и /pair', async () => {
  const closed = makeHarness({ config: { ownerId: 0 } })
  await closed.bridge.handleMessage(message(555, 'привет'), 4, 'TOKEN')
  assert.equal(closed.prompts.length, 0, 'без владельца бот молчит')
  assert.match(sentText(closed.calls.filter((call) => call.method === 'sendMessage').at(-1)), /владелец/)

  const open = makeHarness({ config: { ownerId: 555, allowedUsers: '777' } })
  await open.bridge.handleMessage(message(777, 'задача'), 5, 'TOKEN')
  assert.equal(open.prompts.length, 1, 'участник allowlist работает')

  await open.bridge.handleMessage(message(999, 'чужой', 100, 999), 6, 'TOKEN')
  assert.equal(open.prompts.length, 1, 'посторонний игнорируется')

  const paired = makeHarness({ config: { ownerId: 555, pairingCode: 'AQ7' } })
  await paired.bridge.handleMessage(message(888, '/pair AQ7', 100, 888), 7, 'TOKEN')
  assert.equal(paired.configWrites.at(-1).allowedUsers, '888')
})

test('ACL: только владелец меняет сессии и адрес уведомлений', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555, allowedUsers: '777' } })
  bridge.state.bindings['200:0'] = { sessionId: 's1', at: Date.now() }

  await bridge.handleMessage(message(777, '/use s2', 300, 777), 8, 'TOKEN')
  assert.match(sentText(calls.filter((call) => call.method === 'sendMessage').at(-1)), /только владелец/)
  await bridge.handleMessage(message(777, '/peek s1', 300, 777), 9, 'TOKEN')
  assert.match(sentText(calls.filter((call) => call.method === 'sendMessage').at(-1)), /только владелец/)

  await bridge.handleMessage(message(777, 'привет', 400, 777), 10, 'TOKEN')
  assert.notEqual(bridge.state.ownerChatId, 400, 'чат участника не становится адресом владельца')
  await bridge.handleMessage(message(555, '/status', 401, 555), 11, 'TOKEN')
  assert.equal(bridge.state.ownerChatId, 401)
})

test('подтверждения: кнопка разрешает, таймаут отклоняет, без чата — веб-UI', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/use s1'), 12, 'TOKEN')

  const controller = new AbortController()
  const pending = bridge.onApprovalRequest({ agent: { id: 's1' }, toolName: 'bash', signal: controller.signal }, () => 'next')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const card = calls.filter((call) => call.method === 'sendMessage').at(-1)
  assert.match(card.params.text, /bash/)
  await bridge.handleCallback({
    id: 'cb-1', from: { id: 555 }, data: card.params.reply_markup.inline_keyboard[0][0].callback_data,
    message: { chat: { id: 100, type: 'private' } },
  }, 'TOKEN')
  assert.equal(await pending, 'allowed-once')

  const foreign = makeHarness({ config: { ownerId: 555 } })
  assert.equal(await foreign.bridge.onApprovalRequest({ agent: { id: 'unknown' }, toolName: 'bash' }, () => 'web'), 'web')
})

test('политика подтверждений: postures и списки инструментов', async () => {
  const { bridge } = makeHarness({ config: { ownerId: 555, approvalsDeny: 'write' } })
  await bridge.handleMessage(message(555, '/use s1'), 13, 'TOKEN')
  assert.equal(await bridge.onApprovalRequest({ agent: { id: 's1' }, toolName: 'write' }, () => 'next'), 'rejected')

  const trusted = makeHarness({ config: { ownerId: 555, approvalsPosture: 'trusted' } })
  await trusted.bridge.handleMessage(message(555, '/use s1'), 14, 'TOKEN')
  assert.equal(await trusted.bridge.onApprovalRequest({ agent: { id: 's1' }, toolName: 'read' }, () => 'next'), 'allowed-once')
  const yolo = makeHarness({ config: { ownerId: 555, approvalsPosture: 'yolo' } })
  await yolo.bridge.handleMessage(message(555, '/use s1'), 15, 'TOKEN')
  assert.equal(await yolo.bridge.onApprovalRequest({ agent: { id: 's1' }, toolName: 'bash' }, () => 'next'), 'allowed-once')
})

test('вопросы агента: кнопка, текст и отказ без привязки', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555, questions: true } })
  await bridge.handleMessage(message(555, '/use s1'), 16, 'TOKEN')

  const controller = new AbortController()
  const byButton = bridge.onQuestionRequest({
    questions: [{ id: 'q1', question: 'Куда деплоить?', options: [{ label: 'Прод' }, { label: 'Стенд' }] }],
    agent: { id: 's1' }, signal: controller.signal,
  }, () => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  const card = calls.filter((call) => call.method === 'sendMessage').at(-1)
  assert.match(card.params.text, /Куда деплоить/)
  await bridge.handleCallback({
    id: 'cb-2', from: { id: 555 }, data: card.params.reply_markup.inline_keyboard[1][0].callback_data,
    message: { chat: { id: 100, type: 'private' } },
  }, 'TOKEN')
  assert.deepEqual(await byButton, { answers: [{ id: 'q1', selected: ['Стенд'] }] })

  const byText = bridge.onQuestionRequest({
    questions: [{ id: 'q2', question: 'Как назвать ветку?' }],
    agent: { id: 's1' }, signal: new AbortController().signal,
  }, () => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  await bridge.handleMessage(message(555, 'feature/tg'), 17, 'TOKEN')
  assert.deepEqual(await byText, { answers: [{ id: 'q2', selected: [], custom: 'feature/tg' }] })

  const foreign = makeHarness({ config: { ownerId: 555, questions: true } })
  assert.equal(await foreign.bridge.onQuestionRequest({ questions: [{ id: 'q3', question: '?' }], agent: { id: 'x' } }, () => 'web'), 'web')
})

test('тишина: /mute и /quiet не мешают вопросам и подтверждениям', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555, notifyMode: 'quiet' } })
  await bridge.handleMessage(message(555, '/use s1'), 18, 'TOKEN')
  await bridge.handleMessage(message(555, '/mute'), 19, 'TOKEN')

  const before = calls.length
  await bridge.deliverAnswer({ chatId: 100, threadId: undefined }, 'финал не должен уйти')
  assert.equal(calls.slice(before).filter((call) => ['sendMessage', 'sendRichMessage'].includes(call.method)).length, 0)

  const question = bridge.onQuestionRequest({
    questions: [{ id: 'q4', question: 'Видно?' }], agent: { id: 's1' }, signal: new AbortController().signal,
  }, () => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(sentText(calls.filter((call) => call.method === 'sendMessage').at(-1)), /Видно/)
  bridge.dispose()
  await question
})

test('привязки: /unbind, /steer и устаревшая сессия', async () => {
  const { bridge, prompts, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/use s1'), 20, 'TOKEN')

  await bridge.handleMessage(message(555, '/steer не трогай миграции'), 21, 'TOKEN')
  assert.equal(prompts.at(-1).mode, 'queue')
  assert.equal(prompts.at(-1).content[0].text, 'не трогай миграции')

  await bridge.handleMessage(message(555, '/unbind s1'), 22, 'TOKEN')
  assert.equal(bridge.bindingFor(100, undefined), undefined)
  assert.match(sentText(calls.filter((call) => call.method === 'sendMessage').at(-1)), /Отвязал/)

  // Сессия исчезла: бот снимает привязку и заводит новую, не теряя вложения.
  await bridge.handleMessage(message(555, '/use s1'), 23, 'TOKEN')
  bridge.ctx.sessionController.prompt = async () => { throw new Error('session not found') }
  bridge.ctx.sessionController.create = async () => ({ sessionId: 'fresh-1' })
  const retry = []
  bridge.ctx.sessionController.prompt = async (request) => {
    if (request.sessionId === 's1') throw new Error('session not found')
    retry.push(request)
    return { accepted: true }
  }
  await bridge.handleMessage(message(555, 'задача с картинкой'), 24, 'TOKEN')
  assert.equal(retry.at(-1).sessionId, 'fresh-1')
  assert.equal(bridge.bindingFor(100, undefined).sessionId, 'fresh-1')
})

test('финал доставляется один раз за ход, а не на каждый шаг', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/use s1'), 25, 'TOKEN')
  bridge.botTurns.add('s1')
  const before = calls.length

  await bridge.onAssistantStream({ id: 's1' }, { type: 'start' })
  await bridge.onAssistantStream({ id: 's1' }, { type: 'chunk', chunk: { type: 'text-delta', text: 'думаю' } })
  await bridge.onAssistantStream({ id: 's1' }, { type: 'end', outcome: { kind: 'committed' } })
  await bridge.onAssistantStream({ id: 's1' }, { type: 'start' })
  await bridge.onAssistantStream({ id: 's1' }, { type: 'end', outcome: { kind: 'committed' } })
  await bridge.onSessionEvent({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Готовый ответ' }] } } })
  await bridge.onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))

  const finals = calls.slice(before)
    .filter((call) => ['sendMessage', 'sendRichMessage'].includes(call.method))
    .filter((call) => /Готовый ответ/.test(sentText(call)))
  assert.equal(finals.length, 1)
  assert.equal(bridge.turns.size, 0)
})

test('уведомления о работе не из чата: только там, где включены', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555, notifyMode: 'normal' } })
  await bridge.handleMessage(message(555, '/notify on'), 26, 'TOKEN')

  await bridge.onSessionEvent({ id: 's2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'готово' }] } } })
  await bridge.onSessionEvent({ id: 's2' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(calls.some((call) => /готово/.test(sentText(call))), 'уведомление пришло в чат с /notify on')

  const silent = makeHarness({ config: { ownerId: 555, notifyMode: 'quiet' } })
  await silent.bridge.handleMessage(message(555, '/use s1'), 27, 'TOKEN')
  const before = silent.calls.length
  await silent.bridge.onSessionEvent({ id: 's2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'тихо' }] } } })
  await silent.bridge.onSessionEvent({ id: 's2' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(silent.calls.slice(before).filter((call) => /тихо/.test(sentText(call))).length, 0)
})

test('/status, /cost и /model показывают состояние', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/use s1'), 28, 'TOKEN')
  bridge.addUsage('s1', { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800 })
  bridge.state.model = { s1: { provider: 'p', model: 'm' } }

  await bridge.handleMessage(message(555, '/status'), 29, 'TOKEN')
  const status = sentText(calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.match(status, /p\/m/)
  assert.match(status, /вход 1\.2K/)

  await bridge.handleMessage(message(555, '/cost'), 30, 'TOKEN')
  assert.match(sentText(calls.filter((call) => call.method === 'sendMessage').at(-1)), /Всего/)

  bridge.llm = { listProviders: () => [{ id: 'alpha' }], listModels: async () => [{ id: 'm1' }] }
  bridge.ctx.sessionController.selectModel = async (request) => ({ selected: request })
  await bridge.handleMessage(message(555, '/model'), 31, 'TOKEN')
  const picker = calls.filter((call) => call.method === 'sendMessage').at(-1)
  assert.match(JSON.stringify(picker.params.reply_markup), /alpha\/m1/)
})

test('состояние переживает рестарт, а код подключения не попадает в лог', async () => {
  const file = path.join(tmpdir(), `dsh-tg-${process.pid}-${Math.random().toString(16).slice(2)}.json`)
  const first = makeHarness({ config: { ownerId: 555, pairingCode: 'SECRET42' }, stateFile: file })
  first.bridge.loaded = false
  await first.bridge.loadState()
  first.bridge.addUsage('s1', { inputTokens: 10, outputTokens: 5 })
  first.bridge.state.mute = { '100:0': true }
  await first.bridge.saveState()

  const second = makeHarness({ config: { ownerId: 555 }, stateFile: file })
  second.bridge.loaded = false
  await second.bridge.loadState()
  assert.equal(second.bridge.usageOf('s1').session.input, 10)
  assert.equal(second.bridge.muted(100, undefined), true)

  await first.bridge.handleMessage(message(888, '/pair WRONG99', 100, 888), 32, 'TOKEN')
  assert.ok(!first.lines.join('\n').includes('WRONG99'))
  assert.ok(!first.lines.join('\n').includes('SECRET42'))
})

test('медиа: на голос отвечаем один раз', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/use s1'), 33, 'TOKEN')

  const before = calls.length
  await bridge.handleMessage({ chat: { id: 100, type: 'private' }, from: { id: 555 }, voice: { file_id: 'v1', duration: 3 } }, 35, 'TOKEN')
  const replies = calls.slice(before).filter((call) => call.method === 'sendMessage')
  assert.equal(replies.length, 1, 'на голос отвечаем один раз')
})

test('отмена и ошибки не ломают обработчик', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })
  await bridge.handleMessage(message(555, '/use s1'), 36, 'TOKEN')

  bridge.ctx.sessionController.prompt = async () => { throw new Error('boom') }
  await bridge.handleMessage(message(555, 'задача'), 37, 'TOKEN')
  assert.match(sentText(calls.filter((call) => call.method === 'sendMessage').at(-1)), /boom/)

  const controller = new AbortController()
  const pending = bridge.onQuestionRequest({ questions: [{ id: 'q5', question: '?' }], agent: { id: 's1' }, signal: controller.signal }, () => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  assert.deepEqual(await pending, { answers: [{ id: 'q5', selected: [] }] })
})

test('меню команд в чате публикуется на его языке', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555, language: 'en' } })

  await bridge.handleMessage(message(555, '/start'), 47, 'TOKEN')

  const menu = calls.filter((call) => call.method === 'setMyCommands').at(-1)
  assert.equal(menu?.params.scope?.type, 'chat', 'меню ставится в chat-scope')
  const start = menu.params.commands.find((row) => row.command === 'start')
  assert.equal(start.description, 'greeting and buttons', 'описание на языке чата')
})

test('язык из панели действует, а /lang перекрывает его', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555, language: 'en' } })

  // Клиент русский, но в панели выбран английский: побеждает панель.
  await bridge.handleMessage({ chat: { id: 100, type: 'private' }, from: { id: 555, language_code: 'ru' }, text: 'почини сборку' }, 43, 'TOKEN')
  const created = sentText(calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.match(created, /New session/, 'ответ на en из панели')

  // Явный /lang перекрывает настройку панели.
  await bridge.handleMessage(message(555, '/lang ru'), 44, 'TOKEN')
  await bridge.handleMessage(message(555, '/status'), 45, 'TOKEN')
  const status = sentText(calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.match(status, /Уведомления/, 'после /lang ru ответ на ru')
})

test('сохранённый язык прошедшей версии не перекрывает настройку панели', async () => {
  const stateFile = path.join(tmpdir(), `dsh-telegram-lang-${process.pid}-${Date.now()}.json`)
  // Так состояние выглядело до правки: определённый язык клиента лежал в state.lang.
  await writeFile(stateFile, JSON.stringify({ lang: { '100:0': 'ru' }, ownerId: 555 }))

  const { bridge, calls } = makeHarness({ stateFile, config: { ownerId: 555, language: 'en' } })
  bridge.loaded = false
  await bridge.loadState()

  await bridge.handleMessage(message(555, '/status'), 46, 'TOKEN')
  const status = sentText(calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.match(status, /Notifications/, 'старое состояние не держит русский навсегда')
})

test('/doctor присылает диагностику, а не падает', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })

  await bridge.handleMessage(message(555, '/doctor'), 38, 'TOKEN')

  assert.ok(
    calls.some((call) => call.method === 'getWebhookInfo'),
    'диагностика спрашивает webhook',
  )
  const reply = calls.map(sentText).find((text) => text.includes('webhook:'))
  assert.ok(reply !== undefined, 'диагностика ушла в чат')
  assert.match(reply, /poll: on/)
  assert.match(reply, /offset:/)
})

test('явный /lang переживает рестарт', async () => {
  const stateFile = path.join(tmpdir(), `dsh-telegram-lang3-${process.pid}-${Date.now()}.json`)
  const first = makeHarness({ stateFile, config: { ownerId: 555, language: 'en' } })
  await first.bridge.handleMessage(message(555, '/lang ru'), 50, 'TOKEN')
  await first.bridge.saveState()

  // Рестарт с той же настройкой панели: явный выбор должен остаться явным.
  const second = makeHarness({ stateFile, config: { ownerId: 555, language: 'en' } })
  second.bridge.loaded = false
  await second.bridge.loadState()

  await second.bridge.handleMessage(message(555, '/status'), 51, 'TOKEN')
  const status = sentText(second.calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.match(status, /Уведомления/, 'явный /lang важнее настройки панели и после рестарта')
})

test('auto берёт язык клиента Telegram', async () => {
  const { bridge, calls } = makeHarness({ config: { ownerId: 555 } })

  await bridge.handleMessage({ chat: { id: 100, type: 'private' }, from: { id: 555, language_code: 'en' }, text: 'fix build' }, 52, 'TOKEN')

  const created = sentText(calls.filter((call) => call.method === 'sendMessage').at(-1))
  assert.match(created, /New session/, 'при auto побеждает язык клиента')
})
