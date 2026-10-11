// Typed bindings for the Rust commands in src-tauri/src/commands.rs.
// The types mirror sush-core's serde shapes (camelCase fields, kebab-case tags).

import { Channel, invoke } from "@tauri-apps/api/core";

export type WireFormat = "openai-chat" | "anthropic-messages";

export type AuthKind = { type: "none" } | { type: "api-key"; header?: string | null };

export interface ProviderConfig {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  auth: AuthKind;
  headers: Record<string, string>;
  models: string[];
}

export interface ProviderView extends ProviderConfig {
  hasKey: boolean;
}

export interface ModelInfo {
  id: string;
  displayName?: string | null;
}

export type CorePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "document"; mediaType: string; data: string; name?: string | null }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; callId: string; output: unknown; isError?: boolean };

export interface CoreMessage {
  role: "system" | "user" | "assistant";
  parts: CorePart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ChatRequest {
  model: string;
  messages: CoreMessage[];
  system?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  tools?: ToolSpec[];
  /** Provider-run web search and fetch (Anthropic only). */
  research?: boolean;
}

export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "other";

export type ChatEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-delta"; index: number; id?: string | null; name?: string | null; argsDelta: string }
  | { type: "usage"; inputTokens?: number | null; outputTokens?: number | null }
  | { type: "server-tool-call"; id: string; name: string; input: unknown }
  | { type: "web-sources"; callId: string; sources: { url: string; title?: string | null }[] }
  | { type: "citation"; url: string; title?: string | null }
  | { type: "finish"; reason: FinishReason }
  | { type: "error"; message: string };

export interface ServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Where a connector's MCP server lives: a local process or a URL. */
export type ServerSpec =
  | ({ type: "stdio" } & ServerCommand)
  | { type: "http"; url: string; oauthClientId?: string | null };

export interface McpTool {
  name: string;
  description?: string | null;
  inputSchema: unknown;
  /** The server's hints about what the tool does (MCP tool annotations). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
}

export type ConnectOutcome =
  | { state: "ready"; serverName?: string | null; tools: McpTool[] }
  /** `rejected`: why the server turned down the saved sign-in, if there was one. */
  | { state: "needs-auth"; rejected?: string | null };

/** A device-flow sign-in: type `userCode` at `verificationUri` (connector_auth.rs). */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
}

/** Redirect port for user-supplied OAuth clients (connector_auth.rs). */
export const CUSTOM_CLIENT_REDIRECT = "http://localhost:33418/callback";

export interface ToolOutput {
  text: string;
  isError: boolean;
}

export interface Folder {
  name: string;
  files: { path: string; content: string }[];
  skipped: number;
  truncated: boolean;
}

export interface PluginItem {
  name: string;
  description?: string | null;
  text: string;
}

export interface Plugin {
  dir: string;
  name: string;
  version?: string | null;
  description?: string | null;
  skills: PluginItem[];
  designSystems: PluginItem[];
  connectors: (ServerCommand & { name: string })[];
}

/** A stored conversation (`sush_core::store::Thread`). Messages are the UI's own JSON. */
export interface StoredThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  target?: { providerId: string; model: string };
  pinned?: boolean;
  messages: unknown[];
}

export type ThreadMeta = Omit<StoredThread, "messages">;

export interface ChatHit {
  id: string;
  title: string;
  updatedAt: number;
  snippet: string;
}

export interface StoredMemoryFile {
  path: string;
  title: string;
  description: string;
  content: string;
  updatedAt: number;
}

/** A change to a thread's messages (`sush_core::agent::Op`); all but reset/push target the last message. */
export type ThreadOp =
  | { type: "reset"; messages: unknown[] }
  | { type: "push"; message: unknown }
  | { type: "push-part"; part: unknown }
  | { type: "append-text"; index: number; delta: string }
  | { type: "set-part"; index: number; part: unknown }
  | { type: "set-metadata"; metadata: Record<string, unknown> };

export type RunStatus = "submitted" | "streaming" | "awaiting" | "ready" | "error";

export type RunFrame =
  | { type: "op"; threadId: string; op: ThreadOp }
  | { type: "status"; threadId: string; status: RunStatus; error: string | null }
  | { type: "tool-running"; threadId: string; callId: string; running: boolean }
  | { type: "client-tool"; threadId: string; callId: string; name: string; input: unknown }
  | { type: "saved"; thread: ThreadMeta };

export interface LiveRun {
  threadId: string;
  thread: ThreadMeta;
  messages: unknown[];
  status: RunStatus;
  error: string | null;
}

export type ToolResponse = { type: "approve" } | { type: "output"; output: unknown } | { type: "error"; errorText: string };

export type RunAction =
  | { type: "send"; message: unknown; replace: string | null }
  | { type: "regenerate"; messageId: string | null }
  | { type: "respond"; callId: string; response: ToolResponse };

export interface RunTool extends ToolSpec {
  exec: { type: "connector"; connectorId: string; tool: string } | { type: "client" };
  approval: "auto" | "ask";
}

export interface RunConfig {
  providerId: string;
  model: string;
  system: string | null;
  tools: RunTool[];
  research: boolean;
  /** Text sent to the model in place of a user message's first text, by message id. */
  expansions: Record<string, string>;
}

export type StreamFrame = { type: "event"; event: ChatEvent } | { type: "end" };

/** How a provider transcribes: OpenAI-style `/audio/transcriptions`, or Ollama chat with an audio-capable model. */
export type TranscribeApi = "transcriptions" | "ollama-chat";

export const api = {
  listPresets: () => invoke<ProviderConfig[]>("list_presets"),
  listProviders: () => invoke<ProviderView[]>("list_providers"),
  saveProvider: (config: ProviderConfig, apiKey?: string) =>
    invoke<ProviderView>("save_provider", { config, apiKey: apiKey || null }),
  deleteProvider: (id: string) => invoke<void>("delete_provider", { id }),
  listModels: (providerId: string) => invoke<ModelInfo[]>("list_models", { providerId }),
  chatStream: (streamId: string, providerId: string, request: ChatRequest, onEvent: Channel<StreamFrame>) =>
    invoke<void>("chat_stream", { streamId, providerId, request, onEvent }),
  cancelStream: (streamId: string) => invoke<void>("cancel_stream", { streamId }),
  runsSubscribe: (onFrame: Channel<RunFrame>) => invoke<LiveRun[]>("runs_subscribe", { onFrame }),
  runStart: (thread: ThreadMeta, action: RunAction, config: RunConfig) => invoke<void>("run_start", { thread, action, config }),
  runCancel: (threadId: string) => invoke<void>("run_cancel", { threadId }),
  toolResult: (callId: string, result: { output: unknown } | { errorText: string }) => invoke<void>("tool_result", { callId, result }),
  threadsLoad: () => invoke<StoredThread[]>("threads_load"),
  /** Without `messages`, only the metadata (title, pin, model) is updated. */
  threadSave: (thread: ThreadMeta, messages: unknown[] | null) => invoke<void>("thread_save", { thread, messages }),
  threadDelete: (id: string) => invoke<void>("thread_delete", { id }),
  threadsImport: (threads: StoredThread[]) => invoke<number>("threads_import", { threads }),
  blobPut: (dataUrl: string) => invoke<string>("blob_put", { dataUrl }),
  chatsSearch: (query: string, limit: number) => invoke<ChatHit[]>("chats_search", { query, limit }),
  memoryList: () => invoke<StoredMemoryFile[]>("memory_list"),
  memoryWrite: (file: StoredMemoryFile) => invoke<void>("memory_write", { file }),
  memoryDelete: (path: string) => invoke<boolean>("memory_delete", { path }),
  memoryClear: () => invoke<void>("memory_clear"),
  readFolder: (path: string) => invoke<Folder>("read_folder", { path }),
  saveTextFile: (path: string, contents: string) => invoke<void>("save_text_file", { path, contents }),
  loadPlugin: (path: string) => invoke<Plugin>("load_plugin", { path }),
  connectorConnect: (id: string, server: ServerSpec) => invoke<ConnectOutcome>("connector_connect", { id, server }),
  /** `callId` lets `connectorCancelCall` stop it. */
  connectorDisconnect: (id: string) => invoke<void>("connector_disconnect", { id }),
  /** Disconnect and delete the connector's stored credentials. */
  connectorForget: (id: string) => invoke<void>("connector_forget", { id }),
  /** Sign in through the browser; resolves when the browser comes back. Servers
   *  that sign in with a typed code (GitHub) call `onCode` with it first. */
  connectorAuthorize: (id: string, url: string, clientId: string | null | undefined, onCode: (code: DeviceCode) => void) => {
    const channel = new Channel<DeviceCode>();
    channel.onmessage = onCode;
    return invoke<void>("connector_authorize", { id, url, clientId: clientId || null, onCode: channel });
  },
  connectorCancelAuthorize: (id: string) => invoke<void>("connector_cancel_authorize", { id }),
  /** `undefined` keeps a stored value, `""` clears it. */
  connectorSaveSecrets: (id: string, url: string, secrets: { token?: string; clientSecret?: string }) =>
    invoke<void>("connector_save_secrets", { id, url, token: secrets.token ?? null, clientSecret: secrets.clientSecret ?? null }),
  transcribe: (providerId: string, model: string, api: TranscribeApi, audioBase64Wav: string) =>
    invoke<string>("transcribe", { providerId, model, api, audioBase64Wav }),
  whisperModelStatus: () => invoke<{ downloaded: boolean; sizeBytes: number }>("whisper_model_status"),
  whisperModelDownload: (onProgress: Channel<{ received: number; total: number }>) =>
    invoke<void>("whisper_model_download", { onProgress }),
  transcribeLocal: (audioBase64Wav: string) => invoke<string>("transcribe_local", { audioBase64Wav }),
};

/** Commands reject with the Rust error's message string. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
