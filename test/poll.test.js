import test from 'node:test';
import assert from 'node:assert/strict';

import { createPoller, retryDelay } from '../src/tg/poll.js';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const method = url.split('/').pop();
    const params = JSON.parse(init.body);
    calls.push({ method, params });
    return handler(method, params, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const okResponse = (result) => ({
  status: 200,
  json: async () => ({ ok: true, result }),
});
test('poll: offset двигается только после обработки', async () => {
  const handled = [];
  const state = { offset: undefined };
  const batch = [
    { update_id: 10, message: { text: 'a' } },
    { update_id: 11, message: { text: 'b' } },
  ];

  const fetchImpl = fakeFetch((method, params, callNumber) =>
    callNumber === 1 ? okResponse(batch) : okResponse([]),
  );

  const poller = createPoller({
    token: 'T',
    state,
    fetchImpl,
    onUpdate: (update) => {
      handled.push(update.update_id);
    },
    isStopped: () => handled.length >= 2,
  });

  await poller.start();
  assert.deepEqual(handled, [10, 11]);
  assert.equal(state.offset, 12);
  assert.equal(fetchImpl.calls[0].params.offset, undefined, 'первый запрос без offset');
  assert.deepEqual(fetchImpl.calls[0].params.allowed_updates, ['message', 'callback_query']);
  assert.equal(fetchImpl.calls[0].params.timeout, 25);
});


test('poll: 409 не фатален, 401 останавливает', async () => {
  const seen = [];
  const fetchImpl409 = fakeFetch((method, params, callNumber) =>
    callNumber === 1
      ? { status: 409, json: async () => ({ ok: false, error_code: 409, description: 'Conflict' }) }
      : okResponse([]),
  );

  const p1 = createPoller({
    token: 'T',
    fetchImpl: fetchImpl409,
    conflictDelayMs: 5,
    onUpdate: () => {},
    onEvent: (event) => seen.push(event.kind),
    isStopped: () => fetchImpl409.calls.length >= 2,
  });
  await p1.start();
  assert.ok(seen.includes('conflict'), 'конфликт зафиксирован');
  assert.ok(fetchImpl409.calls.length >= 2, 'после 409 поллер продолжает');

  const fetchImpl401 = fakeFetch(() => ({
    status: 401,
    json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
  }));
  const p2 = createPoller({
    token: 'bad',
    fetchImpl: fetchImpl401,
    onUpdate: () => {},
    onEvent: (event) => seen.push(event.kind),
  });
  await p2.start();
  assert.equal(fetchImpl401.calls.length, 1, 'на 401 поллер останавливается');
  assert.ok(seen.includes('unauthorized'));
});


test('backoff: пауза растёт экспоненциально и упирается в потолок', () => {
  assert.equal(retryDelay(0), 1000, 'первая пауза — секунда');
  assert.equal(retryDelay(3), 8000, 'четвёртая — восемь секунд');
  assert.equal(retryDelay(20), 300_000, 'дальше — потолок пять минут');
  assert.equal(retryDelay(0, { base: 5000 }), 5000, 'база настраивается');
  assert.equal(retryDelay(99, { base: 5000, max: 60_000 }), 60_000, 'потолок настраивается');
});

test('backoff: успешный опрос сбрасывает счётчик даже при упавшем обработчике', async () => {
  const events = [];
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 2) return okResponse([{ update_id: 1, message: { text: 'x' } }]);
    throw new Error('network down');
  };

  const poller = createPoller({
    token: 'T',
    fetchImpl,
    failureDelayMs: 1,
    onUpdate: () => { throw new Error('handler'); },
    onEvent: (event) => events.push(event),
    isStopped: () => events.filter((event) => event.kind === 'retry').length >= 2,
  });
  await poller.start();

  const retries = events.filter((event) => event.kind === 'retry');
  assert.equal(retries.length, 2, 'две паузы после сетевых ошибок');
  assert.equal(retries[0].delay, 1, 'первая пауза — база');
  assert.equal(retries[1].delay, 1, 'после успешного опроса счётчик сброшен; без сброса было бы 2');
});
