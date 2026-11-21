
export const access = {
isAllowed(fromId, owner = this.ownerId()) {
  if (fromId === owner) return true
  return this.cfg().allowedUsers.includes(fromId)
},

/** Чат замьючен: ответы и карточки не идут, вопросы и подтверждения — идут. */
muted(chatId, threadId) {
  const flags = this.state.mute
  if (flags === undefined || flags === null) return false
  return flags[this.bindingKey(chatId, threadId)] === true
},

/** Включены ли уведомления в этом чате. */
notifyEnabled(chatId, threadId) {
  const flags = this.state.notify
  if (flags === undefined || flags === null) return false
  return flags[this.bindingKey(chatId, threadId)] === true
},

notificationTargets() {
  const targets = []
  for (const [key, enabled] of Object.entries(this.state.notify ?? {})) {
    if (enabled !== true) continue
    const [chatId, threadId] = key.split(':')
    targets.push({
      chatId: Number(chatId),
      threadId: Number(threadId) > 0 ? Number(threadId) : undefined,
    })
  }
  return targets
},

bindingKey(chatId, threadId) {
  return `${chatId}:${threadId ?? 0}`
},

bindingFor(chatId, threadId) {
  return this.state.bindings[this.bindingKey(chatId, threadId)]
},

async bind(chatId, threadId, sessionId) {
  this.state.bindings[this.bindingKey(chatId, threadId)] = { sessionId }
  await this.saveState()
},

boundChats(sessionId) {
  const chats = []
  for (const [key, binding] of Object.entries(this.state.bindings)) {
    if (binding?.sessionId !== sessionId) continue
    const [chatId, threadId] = key.split(':')
    chats.push({
      chatId: Number(chatId),
      threadId: Number(threadId) > 0 ? Number(threadId) : undefined,
    })
  }
  return chats
},

boundChat(sessionId) {
  return this.boundChats(sessionId)[0]
},

startTypingPulse(sessionId, chatId, threadId) {
  if (this.typingPulse.has(sessionId)) return
  const timer = setInterval(() => { void this.typing(chatId, threadId) }, 4000)
  this.typingPulse.set(sessionId, timer)
  this.typing(chatId, threadId)
},

stopTypingPulse(sessionId) {
  const timer = this.typingPulse.get(sessionId)
  if (timer === undefined) return
  clearInterval(timer)
  this.typingPulse.delete(sessionId)
},

rememberAssistant(sessionId, turn, text) {
  this.lastAssistant.delete(sessionId)
  this.lastAssistant.set(sessionId, { turn, text })
  if (this.lastAssistant.size > 200) {
    this.lastAssistant.delete(this.lastAssistant.keys().next().value)
  }
}

}
