/**
 * core: часть TelegramBridge, подключается миксином к прототипу.
 */
import { readConfig } from '../config.js'
import { languageFromTelegram, translate } from '../i18n.js'
import { TOKEN_REF } from './kernel.js'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const core = {
apiBase() {
  const configured = this.cfg().apiBase
  return configured === '' ? undefined : configured
},

signal() {
  return this.calls.signal
},

cfg() {
  return readConfig(this.config)
},

/**
 * Язык чата: явный выбор, иначе настройка панели, иначе язык клиента Telegram.
 *
 * Определённый язык клиента лежит в langDetected: раньше он писался в state.lang,
 * где /lang хранит явный выбор, и настройка панели не действовала никогда.
 */
langFor(chatId, threadId, telegramCode) {
  const key = this.bindingKey(chatId, threadId)
  const explicit = this.state.lang?.[key]
  if (explicit !== undefined) return explicit
  const configured = this.cfg().language
  if (configured === 'ru' || configured === 'en') return configured
  const detected = this.state.langDetected?.[key]
  if (detected !== undefined) return detected
  return languageFromTelegram(telegramCode)
},

say(chatId, threadId, key, params) {
  return translate(this.langFor(chatId, threadId), key, params)
},

/** Внутренняя ошибка обработчика: в лог, но не в Host. */
internalError(where, error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  this.log.error(`${where}: ${message}`)
  this.ctx.logger.warn('telegram: %s failed: %s', where, message)
},

async loadState() {
  if (this.loaded) return
  this.loaded = true
  try {
    const raw = JSON.parse(await readFile(this.stateFile, 'utf8'))
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      // Берём файл целиком: состояние пишут и usage, и model, и mute —
      // белый список полей раньше терял их при каждом рестарте.
      this.state = { bindings: {}, notify: {}, lang: {}, ownerId: 0, ...raw }
      // До langVersion 2 определённый язык клиента лежал в state.lang вместе
      // с явным /lang. Переносим его в langDetected, иначе настройка панели
      // останется перекрытой у всех, кто хоть раз писал боту. Отличить явный
      // выбор от определённого в старом файле нельзя — выбранный вручную /lang
      // придётся задать заново, это оговорено в PR.
      if ((Number(raw.langVersion) || 0) < 2) {
        this.state.langDetected = { ...(raw.lang ?? {}), ...(this.state.langDetected ?? {}) }
        this.state.lang = {}
        this.state.langVersion = 2
        this.stateMigrated = true
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      this.ctx.logger.warn('telegram: state read failed: %s', String(error))
    }
  }
  await chmod(this.stateFile, 0o600).catch(() => {})
  if (this.stateMigrated === true) {
    this.stateMigrated = false
    await this.saveState()
  }
},

/**
 * Сохраняет состояние, но не чаще раза в секунду: поллер зовёт это на каждый апдейт.
 * Возвращает промис последней записи, чтобы тесты и dispose могли дождаться.
 */
saveStateSoon() {
  if (this.saveTimer !== undefined) return this.saveChain
  this.saveTimer = setTimeout(() => {
    this.saveTimer = undefined
    void this.saveState()
  }, 1000)
  this.saveTimer.unref?.()
  return this.saveChain
},

saveState() {
  const snapshot = JSON.stringify(this.state)
  this.saveChain = this.saveChain
    .then(async () => {
      const dir = path.dirname(this.stateFile)
      await mkdir(dir, { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      // tmp + rename: на POSIX rename атомарен, окно потери данных не нужно.
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.stateFile)
    })
    .catch((error) => this.ctx.logger.warn('telegram: state save failed: %s', String(error)))
  return this.saveChain
},

async persistConfig(patch) {
  const editor = this.ctx.get('configEditor')
  if (editor === undefined) return false
  const entry = editor.entries?.().find((row) => row.options?.id === 'telegram')
  if (entry === undefined) return false
  try {
    await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }))
    return true
  } catch (error) {
    this.ctx.logger.warn('telegram: config write failed: %s', String(error))
    return false
  }
},

ownerId() {
  const configured = this.cfg().ownerId
  return configured > 0 ? configured : this.state.ownerId
},

async token() {
  // Кэш на время жизни объекта: credentials дёргались ~10 раз на одно сообщение.
  if (this.tokenCache !== undefined) return this.tokenCache
  try {
    const resolved = await this.ctx.credentials.resolve(TOKEN_REF)
    this.tokenCache = resolved?.value
    return this.tokenCache
  } catch {
    return undefined
  }
}
}
