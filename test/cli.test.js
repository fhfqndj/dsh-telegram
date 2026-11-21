import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Готовит временный DSH_HOME с одним профилем. */
function fakeHome(patch = '- id: other\n  name: "x"\n  config:\n    a: 1\n') {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cli-'))
  const dir = join(home, 'profiles', 'work')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return { home, patch: join(dir, 'cordis.patch.yml') }
}

const run = (args, home) => execFileSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
})
test('install прописывает мост строкой загрузчика с ключом name', () => {
  const { home, patch } = fakeHome()
  run(['install', '--profile', 'work'], home)
  const text = readFileSync(patch, 'utf8')

  assert.match(text, /- id: telegram\n {2}name: "dsh-telegram-connect"\n {2}config:\n {4}enabled: true/)
  assert.match(text, /- id: other/, 'чужие строки не трогаются')
})


test('uninstall убирает строку моста и оставляет остальные', () => {
  const { home, patch } = fakeHome()
  run(['install', '--profile', 'work'], home)
  run(['uninstall', '--profile', 'work'], home)
  const text = readFileSync(patch, 'utf8')

  assert.ok(!text.includes('id: telegram'))
  assert.match(text, /- id: other\n {2}name: "x"\n {2}config:\n {4}a: 1/)
})


test('status печатает профиль и наличие моста', () => {
  const { home } = fakeHome()
  run(['install', '--profile', 'work'], home)
  const out = run(['status', '--profile', 'work'], home)
  assert.match(out, /профиль:\s+work/)
  assert.match(out, /мост:\s+прописан/)
})

