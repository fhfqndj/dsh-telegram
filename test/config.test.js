import test from 'node:test'
import assert from 'node:assert/strict'

import { readConfig } from '../src/config.js'

const ref = (value) => ({ get: () => value })
const fields = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)]))

test('readConfig: флаг путей и поля, которые правятся из панели', () => {
  const cfg = readConfig(fields({
    allowAnyPath: true,
    retentionDays: 7,
    logMessages: true,
    richTables: false,
    approvalsAllow: 'read, glob',
    approvalsDeny: 'bash*',
  }))

  assert.equal(cfg.allowAnyPath, true, 'флаг путей читается');
  assert.equal(cfg.retentionDays, 7);
  assert.equal(cfg.logMessages, true);
  assert.equal(cfg.richTables, false);
  assert.deepEqual(cfg.approvalsAllow, ['read', 'glob']);
  assert.deepEqual(cfg.approvalsDeny, ['bash*']);
})

test('readConfig: по умолчанию файлы вне workspace запрещены', () => {
  const cfg = readConfig(fields({}))
  assert.equal(cfg.allowAnyPath, false)
  assert.equal(cfg.retentionDays, 30)
  assert.equal(cfg.logMessages, false)
  assert.equal(cfg.richTables, true)
})
