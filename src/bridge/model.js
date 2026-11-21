/**
 * model: часть TelegramBridge, подключается миксином к прототипу.
 */
import { escapeHtml } from '../tg/html.js'

export const model = {
async modelCatalog() {
  const llm = this.llm
  if (llm === undefined) return []
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const groups = []
  for (const provider of providers) {
    const id = typeof provider === 'string' ? provider : provider?.id
    if (typeof id !== 'string' || id === '') continue
    try {
      const models = await llm.listModels(id)
      const names = (models ?? [])
        .map((model) => (typeof model === 'string' ? model : model?.id))
        .filter((name) => typeof name === 'string' && name !== '')
      if (names.length > 0) groups.push({ provider: id, models: names })
    } catch (error) {
      this.log.warn(`model catalog ${id}: ${String(error)}`)
    }
  }
  return groups
},

async modelPicker(chatId, threadId, argument) {
  const binding = this.bindingFor(chatId, threadId)
  if (binding?.sessionId === undefined) {
    await this.send(chatId, this.say(chatId, threadId, 'modelNeedSession'), threadId)
    return
  }
  if (argument !== '') {
    const slash = argument.indexOf('/')
    if (slash === -1) {
      await this.send(chatId, this.say(chatId, threadId, 'modelUsage'), threadId)
      return
    }
    await this.applyModel(chatId, threadId, binding.sessionId, argument.slice(0, slash), argument.slice(slash + 1))
    return
  }

  const groups = (await this.modelCatalog()).slice(0, 6)
  const flat = groups.flatMap((group) => group.models.map((model) => ({ provider: group.provider, model }))).slice(0, 10)
  if (flat.length === 0) {
    await this.send(chatId, this.say(chatId, threadId, 'modelEmpty'), threadId)
    return
  }
  this.modelButtons.set(this.bindingKey(chatId, threadId), { at: Date.now(), items: flat })

  const current = this.state.model?.[binding.sessionId]
  const currentLabel = current === undefined
    ? this.say(chatId, threadId, 'modelUnknown')
    : `${current.provider}/${current.model}`
  const keyboard = flat.map((item, index) => [{
    text: `${current !== undefined && current.provider === item.provider && current.model === item.model ? '• ' : ''}${item.provider}/${item.model}`.slice(0, 60),
    callback_data: `md:${index}`,
  }])
  await this.send(
    chatId,
    this.say(chatId, threadId, 'modelTitle', { current: escapeHtml(currentLabel) }),
    threadId,
    { inline_keyboard: keyboard },
  )
},

async selectModelByIndex(chatId, threadId, index) {
  const list = this.modelButtons.get(this.bindingKey(chatId, threadId))
  const item = list?.items?.[index]
  if (item === undefined) {
    await this.send(chatId, this.say(chatId, threadId, 'modelExpired'), threadId)
    return
  }
  const binding = this.bindingFor(chatId, threadId)
  if (binding?.sessionId === undefined) return
  await this.applyModel(chatId, threadId, binding.sessionId, item.provider, item.model)
},

async applyModel(chatId, threadId, sessionId, provider, model) {
  try {
    await this.ctx.sessionController.selectModel({ sessionId, provider, model })
    this.state.model = this.state.model ?? {}
    this.state.model[sessionId] = { provider, model }
    await this.saveState()
    this.log.info(`model ${sessionId}: ${provider}/${model}`)
    await this.send(chatId, this.say(chatId, threadId, 'modelSwitched', {
      model: escapeHtml(`${provider}/${model}`),
    }), threadId)
  } catch (error) {
    this.log.warn(`model ${provider}/${model}: ${String(error)}`)
    await this.send(chatId, this.say(chatId, threadId, 'modelFailed', {
      error: escapeHtml(String(error?.message ?? error)),
    }), threadId)
  }
}

/** Текст /cost: расход текущей сессии и суммарный. */
}
