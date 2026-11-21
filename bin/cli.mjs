#!/usr/bin/env node
/**
 * Установка моста одной командой: `npx dsh-telegram-connect install`.
 *
 * CLI не требует запущенного DSH: он правит профиль на диске и печатает
 * следующие шаги. Идемпотентен — повторный запуск ничего не дублирует.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = 'dsh-telegram-connect'
const ENTRY_ID = 'telegram'
const DEFAULT_PROFILE = 'desktop'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const HELP = `dsh-telegram — мост Telegram для DeepSeek Harness

Команды:
  install [--profile <имя>]   прописать мост в профиль DSH (по умолчанию ${DEFAULT_PROFILE})
  uninstall [--profile <имя>] убрать мост из профиля
  status [--profile <имя>]    показать состояние профиля, токена и лога
  --help                      эта справка
  --version                   версия пакета

После установки перезапусти DSH: мост появится в боковой панели,
дальше токен бота задаётся в панели.`

/** Разбор аргументов: команда и --profile. */
function parseArgs(argv) {
  const [command = '--help', ...rest] = argv
  let profile = DEFAULT_PROFILE
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--profile' && rest[index + 1] !== undefined) {
      profile = rest[index + 1]
      index += 1
    }
  }
  return { command, profile }
}

function profileDir(profile) {
  return join(DSH_HOME, 'profiles', profile)
}

/**
 * Добавляет строку моста в cordis.patch.yml профиля.
 * @returns {'added' | 'present' | 'missing'}
 */
function installRow(profile) {
  const file = join(profileDir(profile), 'cordis.patch.yml')
  if (!existsSync(file)) return 'missing'
  const text = readFileSync(file, 'utf8')
  if (text.includes(`id: ${ENTRY_ID}`)) return 'present'
  // Ключ строки загрузчика — `name`, как у остальных записей патча.
  const row = [
    `- id: ${ENTRY_ID}`,
    `  name: "${PACKAGE}"`,
    '  config:',
    '    enabled: true',
    '',
  ].join('\n')
  const next = text.endsWith('\n') ? `${text}${row}` : `${text}\n${row}`
  writeFileSync(file, next, 'utf8')
  return 'added'
}

/** Убирает строку моста из профиля: id + module + enabled + config. */
function uninstallRow(profile) {
  const file = join(profileDir(profile), 'cordis.patch.yml')
  if (!existsSync(file)) return 'missing'
  const lines = readFileSync(file, 'utf8').split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    if (/^- id: telegram\s*$/.test(line)) { skipping = true; continue }
    if (skipping && /^- /.test(line)) skipping = false
    if (skipping && /^\s+(name|module|enabled|config):/.test(line)) continue
    if (skipping && line.trim() === '') { skipping = false; continue }
    if (skipping && /^\s+\w+:/.test(line)) continue
    out.push(line)
  }
  writeFileSync(file, out.join('\n'), 'utf8')
  return 'removed'
}

function status(profile) {
  const dir = profileDir(profile)
  const patch = join(dir, 'cordis.patch.yml')
  const credentials = join(DSH_HOME, '.credentials.yaml')
  const log = join(DSH_HOME, 'logs', 'telegram.log')
  const rows = []
  rows.push(`профиль:   ${profile} (${existsSync(dir) ? dir : 'нет такого каталога'})`)
  rows.push(`патч:      ${existsSync(patch) ? patch : 'не найден'}`)
  rows.push(`мост:      ${existsSync(patch) && readFileSync(patch, 'utf8').includes(`id: ${ENTRY_ID}`) ? 'прописан' : 'не прописан'}`)
  rows.push(`секреты:   ${existsSync(credentials) ? credentials : 'не найдены'}`)
  rows.push(`лог:       ${existsSync(log) ? log : 'ещё нет'}`)
  console.log(rows.join('\n'))
}

const { command, profile } = parseArgs(process.argv.slice(2))
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

if (command === 'install') {
  const result = installRow(profile)
  if (result === 'missing') {
    console.error(`Профиль «${profile}» не найден: ${profileDir(profile)}`)
    console.error('Запусти DSH Desktop хотя бы один раз или укажи профиль: --profile <имя>')
    process.exit(1)
  }
  if (result === 'present') {
    console.log(`Мост уже прописан в профиле «${profile}». Перезапусти DSH, если ещё не сделал.`)
  } else {
    console.log(`Мост прописан в профиль «${profile}».`)
    console.log('Перезапусти DSH Desktop: в боковой панели появится Telegram.')
    console.log('Токен бота задаётся в панели (SettingsSecretField), не в файлах.')
  }
  process.exit(0)
}

if (command === 'uninstall') {
  const result = uninstallRow(profile)
  if (result === 'missing') {
    console.error(`Профиль «${profile}» не найден: ${profileDir(profile)}`)
    process.exit(1)
  }
  console.log(`Мост убран из профиля «${profile}». Перезапусти DSH.`)
  process.exit(0)
}

if (command === 'status') {
  status(profile)
  process.exit(0)
}

if (command === '--version') {
  console.log(version)
  process.exit(0)
}

console.log(HELP)
