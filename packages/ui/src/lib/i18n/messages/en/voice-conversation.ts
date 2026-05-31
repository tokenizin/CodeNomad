const messages: Record<string, string> = {
  "voiceConversation.button.idle": "Start voice conversation",
  "voiceConversation.button.listening": "Listening...",
  "voiceConversation.button.speaking": "Speaking...",
  "voiceConversation.button.paused": "Paused — tap to resume",
  "voiceConversation.button.connecting": "Connecting...",
  "voiceConversation.button.error": "Error — tap to retry",
  "voiceConversation.button.stop": "End conversation",
  "voiceConversation.button.endTitle": "End voice conversation",
  "voiceConversation.error.microphone": "Microphone access is required for voice conversation.",
  "voiceConversation.error.connection": "Failed to connect to voice service.",
  "voiceConversation.error.apiKey": "Speech API key is not configured.",
  "voiceConversation.error.restore": "Could not restore previous session recording.",
  "voiceConversation.error.upload": "Failed to save session recording.",
  "voiceConversation.settings.autoPostTranscript": "Auto-post transcript to chat",
  "voiceConversation.settings.autoRestoreSession": "Auto-restore previous session",
  "voiceConversation.session.restored": "Previous session restored — {count} message(s)",
}

export const voiceConversationMessages = messages
