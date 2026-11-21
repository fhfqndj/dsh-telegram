/**
 * Rich messages (Bot API 10.1+): markdown с таблицами, заголовками, details,
 * списками и формулами — рендерится клиентом нативно.
 *
 * Отдельного `editRichMessage` в API нет, поэтому rich-путь используем только
 * для финальной отправки, а стриминг остаётся обычной карточкой. Если сервер
 * (или локальный Bot API) метода не знает — бросаем RichUnsupportedError,
 * и вызывающий код уходит на привычный HTML.
 */

import { TelegramError, callWithRetry } from './client.js'

/** Сервер не поддерживает rich messages: нужен запасной путь. */
export class RichUnsupportedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RichUnsupportedError'
  }
}

/** Ответ означает «такого метода нет», а не «неверный запрос». */
function isUnsupported(error) {
  if (!(error instanceof TelegramError)) return false
  if (error.status === 404) return true
  const description = String(error.body?.description ?? '')
  return /method.*not found|unknown method|not supported/i.test(description)
}

/**
 * Отправляет rich-сообщение.
 * @param {string} token
 * @param {object} options
 * @param {string | number} options.chatId
 * @param {number} [options.threadId]
 * @param {object[]} [options.blocks] semantic blocks: paragraph, heading, list, table, pre
 * @param {string} [options.markdown] markdown-версия (GFM + теги Telegram)
 * @param {string} [options.html] html-версия, если markdown не подходит
 * @param {boolean} [options.disableNotification]
 * @param {object} [options.replyMarkup]
 * @param {string} [options.baseUrl]
 */
export async function sendRichMessage(token, options) {
  // Приоритет: blocks (нативная семантика и отступы) → markdown → html.
  const richMessage = options.blocks !== undefined
    ? { blocks: options.blocks }
    : options.markdown !== undefined
      ? { markdown: options.markdown }
      : { html: options.html ?? '' }

  try {
    return await callWithRetry(token, 'sendRichMessage', {
      chat_id: options.chatId,
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      rich_message: richMessage,
      ...(options.disableNotification === true ? { disable_notification: true } : {}),
      ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
    }, {
      attempts: 2,
      baseUrl: options.baseUrl,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (isUnsupported(error)) {
      throw new RichUnsupportedError(String(error.body?.description ?? error.message))
    }
    throw error
  }
}
