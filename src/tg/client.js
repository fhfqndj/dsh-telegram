/**
 * Минимальный клиент Telegram Bot API на встроенном fetch (Node 26+).
 * Без зависимостей: JSON-запросы, разбор ошибок, повторы с учётом retry_after.
 */

const API_ROOT = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(method, status, body) {
    const description = body?.description ?? '';
    super(`${method}: HTTP ${status}${description ? ` ${description}` : ''}`);
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.body = body ?? {};
  }

  /** Секунды, которые просит Telegram при 429. */
  get retryAfter() {
    const value = this.body?.parameters?.retry_after;
    return typeof value === 'number' ? value : undefined;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Один вызов метода Bot API.
 * @param {string} token
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [options]
 */
export async function call(token, method, params = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = String(options.baseUrl ?? API_ROOT).replace(/\/+$/, '');
  // Без явного сигнала любой вызов ограничен по времени: зависший TCP не должен
  // блокировать поллер и доставку.
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });

  const body = await response.json().catch(() => undefined);
  if (!body?.ok) throw new TelegramError(method, response.status, body);
  return body.result;
}

/**
 * Вызов с политикой повторов: 429 ждёт retry_after, 5xx — экспоненциальный backoff,
 * 400/403/409 отдаются наверх как есть (это не «мигающая» ошибка).
 */
export async function callWithRetry(token, method, params = {}, options = {}) {
  const { attempts = 5, fetchImpl } = options;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call(token, method, params, {
        signal: options.signal,
        fetchImpl,
        baseUrl: options.baseUrl,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      if (!(error instanceof TelegramError)) throw error;

      const canRetry = attempt < attempts;
      if (error.status === 429 && canRetry) {
        await sleep((error.retryAfter ?? 1) * 1000 + 200);
        continue;
      }
      if (error.status >= 500 && canRetry) {
        await sleep(Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 300);
        continue;
      }
      throw error;
    }
  }
}
