import assert from 'node:assert/strict'
import test from 'node:test'

import { createCardStreamer } from '../src/tg/stream.js'

test('карточка показывает статусную строку над текстом', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()
    calls.push({ method, params: init?.body ? JSON.parse(init.body) : {} })
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }
  }
  try {
    const streamer = createCardStreamer({ token: 'T', chatId: 1, minIntervalMs: 0, minDeltaChars: 1 })
    streamer.setStatus('Вызываю bash')
    streamer.append('Первый абзац ответа')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await streamer.finish('Финальный ответ')
  } finally {
    globalThis.fetch = original
  }

  const texts = calls
    .filter((call) => ['sendMessage', 'editMessageText'].includes(call.method))
    .map((call) => call.params.text ?? '')
  const card = texts.find((text) => text.includes('Первый абзац ответа'))
  assert.ok(card !== undefined, 'карточка отправлена')
  assert.match(card, /<i>Вызываю bash<\/i>/, 'статус сверху карточки')
  assert.ok(card.indexOf('Вызываю bash') < card.indexOf('Первый абзац'), 'статус раньше текста')
})

