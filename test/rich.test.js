import test from 'node:test'
import assert from 'node:assert/strict'

import { RichUnsupportedError, sendRichMessage } from '../src/tg/rich.js'
import { callWithRetry } from '../src/tg/client.js'

const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) })
const fail = (status, description) => ({
  status,
  json: async () => ({ ok: false, error_code: status, description }),
})

function mockFetch(response) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), params: JSON.parse(init.body) })
    return response
  }
  impl.calls = calls
  return impl
}
test('rich-путь сам определяет отсутствие метода (404)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = mockFetch(fail(404, 'Not Found: method not found'))
  try {
    await assert.rejects(
      () => sendRichMessage('TOKEN', { chatId: 1, markdown: 'текст' }),
      (error) => error instanceof RichUnsupportedError,
    )
  } finally {
    globalThis.fetch = original
  }
})


test('429 ждёт retry_after и повторяет вызов', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return {
        status: 429,
        json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }),
      }
    }
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }
  }
  try {
    const result = await callWithRetry('TOKEN', 'sendMessage', { chat_id: 1, text: 'x' })
    assert.deepEqual(result, { message_id: 1 })
    assert.equal(calls, 2, 'второй вызов после 429')
  } finally {
    globalThis.fetch = original
  }
})

