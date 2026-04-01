/** Minimal type stubs for openclaw/plugin-sdk/core (upstream 3.1.0). */

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface OpenClawPluginToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  id?: string | number;
  channel?: string;
  chatId?: string | number;
  senderId?: string | number;
  channelId?: string;
  messageThreadId?: string | number;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
}

export interface OpenClawPluginServiceContext {
  logger: PluginLogger;
  [key: string]: unknown;
}

export interface OpenClawPluginService {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop: () => void | Promise<void>;
}

export interface OpenClawPluginRuntime {
  [key: string]: unknown;
}

// -- Interactive handler types (discriminated union on `channel`) --

interface TelegramResponder {
  editMessage(opts: { text: string; buttons?: unknown[] }): Promise<void>;
  clearButtons(): Promise<void>;
  reply(opts: { text: string }): Promise<void>;
}

interface DiscordResponder {
  clearComponents(opts?: { text?: string }): Promise<void>;
  reply(opts: { text: string; ephemeral?: boolean }): Promise<void>;
}

interface InteractiveAuth {
  isAuthorizedSender: boolean;
}

export interface TelegramInteractiveHandlerContext {
  channel: "telegram";
  respond: TelegramResponder;
  callback: { payload: string };
  auth: InteractiveAuth;
}

export interface DiscordInteractiveHandlerContext {
  channel: "discord";
  respond: DiscordResponder;
  interaction: { payload: string };
  auth: InteractiveAuth;
}

export interface InteractiveHandlerResult {
  handled: boolean;
}

export type TelegramInteractiveRegistration = {
  channel: "telegram";
  namespace: string;
  handler: (ctx: TelegramInteractiveHandlerContext) => Promise<InteractiveHandlerResult>;
};

export type DiscordInteractiveRegistration = {
  channel: "discord";
  namespace: string;
  handler: (ctx: DiscordInteractiveHandlerContext) => Promise<InteractiveHandlerResult>;
};

export type InteractiveHandlerRegistration =
  | TelegramInteractiveRegistration
  | DiscordInteractiveRegistration;

export interface OpenClawPluginApi {
  registerTool(tool: (ctx: OpenClawPluginToolContext) => unknown, options?: { optional?: boolean }): void;
  registerInteractiveHandler(handler: InteractiveHandlerRegistration): void;
  registerCommand(command: unknown): void;
  registerService(service: OpenClawPluginService): void;
  runtime: OpenClawPluginRuntime;
  pluginConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginEntryDefinition {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
}

export function definePluginEntry(def: PluginEntryDefinition): PluginEntryDefinition;
