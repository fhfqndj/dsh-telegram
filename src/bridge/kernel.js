/**
 * Чистые помощники моста: без состояния и без обращений к ctx.
 *
 * Отдельный модуль, чтобы bridge-модули не тянули друг друга и не заводили цикл.
 */

import os from 'node:os'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

/** Предел текста одного сообщения: Telegram режет на 4096, оставляем запас. */
export const MAX_TEXT = 3800

/** Сколько живут кнопки списка сессий. */
export const SESSION_BUTTON_TTL_MS = 10 * 60 * 1000

/** Каталог состояния DSH и файл состояния моста. */
export const STATE_DIR = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
export const STATE_FILE = path.join(STATE_DIR, 'telegram-bridge.json')

/** Ссылка на токен в хранилище credentials. */
export const TOKEN_REF = 'TELEGRAM_BOT_TOKEN'

/** Компактная запись числа токенов: 1 234 567 → 1,2M. */
export function formatTokens(value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number <= 0) return '0'
  if (number < 1000) return String(Math.round(number))
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}K`
  return `${(number / 1_000_000).toFixed(1)}M`
}

/** Инструменты чтения: в посттуре trusted разрешены без вопроса. */
export const SAFE_TOOLS = new Set([
  'read', 'glob', 'grep', 'ls', 'list', 'list_directory', 'webfetch', 'web_fetch',
  'websearch', 'web_search', 'todo_write', 'read_image',
])

/**
 * Совпадение имени инструмента с шаблоном из настройки.
 * Шаблон понимает `*` в любом месте; без звёздочки — точное имя.
 */
export function matchesTool(name, pattern) {
  const value = String(pattern).toLowerCase().trim()
  if (value === '') return false
  if (!value.includes('*')) return name === value || name.startsWith(`${value}_`)
  const regex = new RegExp(`^${value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return regex.test(name)
}

/**
 * Лежит ли файл внутри каталога: сравниваем после resolve, иначе `..` обходит проверку.
 * Границу `..` сравниваем по компоненту: `..foo` — обычное имя файла внутри каталога.
 */
export function isPathInside(root, target) {
  if (typeof root !== 'string' || root === '') return false
  if (typeof target !== 'string' || target === '') return false
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * То же, но с раскрытием symlink: ссылка из workspace наружу не считается «внутри».
 * Если пути ещё нет (ENOENT), границу проверит `stat` в sendDocument.
 */
export async function isPathInsideReal(root, target) {
  if (!isPathInside(root, target)) return false
  try {
    const [base, resolved] = await Promise.all([realpath(root), realpath(target)])
    return isPathInside(base, resolved)
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

/** Текст из AssistantMessage: склеивает текстовые части, игнорируя остальные. */
export function extractText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}
