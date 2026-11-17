// Type definitions for Plugin Harness plugins (apiVersion 1).
// Copy next to your plugin and reference it with:
//   /** @type {import('./harness').Plugin} */
// to get editor completion. Plugins need no runtime dependency on the host.

export interface HostLog {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface Host {
  /** Plugin id from plugin.json */
  id: string;
  version: string;
  hostVersion: string;
  apiVersion: number;
  /** Current settings (defaults merged with user values). Updated in place on change. */
  config: Record<string, any>;
  /** Absolute path of the user's workspace (access still requires fs permissions). */
  workspace: string;
  /** Private, always-writable directory for this plugin's own data. */
  dataDir: string;
  /** Effective (granted) permissions, with ${workspace}/${pluginData} resolved. */
  permissions: { 'fs.read': string[]; 'fs.write': string[]; network: string[]; secrets: string[] };
  log: HostLog;
  /** Same as global fetch(): proxied by the host and checked against `network` grants. */
  fetch: typeof fetch;
  secrets: { get(name: string): Promise<string | null> };
  onConfigChange(cb: (config: Record<string, any>) => void | Promise<void>): void;
}

export interface CallContext {
  host: Host;
  log: HostLog;
  /** Aborted when the host times out or cancels the call. */
  signal: AbortSignal;
  /** Stream a progress line to the UI (tools only). */
  progress(message: string): void;
}

export type ToolResult =
  | string
  | { content: string; data?: unknown; display?: { type: 'table'; columns: string[] } | { type: 'card'; labels?: Record<string, string> } };

export interface HookResult<P> {
  /** Partial payload merged into the event payload. */
  payload?: Partial<P>;
  /** Stop the action (e.g. block a tool call). */
  block?: boolean;
  reason?: string;
  /** Short note shown in the chat transcript. */
  note?: string;
}

export interface NeutralMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: { id: string; name: string; input: any }[];
  results?: { toolCallId: string; name: string; content: string; isError: boolean }[];
  raw?: any;
}

export interface ProviderRequest {
  system: string;
  messages: NeutralMessage[];
  tools: { name: string; description: string; input_schema: object; patterns: string[]; examples: string[] }[];
}

export type ProviderResult =
  | { type: 'text'; text: string; raw?: any; usage?: any }
  | { type: 'tool_calls'; calls: { id: string; name: string; input: any }[]; text?: string; raw?: any; usage?: any };

export interface Plugin {
  activate?(host: Host): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  tools?: Record<string, (input: any, ctx: CallContext) => ToolResult | Promise<ToolResult>>;
  hooks?: {
    'chat.userMessage'?(p: { text: string }, ctx: CallContext): HookResult<{ text: string }> | Promise<HookResult<{ text: string }>>;
    'tool.beforeCall'?(p: { tool: string; pluginId: string; input: any }, ctx: CallContext): HookResult<{ input: any }> | Promise<HookResult<{ input: any }>>;
    'tool.afterCall'?(p: { tool: string; pluginId: string; input: any; result: { content: string; data?: any } }, ctx: CallContext): HookResult<{ result: any }> | Promise<HookResult<{ result: any }>>;
  };
  providers?: Record<string, { complete(req: ProviderRequest, ctx: CallContext): Promise<ProviderResult> }>;
}
