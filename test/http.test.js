import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createPoller, botIdentity, clearWebhook } from '../src/tg/poll.js'
import { createCardStreamer } from '../src/tg/stream.js'

/** Локальный двойник Bot API: реальные сокеты, без сети и токена. */
async function startMockApi() {
  const log = []
  let updateServed = false
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const method = url.pathname.split('/').pop()
      const params = body === '' ? {} : JSON.parse(body)
      log.push({ method, params })

      const reply = (result) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result }))
      }

      if (method === 'getUpdates') {
        if (!updateServed) {
          updateServed = true
          reply([{
            update_id: 41,
            message: {
              message_id: 7,
              chat: { id: 500, type: 'private' },
              from: { id: 500, is_bot: false },
              text: 'привет',
            },
          }])
          return
        }
        reply([])
        return
      }
      if (method === 'sendMessage') {
        reply({ message_id: 900 + log.length })
        return
      }
      reply(true)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
    methods: (name) => log.filter((entry) => entry.method === name),
  }
}
test('поллер забирает апдейт у настоящего HTTP-сервера и подтверждает его', async () => {
  const api = await startMockApi()
  try {
    const received = []
    const state = { offset: undefined }
    const poller = createPoller({
      token: 'TEST',
      baseUrl: api.baseUrl,
      state,
      onUpdate: (update) => { received.push(update.update_id) },
      isStopped: () => received.length >= 1 && api.methods('getUpdates').length >= 2,
    })
    await poller.start()

    assert.deepEqual(received, [41])
    assert.equal(state.offset, 42)
    const polls = api.methods('getUpdates')
    assert.equal(polls.length >= 2, true, 'поллер должен опросить сервер повторно')
    assert.equal(polls[1].params.offset, 42, 'повторный опрос подтверждает апдейт смещением')
  } finally {
    await api.close()
  }
})


test('служебные вызовы идут на тот же baseUrl и с правильным токеном', async () => {
  const api = await startMockApi()
  try {
    await clearWebhook('TEST', { baseUrl: api.baseUrl })
    assert.equal(api.methods('deleteWebhook').length, 1)
    assert.equal(api.log[0].params.drop_pending_updates, false)
  } finally {
    await api.close()
  }
})

