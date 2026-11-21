/**
 * Файлы Telegram: получить метаданные и скачать байты.
 *
 * Bot API отдаёт файл двумя шагами: `getFile` → `file_path`, затем
 * `https://api.telegram.org/file/bot<token>/<file_path>`. Лимит скачивания —
 * 20 МБ (больше отдаёт только локальный Bot API server).
 */

import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { callWithRetry } from './client.js'

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/** Допустимые типы изображений для части промпта. */
const IMAGE_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * Метаданные файла.
 * @param {string} token
 * @param {string} fileId
 * @param {{ baseUrl?: string }} [options]
 */
export async function fileInfo(token, fileId, options = {}) {
  return callWithRetry(token, 'getFile', { file_id: fileId }, {
    attempts: 2,
    baseUrl: options.baseUrl,
    signal: AbortSignal.timeout(15_000),
  })
}

/**
 * Скачивает файл и возвращает байты.
 * @param {string} token
 * @param {string} fileId
 * @param {{ baseUrl?: string }} [options]
 */
export async function downloadFile(token, fileId, options = {}) {
  const info = await fileInfo(token, fileId, options)
  if (typeof info?.file_size === 'number' && info.file_size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`file too large: ${info.file_size}`)
  }
  const base = String(options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const response = await fetch(`${base}/file/bot${token}/${info.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('file too large')
  return { buffer, filePath: info.file_path }
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Отправляет локальный файл документом.
 * @param {string} token
 * @param {{ chatId: number|string, threadId?: number, path: string, caption?: string, baseUrl?: string }} options
 */
export async function sendDocument(token, options) {
  const info = await stat(options.path)
  if (!info.isFile()) throw new Error('not a file')
  if (info.size > MAX_UPLOAD_BYTES) throw new Error('file too large (50 MB)')
  const form = new FormData()
  form.set('chat_id', String(options.chatId))
  if (options.threadId) form.set('message_thread_id', String(options.threadId))
  form.set('document', await openAsBlob(options.path), basename(options.path))
  if (options.caption) form.set('caption', String(options.caption).slice(0, 1024))
  const base = String(options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const response = await fetch(`${base}/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  const body = await response.json().catch(() => undefined)
  if (!body?.ok) throw new Error(body?.description ?? `HTTP ${response.status}`)
  return body.result
}

export function imageMediaType(filePath) {
  const extension = String(filePath ?? '').split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_BY_EXTENSION[extension]
}

/** Безопасное имя файла из пути Telegram. */
export function safeFileName(filePath, fallback = 'file') {
  const name = String(filePath ?? '').split('/').pop() ?? fallback
  const cleaned = name.replace(/[^\w.\-]+/g, '_').slice(-80)
  return cleaned === '' ? fallback : cleaned
}
