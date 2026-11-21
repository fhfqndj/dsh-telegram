/**
 * Файловый лог моста: `$DSH_HOME/logs/telegram.log`.
 *
 * Логи приложения уходят в консоль Electron, куда агенту из сессии не попасть.
 * Поэтому всё, что делает бот (апдейты, команды, промпты, ошибки доставки),
 * пишется рядом с состоянием — так поведение можно разобрать по факту.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 1_000_000
const KEEP_LINES = 400

/**
 * @param {string} dir каталог логов
 */
export function createFileLogger(dir) {
  const file = path.join(dir, 'telegram.log')
  /** Лог содержит chat/user id и текст задач: только владельцу. */
  const secure = () => {
    try {
      if (existsSync(file)) chmodSync(file, 0o600)
    } catch {
      // права не критичны для работы
    }
  }

  const rotate = () => {
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        renameSync(file, `${file}.1`)
      }
    } catch {
      // ротация не критична
    }
  }

  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      mkdirSync(dir, { recursive: true })
      rotate()
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
      secure()
    } catch {
      // если писать некуда — молчим, это не должно ломать бота
    }
    return line
  }

  return {
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
    /** Последние строки для команды /log. */
    tail(count = 40) {
      try {
        if (!existsSync(file)) return ''
        const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
        return lines.slice(-count).join('\n')
      } catch {
        return ''
      }
    },
    keepLines: KEEP_LINES,
  }
}
