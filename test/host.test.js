import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { hostSupported } from '../index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
test('hostSupported: нужен get и оба сервиса', () => {
  const ctx = (services) => ({ get: (name) => services[name] })
  assert.equal(hostSupported(ctx({ sessionController: {}, credentials: {} })), true)
  assert.equal(hostSupported(ctx({ sessionController: {} })), false, 'без credentials не поддерживается')
  assert.equal(hostSupported(ctx({ credentials: {} })), false, 'без sessionController не поддерживается')
  assert.equal(hostSupported({}), false, 'без get не поддерживается')
  assert.equal(hostSupported(undefined), false)
})

