/** Minimal type stubs for openclaw/plugin-sdk/telegram-core (upstream 3.1.0). */

export interface TelegramTopicConversation {
  chatId: string;
  topicId?: string;
}

export function parseTelegramTopicConversation(opts: {
  conversationId: string;
}): TelegramTopicConversation;
