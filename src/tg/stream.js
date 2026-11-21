/**
 * Стриминг ответа агента в чат: одна редактируемая карточка + финал отдельным
 * сообщением.
 *
 * Почему так: правки — это отдельные запросы с флуд-контролем (~1/сек на чат),
 * поэтому дельты копятся и карточка обновляется по таймеру, а не на каждый токен.
 * Финал отправляется новым сообщением, чтобы карточка не осталась единственной
 * копией ответа (её легко потерять при сбое правки).
 */

import { callWithRetry } from './client.js';
import { markdownToHtml, splitHtml } from './html.js';

const MAX_TEXT = 3800;

/**
 * @param {object} options
 * @param {string} options.token
 * @param {string | number} options.chatId
 * @param {number} [options.messageThreadId]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.minDeltaChars]
 */
export function createCardStreamer(options) {
  const baseUrl = options.baseUrl
  const minIntervalMs = options.minIntervalMs ?? 900;
  const minDeltaChars = options.minDeltaChars ?? 20;

  let messageId;
  let pending = '';
  let status = '';
  let shown = '';
  let lastAt = 0;
  let closed = false;
  let chain = Promise.resolve();
  let timer;

  const base = {
    chat_id: options.chatId,
    ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
  };

  async function ensureMessage(text) {
    if (messageId !== undefined) return;
    const message = await callWithRetry(options.token, 'sendMessage', {
      ...base,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    }, { baseUrl });
    messageId = message.message_id;
    shown = text;
    lastAt = Date.now();
  }

  /** Тело карточки: статусная строка сверху, затем накопленный текст. */
  function render() {
    // Режем по границе тегов: slice оборвал бы <b>/<pre> и дал 400.
    const body = splitHtml(markdownToHtml(pending), MAX_TEXT)[0] ?? '';
    const head = status === '' ? '' : `<i>${markdownToHtml(status)}</i>`;
    if (head === '') return body;
    if (body === '') return head;
    return `${head}\n\n${body}`;
  }

  async function push() {
    const html = render();
    if (html === shown) return;

    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    try {
      await ensureMessage(html);
      if (messageId === undefined) return;
      if (html === shown) return;
      // editMessageText не принимает message_thread_id — только chat_id и message_id.
      await callWithRetry(options.token, 'editMessageText', {
        chat_id: options.chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }, { baseUrl });
      shown = html;
      lastAt = Date.now();
    } catch (error) {
      if (error?.status === 400 && /message is not modified/i.test(error.body?.description ?? '')) {
        shown = html;
        return;
      }
      throw error;
    }
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (pending.length - shown.length < minDeltaChars) {
        schedule();
        return;
      }
      chain = chain.then(push).catch((error) => { options.onError?.(error); });
    }, minIntervalMs);
  }

  return {
    /** Накопить текст (вызывается на каждую дельту, без await). */
    append(text) {
      if (closed || !text) return;
      pending += text;
      schedule();
    },

    /**
     * Показать, что бот делает прямо сейчас («Вызываю bash», «Жду подтверждения»).
     * @param {string} text пустая строка убирает статус
     */
    setStatus(text) {
      if (closed) return;
      const next = String(text ?? '');
      if (next === status) return;
      status = next;
      schedule();
    },

    async typing() {
      await callWithRetry(options.token, 'sendChatAction', {
        ...base,
        action: 'typing',
      }, { baseUrl }).catch(() => {});
    },

    async finish(finalText) {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await chain.catch(() => {});

      const html = markdownToHtml(finalText);
      const parts = splitHtml(html, MAX_TEXT);
      if (parts.length === 0) {
        // Пустой финал: карточку прогресса всё равно надо убрать.
        if (messageId !== undefined) {
          await callWithRetry(options.token, 'deleteMessage', {
            chat_id: options.chatId,
            message_id: messageId,
          }, { baseUrl }).catch(() => {});
        }
        return;
      }

      for (const [index, part] of parts.entries()) {
        await callWithRetry(options.token, 'sendMessage', {
          chat_id: options.chatId,
          ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
          text: part,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(index > 0 ? { disable_notification: true } : {}),
        }, { baseUrl });
      }

      // Карточка с прогрессом больше не нужна — убираем её, чтобы не дублировать ответ.
      if (messageId !== undefined) {
        await callWithRetry(options.token, 'deleteMessage', {
          chat_id: options.chatId,
          message_id: messageId,
        }, { baseUrl }).catch(() => {});
      }
    },

    async discard() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await chain.catch(() => {});
      if (messageId !== undefined) {
        await callWithRetry(options.token, 'deleteMessage', {
          ...base,
          message_id: messageId,
        }).catch(() => {});
      }
    },
  };
}
