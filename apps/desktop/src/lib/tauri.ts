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
  | { type: "reasoning"; text: string; item?: unknown }
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
  thinking?: boolean | null;
  effort?: Effort | null;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "other";

export type ChatEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "reasoning-item"; item: unknown }
  | { type: "tool-call-delta"; index: number; id?: string | null; name?: string | null; argsDelta: string }
  | { type: "usage"; inputTokens?: number | null; outputTokens?: number | null; cachedInputTokens?: number | null }
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
  /** `ui.resourceUri` (MCP Apps) or `openai/outputTemplate` names a widget for the tool's results. */
  _meta?: { ui?: { resourceUri?: string }; "openai/outputTemplate"?: string } | null;
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
/** Where the agent's shell commands run (`sush_core::workspace::Commands`): the OS sandbox, or straight on this computer (each one asks). */
export type WorkspaceCommands = "sandbox" | "desktop";

/** A folder the user granted for Cowork (`sush_core::workspace::Workspace`). */
export interface Workspace {
  id: string;
  name: string;
  root: string;
  access: WorkspaceAccess;
  approval: EditApproval;
  commands: WorkspaceCommands;
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
  /** The branch a rebase stopped partway through is replaying; HEAD is detached until it's continued or aborted. */
  rebasing: string | null;
}

/** The workspace's branch against the branch it merges into (`sush_core::workspace::git::BranchStatus`). */
export interface BranchStatus {
  branch: string | null;
  base: string;
  /** The commit HEAD points at. */
  head: string;
  /** The commit the base points at. */
  baseHead: string;
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
  /** The branch's copy on its remote (`origin/feat`), while git still has it; null once deleted there. */
  upstream: string | null;
}

/** A branch's pull request and CI checks as GitHub reports them (`sush_core::workspace::ci::Pipeline`). */
export type Pipeline = { kind: "live"; pr: PipelinePr; checks: CiCheck[] } | { kind: "unavailable"; reason: string };

export interface PipelinePr {
  number: number;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  /** The commit the checks ran on. */
  head: string;
  base: string;
}

export interface CiCheck {
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  /** Unix milliseconds; null until it starts or ends. */
  startedAt: number | null;
  completedAt: number | null;
  link: string | null;
  /** The Actions job, for `workspaceCheckFailure`. */
  job: number | null;
}

/** Why a CI job failed, from its log (`sush_core::workspace::ci::Failure`). */
export interface CheckFailure {
  /** `path:line`. */
  location: string | null;
  title: string | null;
  expected: string | null;
  received: string | null;
  /** The log's last lines, when nothing above was found. */
  tail: string[];
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

// --- CRM (`crm.rs`, `sush_core::crm`) --------------------------------------------------

export type CrmKind = "company" | "contact" | "deal";

/** A company, contact or deal (`sush_core::crm::Record`). Which fields mean something depends on `kind`. */
export interface CrmRecord {
  /** Empty on a new record; saving gives it one. */
  id: string;
  kind: CrmKind;
  name: string;
  companyId?: string;
  /** A company's or deal's main contact. */
  contactId?: string;
  domain?: string;
  category?: string;
  email?: string;
  phone?: string;
  title?: string;
  owner?: string;
  /** A stage id from the settings (companies' or deals' list). */
  stage?: string;
  value?: number;
  /** `YYYY-MM-DD`. */
  closeDate?: string;
  /** `YYYY-MM-DD`; a deal with one is listed under Renewals. */
  renewalDate?: string;
  probability?: number;
  notes?: string;
  /** Imported columns with no field of their own. */
  fields?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type CrmTone = "open" | "won" | "lost";
export interface CrmStage {
  id: string;
  name: string;
  tone: CrmTone;
}

export interface CrmSettings {
  companyStages: CrmStage[];
  dealStages: CrmStage[];
  currency: string;
}

export type CrmTab = "companies" | "contacts" | "deals" | "renewals";
export type CrmFilterOp = "is" | "is-not" | "contains" | "gt" | "lt" | "empty" | "not-empty";
export interface CrmFilter {
  field: string;
  op: CrmFilterOp;
  value: string;
}

/** A saved view (`sush_core::crm::View`); the UI applies it. */
export interface CrmView {
  id: string;
  tab: CrmTab;
  name: string;
  query: string;
  filters: CrmFilter[];
  sort: { field: string; desc: boolean } | null;
  hidden: string[];
  layout: "table" | "board";
  createdAt: number;
}

export type CrmActivityKind = "note" | "email" | "meeting" | "call" | "ai" | "change";
export interface CrmActivity {
  id: string;
  recordId: string;
  kind: CrmActivityKind;
  body: string;
  at: number;
  threadId?: string;
}

/** What a save or delete did (`sush_core::crm::CrmEvent`), for workflow triggers. */
export type CrmEvent =
  | { type: "created"; record: CrmRecord }
  | { type: "updated"; record: CrmRecord; changed: string[] }
  | { type: "stage-changed"; record: CrmRecord; from: string | null; to: string | null; changed: string[] }
  | { type: "deleted"; record: CrmRecord };

/** A deleted record, to undo with `crmRestore`. */
export interface CrmRemoved {
  record: CrmRecord;
  activities: CrmActivity[];
  unlinked: string[];
}

export type CrmImportField =
  | "name" | "company" | "domain" | "category" | "email" | "phone" | "title" | "owner" | "stage" | "value"
  | "closeDate" | "renewalDate" | "probability" | "notes" | "custom" | "skip";

/** A picked CSV, with a guessed field per column for each kind. */
export interface CrmCsvFile {
  name: string;
  headers: string[];
  rows: string[][];
  guesses: Record<CrmKind, CrmImportField[]>;
}

export interface CrmImportResult {
  created: number;
  updated: number;
  skipped: number;
  companiesCreated: number;
}

// --- notebooks (`notebooks.rs`, `sush_core::notebooks`) --------------------------------

export type SourceKind = "pdf" | "web" | "paper" | "text" | "youtube" | "audio" | "chat" | "file";
export type SourceStatus = "reading" | "ready" | "failed";

/** A notebook source (`sush_core::notebooks::Source`). */
export interface NotebookSource {
  id: string;
  notebookId: string;
  kind: SourceKind;
  title: string;
  /** Where a web page or paper was read from. */
  url?: string;
  /** The original file (a PDF, or the text as added). */
  blob?: string;
  status: SourceStatus;
  error?: string;
  /** Whether chats search it. */
  checked: boolean;
  /** A PDF's page count. */
  pages?: number;
  chars: number;
  chunks: number;
  /** Its text was cut at the size limit. */
  truncated?: boolean;
  /** A short guide, written the first time it's opened. */
  guide?: SourceGuide;
  addedAt: number;
}

export interface SourceGuide {
  /** Markdown, key terms in bold. */
  summary: string;
  topics: string[];
  /** Its chunk count when written; a different count means it was read again since. */
  chunks: number;
}

/** A cover's framing: the point kept in view (percent across and down) and zoom, 1 to 3. */
export interface CoverPosition {
  x: number;
  y: number;
  zoom: number;
}

/** A model's summary of a notebook's sources (`sush_core::notebooks::Overview`). */
export interface NotebookOverview {
  summary: string;
  questions: string[];
  /** The sources it was written from; see `sourcesKey` in `lib/notebooks.ts`. */
  sourcesKey: string;
  generatedAt: number;
}

export interface Notebook {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sources: NotebookSource[];
  /** Its chats, oldest first. */
  threadIds: string[];
  emoji?: string;
  /** A cover image's blob URL. */
  cover?: string;
  /** How the cover is framed; none shows it centred. */
  coverPosition?: CoverPosition;
  /** The user's own summary, shown in place of the generated one. */
  customSummary?: string;
  overview?: NotebookOverview;
  /** The user named it, so overviews don't suggest a title. */
  named?: boolean;
  /** Notes and Studio outputs, newest first. */
  notes: NotebookNote[];
}

export type NoteKind = "note" | "briefing" | "study-guide" | "faq" | "timeline" | "quiz" | "flashcards" | "mind-map" | "audio-overview";

/** A passage id (`sushsrc:…`) an item came from. */
type From = { source?: string | null };
export type QuizData = { questions: ({ question: string; options: string[]; answer: number; explanation: string } & From)[] };
export type FlashcardsData = { cards: ({ front: string; back: string } & From)[] };
export type MindMapNode = { label: string; note?: string | null; children: MindMapNode[] } & From;
export type MindMapData = { root: MindMapNode };
/** An audio overview's script; `audio` is each turn's clip once voiced, `voices` what voiced them. */
export type AudioTurn = { host: "a" | "b"; text: string; audio?: string | null } & From;
export type AudioOverviewData = { chapters: { title: string; turns: AudioTurn[] }[]; voices?: string };
export type NoteStatus = "writing" | "ready" | "failed";

/** A note, or a Studio output (`sush_core::notebooks::Note`). */
export interface NotebookNote {
  id: string;
  notebookId: string;
  kind: NoteKind;
  title: string;
  /** Markdown with `[cite](sushsrc:…)` markers. */
  body: string;
  status: NoteStatus;
  error?: string;
  /** A Studio output's run. */
  threadId?: string;
  /** A quiz's, flashcards' or mind map's content. */
  data?: QuizData | FlashcardsData | MindMapData | AudioOverviewData;
  createdAt: number;
  updatedAt: number;
}

/** A chunk of a source's text, as searched and cited. */
export interface Passage {
  id: number;
  sourceId: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
}

export type RunStatus = "submitted" | "streaming" | "awaiting" | "ready" | "error";

export type RunFrame =
  | { type: "op"; threadId: string; op: ThreadOp }
  | { type: "status"; threadId: string; status: RunStatus; error: string | null }
  | { type: "tool-running"; threadId: string; callId: string; running: boolean }
  | { type: "client-tool"; threadId: string; callId: string; name: string; input: unknown }
  | { type: "saved"; thread: ThreadMeta }
  | { type: "files-changed"; threadId: string; workspaceId: string }
  | { type: "report"; report: Report }
  | { type: "notebook"; notebook: Notebook }
  | { type: "notebook-gone"; id: string }
  | { type: "crm-records"; records: CrmRecord[] }
  | { type: "crm-gone"; ids: string[] }
  | { type: "crm-activities"; recordId: string; activities: CrmActivity[] }
  | { type: "crm-views"; views: CrmView[] }
  | { type: "crm-settings"; settings: CrmSettings }
  | { type: "crm-event"; event: CrmEvent }
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
  /** What happens to the run while the owner is away. */
  away: ShareAwayPolicy;
  /** Keep the page in the owner's browser to themselves (guests follow it otherwise). */
  hideBrowser?: boolean;
  /** In a notebook's chat, guests may read the passages it cites. */
  showSources?: boolean;
}

/** A notebook as guests of one of its shared chats see it (`notebooks::guest_view`). */
export interface GuestNotebook {
  title: string;
  emoji: string | null;
  sources: { id: string; title: string; kind: SourceKind; pages: number | null; checked: boolean }[];
  outputs: { id: string; kind: NoteKind; title: string; body: string; data: NotebookNote["data"] | null; updatedAt: number }[];
}

/** One cited passage, for a guest (`notebooks::guest_passage`). */
export interface GuestPassage {
  sourceTitle: string;
  kind: SourceKind;
  url: string | null;
  page: number | null;
  heading: string | null;
  text: string;
}

/** The page open in the host's built-in browser, as guests follow it. */
export interface ShareBrowserPage {
  url: string;
  title: string;
  loading: boolean;
  /** The host's address on its local network, for pages the host serves itself. */
  lanHost: string | null;
}

/** `pause` (the default): the run finishes its step and pauses, and the owner drives again.
 *  `keep-going`: the driver carries on with what's delegated for `minutes`, then it pauses. */
export interface ShareAwayPolicy {
  mode: "pause" | "keep-going";
  minutes: number;
}

/** Someone asking for control. */
export interface ShareControlRequest {
  userId: string;
  name: string;
  at: number;
}

/** Kinds of approval the owner hands to the driver (`sush_core::share::Delegation`). Secret reads never. */
export interface ShareDelegation {
  edits: boolean;
  shell: boolean;
  /** Commands with network or outside the sandbox, and merges into another branch. */
  escalated: boolean;
  connectors: boolean;
  browser: boolean;
  /** Undoing a turn's file changes. */
  undo: boolean;
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
  | "ended"
  | "undid"
  | "control"
  | "away";

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
  /** People asking for control, oldest first. */
  requests: ShareControlRequest[];
  /** Since when the owner is away (ms), if they are. */
  ownerAway: number | null;
  /** Whether the relay sees only ciphertext (end-to-end encrypted). */
  e2e: boolean;
  /** The page in the host's browser, unless the owner hides it. */
  browser: ShareBrowserPage | null;
  /** What the relay's plan lets the owner do (the host's view; guests see the defaults). */
  limits: { maxGuests: number; roles: Exclude<ShareRole, "owner">[] };
}

/** The relay built into the installed app (its auth server). Not `available` in development. */
export interface LocalRelay {
  available: boolean;
  /** Others on the local network can reach it. */
  lan: boolean;
  /** Its address for them, while `lan`. */
  url: string | null;
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
  | { kind: "git-log"; limit: number; all: boolean }
  | { kind: "git-commit"; sha: string }
  | { kind: "branch-status"; base: string | null }
  | { kind: "pr-checks"; pr: number | null }
  | { kind: "check-failure"; job: number }
  | { kind: "get-notebook" }
  | { kind: "get-passage"; url: string }
  | { kind: "steer"; text: string; images: ShareImage[] }
  | { kind: "suggestion-accept"; id: string; text?: string | null }
  | { kind: "suggestion-drop"; id: string }
  | { kind: "send-now" }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "respond"; child?: string | null; callId: string; decision: "approve" | "deny"; answer?: unknown }
  | { kind: "comment"; text: string; messageId?: string | null }
  | { kind: "request-control" }
  | { kind: "accept-control"; userId: string }
  | { kind: "decline-control"; userId: string }
  | { kind: "pass-control"; userId: string }
  | { kind: "release-control" }
  | { kind: "undo"; turnId: string; path?: string | null };

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
  /** Left out of requests until the model loads it with `tools_load` (`sush_core::agent::deferred`). */
  deferred?: boolean;
}

export interface RunConfig {
  providerId: string;
  model: string;
  system: string | null;
  tools: RunTool[];
  research: boolean;
  /** Left out keeps the model's default, as does `effort`. */
  thinking?: boolean;
  effort?: Effort;
  /** Text sent to the model in place of a user message's first text, by message id. */
  expansions: Record<string, string>;
  /** Shell commands the button that started this run already approved; exactly these run without asking. */
  approved?: string[];
}

export type StreamFrame = { type: "event"; event: ChatEvent } | { type: "end" };

/** How a provider transcribes: OpenAI-style `/audio/transcriptions`, or Ollama chat with an audio-capable model. */
export type TranscribeApi = "transcriptions" | "ollama-chat";

/** Yammer, Sush's dictation app (`src-tauri/src/yammer.rs`). */
export interface YammerStatus {
  installed: boolean;
  running: boolean;
  /** Yammer's first-run setup is done. */
  onboarded: boolean;
  /** Yammer's global hotkey, in Tauri's accelerator syntax. */
  hotkey: string | null;
}

/** How a provider makes images: OpenAI-style `/images/generations`, or chat completions asking for image output (OpenRouter). */
export type ImageApi = "images" | "chat-modalities";
export type ImageAspect = "square" | "landscape" | "portrait";

export interface GeneratedImage {
  /** The blob URL the image is served on. */
  url: string;
  mediaType: string;
  revisedPrompt: string | null;
}

export type TravelMode = "driving" | "walking" | "bicycling" | "transit";

/** What the Google Maps key adds to a map card (`sush_core::maps`). */
export interface MapDetails {
  route: { duration: string | null; distance: string | null } | null;
  place: {
    name: string | null;
    address: string | null;
    kind: string | null;
    rating: number | null;
    ratingCount: number | null;
    openNow: boolean | null;
  } | null;
  error: string | null;
}

export type Cabin = "economy" | "premium-economy" | "business" | "first";

/** A search for flight fares (`sush_core::flights`). */
export interface FlightSearch {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
  adults: number;
  children: number;
  cabin: Cabin;
  maxStops: number | null;
  market: string;
  /** Also look for other airlines, at up to two more requests. */
  wide?: boolean;
}

export interface FlightLeg {
  carrier: string | null;
  durationMinutes: number | null;
  stops: number;
  from: string;
  to: string;
  /** The airports it stops at on the way. Absent on cards saved before routes were traced. */
  via?: string[];
  departsAt: string;
  arrivesAt: string;
  flights: string[];
}

export interface Fare {
  id: string;
  amount: number;
  currency: string;
  outbound: FlightLeg;
  inbound: FlightLeg | null;
}

export interface FlightResults {
  fares: Fare[];
  /** Other fares for the card's list, cheapest first. */
  more: Fare[];
  total: number;
  observedAt: string | null;
}

/** What one US dollar buys in each currency (`sush_core::flights`). */
export interface ExchangeRates {
  rates: Record<string, number>;
  updatedAt: number | null;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** A day's weather at a flight's destination (`sush_core::weather`). */
export interface DayWeather {
  place: string;
  date: string;
  code: number;
  condition: string;
  highC: number;
  lowC: number;
  /** The same date last year's figures, not a forecast. */
  lastYear: boolean;
}

export interface ForecastDay {
  /** `YYYY-MM-DD`, in the place's own time zone. */
  date: string;
  code: number;
  condition: string;
  highC: number;
  lowC: number;
  /** The day's highest chance of rain or snow, in percent. */
  precipitationChance: number | null;
}

export interface ForecastHour {
  /** `YYYY-MM-DDTHH:MM`, in the place's own time zone. */
  time: string;
  temperatureC: number;
  code: number;
  isDay: boolean;
  /** In percent. */
  precipitationChance: number | null;
}

export type Phase = "day" | "night" | "dawn" | "dusk";

/** The weather right now in a place (`sush_core::weather`). */
export interface TopicImage {
  thumb: string;
  full: string;
  caption: string | null;
  /** The file's page, with its credit and licence. */
  page: string;
}

export interface TopicReference {
  title: string;
  url: string;
  publisher: string | null;
}

export interface Topic {
  title: string;
  description: string | null;
  extract: string;
  url: string;
  images: TopicImage[];
  references: TopicReference[];
}

/** A `web_search` hit (`sush_core::web`). */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A page `web_fetch` read; `nextOffset` reads on when it goes on. */
export interface WebPage {
  url: string;
  title: string | null;
  content: string;
  nextOffset: number | null;
}

/** Where web search's Ollama key comes from: Settings → Search, an Ollama Cloud provider, or nowhere. */
export type WebKeySource = "own" | "provider" | "none";

export interface LocalWeather {
  /** The place found for a name; coordinates have none. */
  place: string | null;
  temperatureC: number;
  feelsLikeC: number;
  code: number;
  condition: string;
  isDay: boolean;
  phase: Phase;
  /** In percent. */
  humidity: number | null;
  windKmh: number | null;
  /** Today's highest. */
  uvIndex: number | null;
  /** Today's, as `YYYY-MM-DDTHH:MM` in the place's own time zone. */
  sunrise: string | null;
  sunset: string | null;
  /** Today and the next seven days. */
  days: ForecastDay[];
  /** The next 24 hours, starting with this one. */
  hours: ForecastHour[];
}

export interface BookingLink {
  provider: string;
  isAirline: boolean;
  exact: boolean;
  fareName: string | null;
  amount: number | null;
  currency: string | null;
  url: string;
  legs: string[];
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
  /** This machine's address on the local network (null when there's none), for a relay others on the Wi-Fi can reach. */
  shareLanAddress: () => invoke<string | null>("share_lan_address"),
  localRelay: () => invoke<LocalRelay>("local_relay"),
  /** Restarts the app's relay, open to the local network or not. */
  localRelaySetLan: (on: boolean) => invoke<LocalRelay>("local_relay_set_lan", { on }),
  /** `e2e` (default on): the relay sees only ciphertext. `metrics`: report anonymous counts to the relay when it ends. */
  shareStart: (thread: ThreadMeta, e2e = true, metrics = false) => invoke<ShareView>("share_start", { thread, e2e, metrics }),
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
  /** The owner answers a request for control, passes it on, or takes it back. */
  shareControl: (threadId: string, action: "accept" | "decline" | "pass" | "take", userId?: string) =>
    invoke<void>("share_control", { threadId, action, userId: userId ?? null }),
  /** The owner steps away from a shared session, or comes back (the share's away policy applies). */
  shareStepAway: (threadId: string, away: boolean) => invoke<void>("share_step_away", { threadId, away }),
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
  /** Join again with the invite link kept (in the keyring) when it was first joined. */
  shareRejoin: (shareId: string) => invoke<ShareView>("share_rejoin", { shareId }),
  /** Forget a joined share's kept invite link. */
  shareForget: (shareId: string) => invoke<void>("share_forget", { shareId }),
  /** Ask a joined share's host for something; the host checks it first. */
  shareRequest: <T>(threadId: string, intent: ShareIntent) => invoke<T>("share_request", { threadId, intent }),
  sharesState: () => invoke<SharesState>("shares_state"),
  threadsLoad: () => invoke<StoredThread[]>("threads_load"),
  /** Without `messages`, only the metadata (title, pin, project, model) is updated. */
  threadSave: (thread: ThreadMeta, messages: unknown[] | null) => invoke<void>("thread_save", { thread, messages }),
  threadDelete: (id: string) => invoke<void>("thread_delete", { id }),
  /** Restore a checkpoint: stop the run, put back the files changed from that turn on, and drop the user message `messageId` and all after it. */
  threadRewind: (thread: ThreadMeta, messageId: string) => invoke<UndoResult>("thread_rewind", { thread, messageId }),
  /** Add a summary message (`metadata.compaction`) to a session that isn't running; the model then reads the thread from it. */
  threadCompact: (thread: ThreadMeta, message: unknown) => invoke<void>("thread_compact", { thread, message }),
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
  workspaceUpdate: (id: string, access: WorkspaceAccess, approval: EditApproval, commands: WorkspaceCommands) =>
    invoke<Workspace>("workspace_update", { id, access, approval, commands }),
  workspaceRemove: (id: string) => invoke<void>("workspace_remove", { id }),
  workspaceTree: (id: string, path: string) => invoke<WorkspaceEntry[]>("workspace_tree", { id, path }),
  turnChanges: (threadId: string) => invoke<TurnChanges[]>("turn_changes", { threadId }),
  workspaceGit: (id: string) => invoke<GitInfo | null>("workspace_git", { id }),
  workspaceGitSwitch: (id: string, branch: string) => invoke<void>("workspace_git_switch", { id, branch }),
  /** Continue or abort a stopped rebase; what happened. */
  workspaceGitRebase: (id: string, abort: boolean) => invoke<string>("workspace_git_rebase", { id, abort }),
  /** Up to `limit` commits, every branch when `all`, for the graph panel. */
  workspaceGitLog: (id: string, limit: number, all: boolean) => invoke<GitLog>("workspace_git_log", { id, limit, all }),
  workspaceGitCommit: (id: string, sha: string) => invoke<CommitDetail>("workspace_git_commit", { id, sha }),
  /** The branch against `base` (default: the repository's main branch), for the pull request card. */
  workspaceBranchStatus: (id: string, base?: string) =>
    invoke<BranchStatus>("workspace_branch_status", { id, base: base ?? null }),
  /** The branch's pull request (or `pr`) and its CI checks, through the user's gh. */
  workspacePrChecks: (id: string, pr?: number) => invoke<Pipeline>("workspace_pr_checks", { id, pr: pr ?? null }),
  workspaceCheckFailure: (id: string, job: number) => invoke<CheckFailure>("workspace_check_failure", { id, job }),
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

  crmLoad: () => invoke<{ records: CrmRecord[]; views: CrmView[]; settings: CrmSettings }>("crm_load"),
  crmSave: (record: CrmRecord) => invoke<CrmRecord>("crm_save", { record }),
  /** A bulk edit; all or none. */
  crmSaveMany: (records: CrmRecord[]) => invoke<CrmRecord[]>("crm_save_many", { records }),
  crmDelete: (ids: string[]) => invoke<CrmRemoved[]>("crm_delete", { ids }),
  crmRestore: (removed: CrmRemoved[]) => invoke<void>("crm_restore", { removed }),
  crmActivities: (recordId: string) => invoke<CrmActivity[]>("crm_activities", { recordId }),
  crmActivityAdd: (recordId: string, kind: CrmActivityKind, body: string) =>
    invoke<CrmActivity>("crm_activity_add", { recordId, kind, body }),
  crmActivityDelete: (id: string) => invoke<void>("crm_activity_delete", { id }),
  crmViewSave: (view: CrmView) => invoke<CrmView>("crm_view_save", { view }),
  crmViewDelete: (id: string) => invoke<void>("crm_view_delete", { id }),
  crmSettingsSave: (settings: CrmSettings) => invoke<CrmSettings>("crm_settings_save", { settings }),
  /** Ask for a CSV and read it; `null` if cancelled. */
  crmImportPick: () => invoke<CrmCsvFile | null>("crm_import_pick"),
  crmImport: (request: { kind: CrmKind; headers: string[]; mapping: CrmImportField[]; rows: string[][] }) =>
    invoke<CrmImportResult>("crm_import", { request }),
  /** Made-up records to try an empty CRM with. */
  crmSample: () => invoke<void>("crm_sample"),
  /** Record ids matching `query` best first, over fields and activities (full-text). */
  crmSearch: (query: string, kind: CrmKind | null, limit?: number) => invoke<string[]>("crm_search", { query, kind, limit: limit ?? null }),
  notebooksList: () => invoke<Notebook[]>("notebooks_list"),
  notebookCreate: (title: string) => invoke<Notebook>("notebook_create", { title }),
  notebookRename: (id: string, title: string) => invoke<Notebook>("notebook_rename", { id, title }),
  /** Everything the Customize dialog sets, the cover included (`null` removes it). */
  notebookCustomize: (
    id: string,
    title: string,
    emoji: string | null,
    customSummary: string | null,
    cover: string | null,
    coverPosition: CoverPosition | null,
  ) => invoke<Notebook>("notebook_customize", { id, title, emoji, customSummary, cover, coverPosition }),
  notebookSetOverview: (id: string, overview: NotebookOverview, title: string | null, emoji: string | null) =>
    invoke<Notebook>("notebook_set_overview", { id, overview, title, emoji }),
  /** Ask for a cover image and store it; the notebook only gets it from `notebookCustomize`. `null` if cancelled. */
  notebookPickCover: () => invoke<string | null>("notebook_pick_cover"),
  notebookSourceSetGuide: (sourceId: string, guide: SourceGuide) => invoke<NotebookSource>("notebook_source_set_guide", { sourceId, guide }),
  /** The model scanned PDFs are read with. */
  notebookSetReader: (providerId: string | null, model: string | null) => invoke<void>("notebook_set_reader", { providerId, model }),
  notebookNoteCreate: (id: string, title: string, body: string) => invoke<NotebookNote>("notebook_note_create", { id, title, body }),
  notebookNoteUpdate: (noteId: string, title: string, body: string) => invoke<NotebookNote>("notebook_note_update", { noteId, title, body }),
  /** Returns a Studio output's thread, for the UI to delete. */
  notebookNoteDelete: (noteId: string) => invoke<string | null>("notebook_note_delete", { noteId }),
  notebookStudioStart: (id: string, kind: NoteKind, threadId: string) => invoke<NotebookNote>("notebook_studio_start", { id, kind, threadId }),
  /** An audio overview's script with its clips. */
  notebookNoteSetData: (noteId: string, data: AudioOverviewData) => invoke<NotebookNote>("notebook_note_set_data", { noteId, data }),
  /** Speak text with a provider's `/audio/speech`; returns the stored MP3's URL. */
  ttsSpeak: (providerId: string, model: string, voice: string, text: string, instructions: string | null) =>
    invoke<string>("tts_speak", { providerId, model, voice, text, instructions }),
  /** Returns its chats' threads, for the UI to delete. */
  notebookDelete: (id: string) => invoke<string[]>("notebook_delete", { id }),
  notebookAddThread: (id: string, threadId: string) => invoke<Notebook>("notebook_add_thread", { id, threadId }),
  /** Pasted text, or (`kind: "audio"`) a transcript the UI made of an audio file. */
  notebookAddText: (id: string, title: string, text: string, kind: "text" | "audio" = "text") =>
    invoke<NotebookSource>("notebook_add_text", { id, title, text, kind }),
  notebookAddChat: (id: string, threadId: string) => invoke<NotebookSource>("notebook_add_chat", { id, threadId }),
  notebookAddWorkspaceFile: (id: string, workspaceId: string, path: string) =>
    invoke<NotebookSource>("notebook_add_workspace_file", { id, workspaceId, path }),
  notebookAddLink: (id: string, url: string) => invoke<NotebookSource>("notebook_add_link", { id, url }),
  /** Opens a file dialog; empty if cancelled. */
  notebookAddFiles: (id: string) => invoke<NotebookSource[]>("notebook_add_files", { id }),
  /** A dropped file, by its contents (base64). */
  notebookAddFileData: (id: string, name: string, data: string) => invoke<NotebookSource>("notebook_add_file_data", { id, name, data }),
  notebookSourceUpdate: (sourceId: string, change: { checked?: boolean; title?: string }) =>
    invoke<NotebookSource>("notebook_source_update", { sourceId, checked: change.checked ?? null, title: change.title ?? null }),
  notebookSourceDelete: (sourceId: string) => invoke<void>("notebook_source_delete", { sourceId }),
  notebookSourceRetry: (sourceId: string) => invoke<NotebookSource>("notebook_source_retry", { sourceId }),
  /** A source's passages; with `limit`, only that many from the start. */
  notebookSourceText: (sourceId: string, limit?: number) =>
    invoke<{ source: NotebookSource; passages: Passage[] }>("notebook_source_text", { sourceId, limit: limit ?? null }),
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
  /** Call a tool its server marks read-only; anything else is refused (workflow triggers). */
  connectorRead: (id: string, tool: string, args: unknown) => invoke<string>("connector_read", { id, tool, arguments: args ?? {} }),
  /** Disconnect and delete the connector's stored credentials. */
  connectorForget: (id: string) => invoke<void>("connector_forget", { id }),
  /** Sign in through the browser; resolves when the browser comes back. Servers
   *  that sign in with a typed code (GitHub) call `onCode` with it first.
   *  `assertion` is the one-time "same account" proof Plinth checks (`lib/auth.ts` `assertionFor`); it goes to Plinth only. */
  connectorAuthorize: (id: string, url: string, clientId: string | null | undefined, onCode: (code: DeviceCode) => void, assertion?: string | null) => {
    const channel = new Channel<DeviceCode>();
    channel.onmessage = onCode;
    return invoke<void>("connector_authorize", { id, url, clientId: clientId || null, assertion: assertion || null, onCode: channel });
  },
  connectorCancelAuthorize: (id: string) => invoke<void>("connector_cancel_authorize", { id }),
  /** The live cart and saved addresses, as Swiggy's own tool output, for the card that confirms an order. */
  swiggyOrderPreview: (id: string, addressId: string, instamart: boolean) =>
    invoke<{ cart: string; addresses: string }>("swiggy_order_preview", { id, addressId, instamart }),
  /** The cart as Instamart has it, for the card to merge the user's change into. */
  instamartCartRead: (id: string) => invoke<string>("instamart_cart_read", { id }),
  /** Saves the user's change from the card; `update_cart`'s output, or `clear_cart`'s for no items. */
  instamartCartWrite: (id: string, items: { spinId: string; skuId: string; quantity: number }[], addressId: string | undefined) =>
    invoke<string>("instamart_cart_write", { id, items, addressId: addressId ?? null }),
  /** The URL to frame a connector's own widget at, holding this tool call's result. */
  connectorWidget: (id: string, uri: string, input: unknown, output: unknown, dark: boolean) =>
    invoke<string>("connector_widget", { id, uri, input: input ?? {}, output: output ?? {}, dark }),
  /** `undefined` keeps a stored value, `""` clears it. */
  connectorSaveSecrets: (id: string, url: string, secrets: { token?: string; clientSecret?: string }) =>
    invoke<void>("connector_save_secrets", { id, url, token: secrets.token ?? null, clientSecret: secrets.clientSecret ?? null }),
  transcribe: (providerId: string, model: string, api: TranscribeApi, audioBase64Wav: string) =>
    invoke<string>("transcribe", { providerId, model, api, audioBase64Wav }),
  imageGenerate: (providerId: string, model: string, api: ImageApi, prompt: string, aspect: ImageAspect | null) =>
    invoke<GeneratedImage>("image_generate", { providerId, model, api, prompt, aspect }),
  mapsKeyStatus: () => invoke<boolean>("maps_key_status"),
  /** Saves the key and tries it; returns what's wrong with it, if anything. */
  mapsKeySet: (key: string) => invoke<string[]>("maps_key_set", { key }),
  mapsKeyDelete: () => invoke<void>("maps_key_delete"),
  mapsDetails: (origin: string | null, destination: string, mode: TravelMode) =>
    invoke<MapDetails | null>("maps_details", { origin, destination, mode }),
  flightsKeyStatus: () => invoke<boolean>("flights_key_status"),
  /** Saves the key and tries it; returns what's wrong with it, if anything. */
  flightsKeySet: (key: string) => invoke<string | null>("flights_key_set", { key }),
  flightsKeyDelete: () => invoke<void>("flights_key_delete"),
  /** Null without a key. */
  flightsSearch: (search: FlightSearch) => invoke<FlightResults | null>("flights_search", { search }),
  flightsBookingLinks: (fareId: string) => invoke<BookingLink[]>("flights_booking_links", { fareId }),
  flightsWeather: (city: string, date: string) => invoke<DayWeather | null>("flights_weather", { city, date }),
  /** A place's name or `latitude,longitude`. Null when it can't be found. */
  weatherNow: (place: string) => invoke<LocalWeather | null>("weather_now", { place }),
  /** Null when no article matches. */
  topicLookup: (query: string) => invoke<Topic | null>("topic_lookup", { query }),
  webKeyStatus: () => invoke<WebKeySource>("web_key_status"),
  /** Saves the key and tries it; returns what's wrong with it, if anything. */
  webKeySet: (key: string) => invoke<string | null>("web_key_set", { key }),
  webKeyDelete: () => invoke<void>("web_key_delete"),
  webSearch: (query: string, maxResults?: number) => invoke<WebSearchResult[]>("web_search", { query, maxResults: maxResults ?? null }),
  webFetch: (url: string, offset?: number) => invoke<WebPage>("web_fetch", { url, offset: offset ?? null }),
  flightsLocate: (city: string) => invoke<GeoPoint | null>("flights_locate", { city }),
  flightsRates: () => invoke<ExchangeRates>("flights_rates"),
  /** macOS only; other platforms read the position through the webview (`lib/location.ts`). */
  locationRead: () => invoke<{ latitude: number; longitude: number; accuracyMeters: number }>("location_read"),
  whisperModelStatus: () => invoke<{ downloaded: boolean; sizeBytes: number }>("whisper_model_status"),
  whisperModelDownload: (onProgress: Channel<{ received: number; total: number }>) =>
    invoke<void>("whisper_model_download", { onProgress }),
  transcribeLocal: (audioBase64Wav: string) => invoke<string>("transcribe_local", { audioBase64Wav }),
  yammerStatus: () => invoke<YammerStatus>("yammer_status"),
  /** Start or finish a Yammer dictation; true if Yammer had to be started first. */
  yammerToggle: () => invoke<boolean>("yammer_toggle"),
  /** Show Yammer's window (its setup and settings). */
  yammerOpen: () => invoke<void>("yammer_open"),
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
