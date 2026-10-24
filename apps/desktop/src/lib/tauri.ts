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
  /** Set for Cowork sessions: the workspace they work in. */
  workspaceId?: string;
  /** The project it's filed under (`lib/projects.ts`). */
  projectId?: string;
  /** Never written to disk; Rust keeps its messages in memory until it's deleted. */
  incognito?: boolean;
  /** Set for a sub-agent's thread: the session whose run started it (`sush_core::agent::subagents`). */
  parentId?: string;
  messages: unknown[];
}

export type ThreadMeta = Omit<StoredThread, "messages">;

/** What the agent may do in a workspace (`sush_core::workspace::Access`). */
export type WorkspaceAccess = "read-only" | "workspace-write";
/** When file changes need approval; shell commands always do. */
export type EditApproval = "ask" | "auto-edits";

/** A folder the user granted for Cowork (`sush_core::workspace::Workspace`). */
export interface Workspace {
  id: string;
  name: string;
  root: string;
  access: WorkspaceAccess;
  approval: EditApproval;
  createdAt: number;
}

export interface WorkspaceEntry {
  name: string;
  /** Relative to the workspace, with forward slashes. */
  path: string;
  dir: boolean;
  size: number;
}

/** Files one turn of a Cowork session changed; `turnId` is the user message that started it. */
export interface TurnChanges {
  turnId: string;
  paths: string[];
}

/** A workspace folder's git state (`sush_core::workspace::git`). */
export interface GitInfo {
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
  branches: string[];
  /** The folder is a linked worktree rather than the main checkout. */
  worktree: boolean;
}

/** The workspace's branch against the branch it merges into (`sush_core::workspace::git::BranchStatus`). */
export interface BranchStatus {
  branch: string | null;
  base: string;
  /** The commit HEAD points at. */
  head: string;
  /** The user's git name, so their commits can read "You". */
  you: string | null;
  ahead: number;
  behind: number;
  /** Everything the branch changes since it left the base, uncommitted work included. */
  files: number;
  additions: number;
  deletions: number;
  uncommitted: number;
  /** A merge in progress, with the files still conflicted. */
  merging: { unresolved: string[] } | null;
  /** What merging the base in would conflict on; null when that can't be told. */
  conflicts: BranchConflict[] | null;
  /** Both sides' commits since they split, newest first, then the commit they split from. */
  commits: GraphCommit[];
  more: boolean;
}

export interface BranchConflict {
  path: string;
  /** Who last changed the file on the base. */
  by: string | null;
  hunks: { line: number; ours: string[]; theirs: string[] }[];
}

export interface GraphCommit {
  sha: string;
  parents: string[];
  author: string;
  /** Seconds since the epoch. */
  time: number;
  /** Local branches pointing at it. */
  refs: string[];
  subject: string;
  /** The base has it. */
  onBase: boolean;
}

/** The repository's history for the graph panel (`sush_core::workspace::git::GitLog`). */
export interface GitLog {
  branch: string | null;
  /** null before the first commit. */
  head: string | null;
  you: string | null;
  uncommitted: number;
  commits: LogCommit[];
  more: boolean;
}

export interface LogCommit {
  sha: string;
  parents: string[];
  author: string;
  /** Seconds since the epoch. */
  time: number;
  refs: GitRef[];
  subject: string;
}

export interface GitRef {
  /** `main`, `origin/main`, `v2.1.0`. */
  name: string;
  kind: "branch" | "remote" | "tag";
  /** HEAD points at this branch. */
  head: boolean;
}

/** A commit opened in the graph. */
export interface CommitDetail {
  sha: string;
  author: string;
  email: string;
  time: number;
  message: string;
  files: CommitFile[];
}

export interface CommitFile {
  /** Relative to the repository's top folder. */
  path: string;
  /** Relative to the workspace folder, when the file is inside it. */
  local: string | null;
  /** null for a binary file. */
  additions: number | null;
  deletions: number | null;
}

/** A file a turn changed (`workspaces.rs`); `null` content means the file didn't exist. */
export interface FileDiff {
  path: string;
  before: string | null;
  after: string | null;
  /** Not text, or too big to diff; no content is sent. */
  binary: boolean;
}

export interface UndoResult {
  restored: string[];
  failed: string[];
}

/** Whether Cowork commands run in an OS sandbox here (`sush_core::workspace::sandbox`). */
export interface SandboxStatus {
  /** "Seatbelt", "bubblewrap" or "restricted token". */
  mechanism: string;
  /** Its self-test passed: writes outside the workspace are refused. */
  available: boolean;
  networkBlocked: boolean;
  detail: string;
}

/** What the built-in browser shows (`browser.rs`). */
export interface BrowserPage {
  url: string;
  title: string;
  loading: boolean;
}

/** `reveal`: the agent is using the browser, so the pane should show. */
export type BrowserEvent = ({ type: "page" } & BrowserPage) | { type: "reveal" };

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A workspace file for the viewer; `text` is null for binary files. */
export interface FileView {
  path: string;
  text: string | null;
  size: number;
  truncated: boolean;
}

/** From the Cowork terminal: output (`error` for stderr), a prompt once a command finished, or the shell exiting. */
export type TerminalEvent =
  | { kind: "output"; text: string; error: boolean }
  | { kind: "prompt"; cwd: string }
  | { kind: "exit" };

/** A file or folder completing the word typed at the Cowork terminal's prompt (Tab). */
export interface TerminalCompletion {
  name: string;
  dir: boolean;
}

export interface TerminalInfo {
  id: string;
  shell: "powershell" | "bash" | "sh";
}

export type ReportKind = "security" | "review" | "wiki";

/** What a report covers (`sush_core::reports::Scope`). */
export type ReportScope =
  | { type: "project" }
  | { type: "uncommitted" }
  /** The current branch's commits since it left `base`. */
  | { type: "branch"; base: string }
  | { type: "pull-request"; repo: string; number: number };

export type ReportStatus = "running" | "done" | "stopped" | "failed";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** Relative to the workspace folder. */
  file?: string;
  line?: number;
  /** Markdown. */
  description: string;
  /** Markdown. */
  suggestion?: string;
}

export interface WikiPage {
  slug: string;
  title: string;
  /** Markdown. */
  content: string;
  updatedAt: number;
}

/** A security review, code review or wiki of a workspace (`sush_core::reports::Report`). */
export interface Report {
  id: string;
  workspaceId: string;
  kind: ReportKind;
  scope: ReportScope;
  title: string;
  /** The thread its latest run is on. */
  threadId: string;
  /** A wiki's question thread. */
  askThreadId?: string;
  status: ReportStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** When the latest run began. */
  runStartedAt: number;
  /** HEAD when the latest run began. */
  commit?: string;
  summary?: string;
  findings: Finding[];
  /** In reading order. */
  pages: WikiPage[];
}

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
  | { type: "saved"; thread: ThreadMeta }
  | { type: "files-changed"; threadId: string; workspaceId: string }
  | { type: "report"; report: Report }
  | { type: "share"; share: ShareView }
  | { type: "share-gone"; threadId: string }
  /** Build the config for a run someone in a shared session starts; answer with `shareConfigResult`. */
  | { type: "share-config"; requestId: string; threadId: string; action: "steer" | "respond" | "resume" };

// --- shared sessions (`share.rs`, `sush_core::share`) --------------------------------

/** A joined share's thread is `shared:<share id>`; its sub-agents' are `shared:<share id>:<call id>`. */
export const isSharedThread = (id: string) => id.startsWith("shared:");

export type ShareRole = "owner" | "driver" | "collaborator" | "viewer";

export interface ShareMember {
  userId: string;
  name: string;
  /** A `data:` image or a built-in avatar id. */
  image?: string | null;
  role: ShareRole;
  online: boolean;
}

/** Someone connected to a share's room; `email` only for someone waiting to be let in. */
export interface SharePeer {
  peerId: string;
  userId: string;
  name: string;
  image?: string | null;
  isHost: boolean;
  email?: string;
}

export interface SharePolicy {
  /** Guests may list the folder and open any file in it (secret-looking ones never). */
  browseFiles: boolean;
  /** Approvals the driver may answer for the owner. */
  delegation: ShareDelegation;
}

/** Kinds of approval the owner hands to the driver (`sush_core::share::Delegation`). Secret reads never. */
export interface ShareDelegation {
  edits: boolean;
  shell: boolean;
  /** Commands with network or outside the sandbox, and merges into another branch. */
  escalated: boolean;
  connectors: boolean;
  browser: boolean;
}

/** Someone in a shared session, as messages and answers credit them (`sush_core::agent::Author`). */
export interface ShareAuthor {
  userId: string;
  name: string;
  image?: string | null;
}

/** A collaborator's message waiting for the driver or the owner. */
export interface ShareSuggestion {
  id: string;
  author: ShareAuthor;
  text: string;
  /** Image attachments, as file parts. */
  files: { type: "file"; mediaType: string; url: string; filename?: string }[];
  at: number;
}

export interface ShareComment {
  id: string;
  author: ShareAuthor;
  text: string;
  messageId?: string | null;
  at: number;
}

export type ShareAuditKind =
  | "joined"
  | "left"
  | "steered"
  | "suggested"
  | "accepted"
  | "dropped"
  | "approved"
  | "denied"
  | "answered"
  | "interrupted"
  | "stopped"
  | "resumed"
  | "commented"
  | "role"
  | "kicked"
  | "denied-intent"
  | "ended";

export interface ShareAuditEntry {
  at: number;
  actorUserId: string;
  actorName: string;
  kind: ShareAuditKind;
  detail: Record<string, unknown> | null;
}

export interface ShareThreadInfo {
  title: string;
  kind: "chat" | "cowork";
  workspaceName?: string | null;
  hostName: string;
}

export type ShareLinkStatus = "connecting" | "live" | "lobby" | "offline" | "ended";

/** A share hosted here (`role: "owner"`) or joined. */
export interface ShareView {
  threadId: string;
  shareId: string;
  role: ShareRole;
  status: ShareLinkStatus;
  thread: ShareThreadInfo;
  members: ShareMember[];
  /** People waiting to be let in (the host's view only). */
  lobby: SharePeer[];
  policy: SharePolicy;
  expiresAt: number;
  ended: string | null;
  error: string | null;
  /** This app's user on the relay. */
  me: string | null;
  suggestions: ShareSuggestion[];
  comments: ShareComment[];
  /** The latest entries of the audit log, oldest first. */
  audit: ShareAuditEntry[];
}

export interface ShareAccount {
  relayUrl: string | null;
  user: { id: string; name: string; email: string; image?: string | null } | null;
  error: string | null;
}

/** `link` is shown once, to copy: its token is after the `#`. */
export interface InviteLink {
  inviteId: string;
  link: string;
  expiresAt: number;
  maxUses: number;
}

export interface InviteInfo {
  inviteId: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked: boolean;
  roleCap: "viewer" | "collaborator";
}

/** An image a guest attaches to a message, base64 without the `data:` prefix. */
export interface ShareImage {
  mediaType: string;
  data: string;
  filename?: string;
}

/** What a guest may ask a share's host for (`sush_core::share::Intent`). The host checks each against their role. */
export type ShareIntent =
  | { kind: "get-turn-changes" }
  | { kind: "get-diff"; turnId: string }
  | { kind: "get-file"; path: string }
  | { kind: "list-dir"; path: string }
  | { kind: "get-blob"; sha: string }
  | { kind: "steer"; text: string; images: ShareImage[] }
  | { kind: "suggestion-accept"; id: string; text?: string | null }
  | { kind: "suggestion-drop"; id: string }
  | { kind: "send-now" }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "respond"; child?: string | null; callId: string; decision: "approve" | "deny"; answer?: unknown }
  | { kind: "comment"; text: string; messageId?: string | null };

export interface SharesState {
  shares: ShareView[];
  /** Joined shares' threads as they stand. */
  threads: { threadId: string; messages: unknown[]; status: RunStatus; error: string | null }[];
  running: string[];
}

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
  | { type: "respond"; callId: string; response: ToolResponse }
  /** Joins the live run at its next step boundary; with no live run, the same as `send`. */
  | { type: "steer"; message: unknown }
  /** Carry on with a stopped (`paused`) reply. */
  | { type: "resume" };

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

/** How a provider makes images: OpenAI-style `/images/generations`, or chat completions asking for image output (OpenRouter). */
export type ImageApi = "images" | "chat-modalities";
export type ImageAspect = "square" | "landscape" | "portrait";

export interface GeneratedImage {
  /** The blob URL the image is served on. */
  url: string;
  mediaType: string;
  revisedPrompt: string | null;
}

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
  /** Start a background sub-agent for a session, from its agent graph (`runs::agent_spawn`). */
  agentSpawn: (parent: ThreadMeta, config: RunConfig, callId: string, turnId: string, prompt: string) =>
    invoke<void>("agent_spawn", { parent, config, callId, turnId, prompt }),
  /** Have the messages steering a run join it now, cutting its current step or tool calls short. */
  runInterrupt: (threadId: string) => invoke<void>("run_interrupt", { threadId }),
  toolResult: (callId: string, result: { output: unknown } | { errorText: string }) => invoke<void>("tool_result", { callId, result }),
  /** The relay shared sessions go through, and who's signed in to it. */
  shareAccount: () => invoke<ShareAccount>("share_account"),
  /** With `name`, creates an account on the relay. */
  shareAccountSignIn: (relayUrl: string, email: string, password: string, name?: string) =>
    invoke<ShareAccount>("share_account_sign_in", { relayUrl, email, password, name: name ?? null }),
  /** Share through the server this app signs in to, with that session. */
  shareAccountUseToken: (relayUrl: string, token: string) => invoke<ShareAccount>("share_account_use_token", { relayUrl, token }),
  shareAccountSignOut: () => invoke<void>("share_account_sign_out"),
  shareStart: (thread: ThreadMeta) => invoke<ShareView>("share_start", { thread }),
  shareInviteCreate: (threadId: string, roleCap: "viewer" | "collaborator" = "viewer", ttlHours?: number, maxUses?: number) =>
    invoke<InviteLink>("share_invite_create", { threadId, roleCap, ttlHours: ttlHours ?? null, maxUses: maxUses ?? null }),
  shareInvitesList: (threadId: string) => invoke<InviteInfo[]>("share_invites_list", { threadId }),
  shareInviteRevoke: (threadId: string, inviteId: string) => invoke<void>("share_invite_revoke", { threadId, inviteId }),
  /** Let someone in from the lobby, or turn them away. */
  shareAdmit: (threadId: string, userId: string, allow: boolean) => invoke<void>("share_admit", { threadId, userId, allow }),
  shareKick: (threadId: string, userId: string) => invoke<void>("share_kick", { threadId, userId }),
  shareSetPolicy: (threadId: string, policy: SharePolicy) => invoke<void>("share_set_policy", { threadId, policy }),
  /** One driver at a time: a new one makes the old one a collaborator. */
  shareSetRole: (threadId: string, userId: string, role: Exclude<ShareRole, "owner">) => invoke<void>("share_set_role", { threadId, userId, role }),
  /** The owner sends a suggestion, as it is or edited, with the config their UI built. */
  shareSuggestionAccept: (threadId: string, suggestionId: string, text: string | null, config: RunConfig) =>
    invoke<void>("share_suggestion_accept", { threadId, suggestionId, text, config }),
  shareSuggestionDrop: (threadId: string, suggestionId: string) => invoke<void>("share_suggestion_drop", { threadId, suggestionId }),
  shareComment: (threadId: string, text: string, messageId?: string | null) =>
    invoke<void>("share_comment", { threadId, text, messageId: messageId ?? null }),
  /** The answer to a `share-config` frame. */
  shareConfigResult: (requestId: string, config: RunConfig | null, error: string | null) =>
    invoke<void>("share_config_result", { requestId, config, error }),
  shareEnd: (threadId: string) => invoke<void>("share_end", { threadId }),
  /** Join from an invite link; the share shows as its `threadId`. */
  shareJoin: (link: string) => invoke<ShareView>("share_join", { link }),
  shareLeave: (threadId: string) => invoke<void>("share_leave", { threadId }),
  /** Ask a joined share's host for something; the host checks it first. */
  shareRequest: <T>(threadId: string, intent: ShareIntent) => invoke<T>("share_request", { threadId, intent }),
  sharesState: () => invoke<SharesState>("shares_state"),
  threadsLoad: () => invoke<StoredThread[]>("threads_load"),
  /** Without `messages`, only the metadata (title, pin, project, model) is updated. */
  threadSave: (thread: ThreadMeta, messages: unknown[] | null) => invoke<void>("thread_save", { thread, messages }),
  threadDelete: (id: string) => invoke<void>("thread_delete", { id }),
  /** Restore a checkpoint: stop the run, put back the files changed from that turn on, and drop the user message `messageId` and all after it. */
  threadRewind: (thread: ThreadMeta, messageId: string) => invoke<UndoResult>("thread_rewind", { thread, messageId }),
  threadsImport: (threads: StoredThread[]) => invoke<number>("threads_import", { threads }),
  blobPut: (dataUrl: string) => invoke<string>("blob_put", { dataUrl }),
  /** A stored blob's bytes as a `data:` URL. */
  blobDataUrl: (url: string) => invoke<string>("blob_data_url", { url }),
  /** Downloads an https image into the blob store and returns its blob URL. */
  imageFetch: (url: string) => invoke<string>("image_fetch", { url }),
  /** Finds a picture of `query` on Wikipedia / Wikimedia Commons, stores it and returns its blob URL. */
  imageSearch: (query: string) => invoke<string>("image_search", { query }),
  chatsSearch: (query: string, limit: number) => invoke<ChatHit[]>("chats_search", { query, limit }),
  memoryList: () => invoke<StoredMemoryFile[]>("memory_list"),
  memoryWrite: (file: StoredMemoryFile) => invoke<void>("memory_write", { file }),
  memoryDelete: (path: string) => invoke<boolean>("memory_delete", { path }),
  memoryClear: () => invoke<void>("memory_clear"),
  /** Opens a folder picker (in Rust) and reads the chosen folder; null if cancelled. */
  pickFolderAttachment: () => invoke<Folder | null>("pick_folder_attachment"),
  /** Opens a save dialog (in Rust) and writes the file; false if cancelled. */
  saveTextFileAs: (fileName: string, contents: string) => invoke<boolean>("save_text_file_as", { fileName, contents }),
  /** Like `saveTextFileAs`, for binary data passed as base64. */
  saveBytesFileAs: (fileName: string, data: string) => invoke<boolean>("save_bytes_file_as", { fileName, data }),
  workspacesList: () => invoke<Workspace[]>("workspaces_list"),
  /** Opens a folder picker (in Rust); null if cancelled. */
  workspaceAdd: () => invoke<Workspace | null>("workspace_add"),
  workspaceUpdate: (id: string, access: WorkspaceAccess, approval: EditApproval) =>
    invoke<Workspace>("workspace_update", { id, access, approval }),
  workspaceRemove: (id: string) => invoke<void>("workspace_remove", { id }),
  workspaceTree: (id: string, path: string) => invoke<WorkspaceEntry[]>("workspace_tree", { id, path }),
  turnChanges: (threadId: string) => invoke<TurnChanges[]>("turn_changes", { threadId }),
  workspaceGit: (id: string) => invoke<GitInfo | null>("workspace_git", { id }),
  workspaceGitSwitch: (id: string, branch: string) => invoke<void>("workspace_git_switch", { id, branch }),
  /** Up to `limit` commits, every branch when `all`, for the graph panel. */
  workspaceGitLog: (id: string, limit: number, all: boolean) => invoke<GitLog>("workspace_git_log", { id, limit, all }),
  workspaceGitCommit: (id: string, sha: string) => invoke<CommitDetail>("workspace_git_commit", { id, sha }),
  /** The branch against `base` (default: the repository's main branch), for the pull request card. */
  workspaceBranchStatus: (id: string, base?: string) =>
    invoke<BranchStatus>("workspace_branch_status", { id, base: base ?? null }),
  /** A new worktree on a fresh branch from `base`, added as a workspace. */
  worktreeCreate: (id: string, base: string) => invoke<Workspace>("worktree_create", { id, base }),
  turnDiff: (threadId: string, turnId: string) => invoke<FileDiff[]>("turn_diff", { threadId, turnId }),
  /** Undo a turn's changes (and later turns'), or only those to `path`. */
  undoTurn: (threadId: string, turnId: string, path?: string) =>
    invoke<UndoResult>("undo_turn", { threadId, turnId, path: path ?? null }),
  workspaceReadFile: (id: string, path: string) => invoke<FileView>("workspace_read_file", { id, path }),
  workspaceFind: (id: string, query: string) => invoke<string[]>("workspace_find", { id, query }),
  sandboxStatus: () => invoke<SandboxStatus>("sandbox_status"),
  reportsList: () => invoke<Report[]>("reports_list"),
  /** A report to run on `threadId`, a Cowork thread in the workspace (`lib/reports.ts`). */
  reportCreate: (workspaceId: string, kind: ReportKind, scope: ReportScope, threadId: string) =>
    invoke<Report>("report_create", { workspaceId, kind, scope, threadId }),
  /** Run it again on a new thread; its results stay until that run finishes. */
  reportRerun: (id: string, threadId: string) => invoke<Report>("report_rerun", { id, threadId }),
  reportAskThread: (id: string, threadId: string | null) => invoke<Report>("report_ask_thread", { id, threadId }),
  reportDelete: (id: string) => invoke<void>("report_delete", { id }),
  /** Save a file the user edited in the viewer. */
  workspaceWriteFile: (id: string, path: string, text: string) => invoke<void>("workspace_write_file", { id, path, text }),
  /** Show a workspace file or folder in the system file manager. */
  workspaceReveal: (id: string, path: string) => invoke<void>("workspace_reveal", { id, path }),
  /** Open a workspace's folder in VS Code or the system file manager. */
  workspaceOpenIn: (id: string, target: "vscode" | "files") => invoke<void>("workspace_open_in", { id, target }),
  /** Start the user's shell in a workspace; what it prints arrives on `onEvent`, starting with a prompt. */
  terminalOpen: (workspaceId: string, onEvent: (event: TerminalEvent) => void) => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke<TerminalInfo>("terminal_open", { workspaceId, onEvent: channel });
  },
  /** Run a command line at the prompt; `cols` is the panel's width in characters. */
  terminalRun: (id: string, command: string, cols: number) => invoke<void>("terminal_run", { id, command, cols }),
  /** Input for the running command. */
  terminalWrite: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  /** Stop the running command: the shell restarts where it was. */
  terminalInterrupt: (id: string) => invoke<void>("terminal_interrupt", { id }),
  /** Files and folders completing `word` (unquoted) in the shell's current folder. */
  terminalComplete: (id: string, word: string) => invoke<TerminalCompletion[]>("terminal_complete", { id, word }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** Follow the built-in browser; returns the page it shows, or null before one is opened. */
  browserSubscribe: (onEvent: (event: BrowserEvent) => void) => {
    const channel = new Channel<BrowserEvent>();
    channel.onmessage = onEvent;
    return invoke<BrowserPage | null>("browser_subscribe", { onEvent: channel });
  },
  /** Open an address the user typed (a scheme is added if missing). */
  browserOpen: (url: string) => invoke<void>("browser_open", { url }),
  browserGo: (to: "back" | "forward" | "reload") => invoke<void>("browser_go", { to }),
  /** Place the browser over its pane (CSS pixels from the window's top left), or hide it with null. */
  browserSetView: (bounds: BrowserBounds | null) => invoke<void>("browser_set_view", { bounds }),
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
  imageGenerate: (providerId: string, model: string, api: ImageApi, prompt: string, aspect: ImageAspect | null) =>
    invoke<GeneratedImage>("image_generate", { providerId, model, api, prompt, aspect }),
  whisperModelStatus: () => invoke<{ downloaded: boolean; sizeBytes: number }>("whisper_model_status"),
  whisperModelDownload: (onProgress: Channel<{ received: number; total: number }>) =>
    invoke<void>("whisper_model_download", { onProgress }),
  transcribeLocal: (audioBase64Wav: string) => invoke<string>("transcribe_local", { audioBase64Wav }),
  /** A tab was dragged out of this window's strip and let go (`windows.rs`); `last` if it was the only one. */
  tabDrop: (threadId: string, last: boolean) => invoke<TabDrop>("tab_drop", { threadId, last }),
  /** A torn-off tab is being dragged (null: the drag is over); true while another window's strip is under the cursor. */
  tabHover: (threadId: string | null) => invoke<boolean>("tab_hover", { threadId }),
  /** Open a session in a new window (`windows.rs`). */
  sessionWindow: (threadId: string) => invoke<void>("session_window", { threadId }),
};

/** Where a dragged-out tab went: a new window, another window's strip, or nowhere. */
export type TabDrop = "detached" | "attached" | "stayed";

/** Commands reject with the Rust error's message string. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
