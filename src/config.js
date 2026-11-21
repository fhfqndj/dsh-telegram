/**
 * Схема конфигурации плагина и чтение её в обычный объект.
 *
 * Поля volatile: значение живёт в профиле и меняется на ходу через панель,
 * поэтому читаем их через field() — ссылка отдаёт get(), обычное поле само себя.
 */

import z from '@deepseek-ai/schemastery'

import { normalizeLanguage } from './i18n.js'

export const NOTIFY_MODES = ['off', 'quiet', 'normal', 'verbose']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile()
    .description('Опрошивать бота, пока запущен Host.'),
  ownerId: z.number().default(0).volatile()
    .description('Telegram user id владельца. 0 — бот не пускает никого (fail-closed).'),
  workspacePath: z.string().default('').volatile()
    .description('Рабочий каталог для новых сессий и источник списка /sessions. Пусто — каталог последней активной сессии.'),
  notifyMode: z.string().default('normal').volatile()
    .description('off | quiet | normal | verbose — уведомления о работе, начатой не из Telegram.'),
  allowNewSessions: z.boolean().default(true).volatile()
    .description('Разрешить создавать сессии из бота.'),
  streaming: z.boolean().default(true).volatile()
    .description('Показывать ответ одной обновляемой карточкой.'),
  pairingCode: z.string().default('').volatile()
    .description('Код для подключения нового пользователя: /pair <код>. Пусто — подключение выключено.'),
  allowedUsers: z.string().default('').volatile()
    .description('Telegram user id через запятую: кому бот отвечает помимо владельца.'),
  approvalsPosture: z.union([
    z.const('ask'),
    z.const('trusted'),
    z.const('yolo'),
  ]).default('ask').volatile()
    .description('ask — спрашивать всё; trusted — разрешать чтение без вопроса; yolo — разрешать всё.'),
  approvalsAllow: z.string().default('').volatile()
    .description('Инструменты без вопроса, через запятую (например: read, glob, grep).'),
  approvalsDeny: z.string().default('').volatile()
    .description('Инструменты, которые отклоняются сразу, через запятую.'),
  retentionDays: z.number().default(30).volatile()
    .description('Сколько дней хранить записи о расходе токенов и моделях сессий (0 — не чистить).'),
  allowAnyPath: z.boolean().default(false).volatile()
    .description('Разрешить telegram_send отправлять файлы вне workspace.'),
  logMessages: z.boolean().default(false).volatile()
    .description('Писать в лог тексты сообщений (по умолчанию только длина).'),
  questions: z.boolean().default(true).volatile()
    .description('Присылать вопросы агента в Telegram с кнопками.'),
  approvals: z.boolean().default(true).volatile()
    .description('Спрашивать подтверждение инструментов кнопками в Telegram.'),
  language: z.string().default('auto').volatile()
    .description('auto | ru | en — язык ответов бота; auto берёт язык клиента Telegram.'),
  richMessages: z.boolean().default(true).volatile()
    .description('Отправлять финальные ответы rich messages.'),
  richTables: z.boolean().default(true).volatile()
    .description('Нативные таблицы в rich-сообщениях.'),
  richHeadings: z.boolean().default(false).volatile()
    .description('Нативные заголовки; выключено — жирная строка.'),
  apiBase: z.string().default('https://api.telegram.org').volatile()
    .description('Адрес Bot API. Пусто — облачный Telegram; локальный Bot API server для тестов.'),
})

/** Значение поля: volatile-ссылка отдаёт get(), обычное поле — само значение. */
export function field(ref) {
  return typeof ref?.get === 'function' ? ref.get() : ref
}

/** Список через запятую или пробел: пустые элементы не нужны. */
function splitList(value) {
  return String(field(value) ?? '').split(/[,\s]+/).filter((item) => item !== '')
}

export function readConfig(config) {
  const mode = field(config.notifyMode)
  return {
    enabled: field(config.enabled) !== false,
    ownerId: Number(field(config.ownerId) ?? 0),
    workspacePath: String(field(config.workspacePath) ?? ''),
    notifyMode: NOTIFY_MODES.includes(mode) ? mode : 'normal',
    allowNewSessions: field(config.allowNewSessions) !== false,
    streaming: field(config.streaming) !== false,
    richMessages: field(config.richMessages) !== false,
    richTables: field(config.richTables) !== false,
    richHeadings: field(config.richHeadings) === true,
    language: normalizeLanguage(field(config.language)) ?? 'auto',
    approvals: field(config.approvals) !== false,
    questions: field(config.questions) !== false,
    retentionDays: Number.isFinite(field(config.retentionDays)) ? Number(field(config.retentionDays)) : 30,
    allowAnyPath: field(config.allowAnyPath) === true,
    logMessages: field(config.logMessages) === true,
    approvalsPosture: ['ask', 'trusted', 'yolo'].includes(field(config.approvalsPosture))
      ? field(config.approvalsPosture)
      : 'ask',
    approvalsAllow: splitList(field(config.approvalsAllow)),
    approvalsDeny: splitList(field(config.approvalsDeny)),
    pairingCode: String(field(config.pairingCode) ?? '').trim(),
    allowedUsers: splitList(field(config.allowedUsers))
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
    apiBase: String(field(config.apiBase) ?? '').trim(),
  }
}
