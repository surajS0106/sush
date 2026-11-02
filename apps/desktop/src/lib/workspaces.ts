// Cowork workspaces: folders the user granted Sush. Rust owns them
// (`workspaces.rs`); this keeps a copy for the UI and tracks file changes so
// the file tree and the undo buttons refresh.

import { createContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import {
  api,
  errorMessage,
  isSharedThread,
  type BranchStatus,
  type CheckFailure,
  type EditApproval,
  type FileDiff,
  type GitInfo,
  type GitLog,
  type Pipeline,
  type SandboxStatus,
  type TurnChanges,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceCommands,
} from "@/lib/tauri";
import { broadcast, onBroadcast } from "@/lib/windows";

const workspaces = createStore<Workspace[]>("sush.workspaces-cache", [], false);

/** The list changed in this window: the other windows reload it. */
const WORKSPACES_EVENT = "sush://workspaces";
const changed = (all: Workspace[]) => {
  workspaces.set(all);
  void broadcast(WORKSPACES_EVENT, null);
};
onBroadcast(WORKSPACES_EVENT, () => {
  void api.workspacesList().then((all) => workspaces.set(all), (e) => console.error("Could not reload workspaces", e));
});

/** The workspace of the Cowork session on screen, for tool cards. */
export const CurrentWorkspace = createContext<Workspace | null>(null);

/** Load the workspaces. Call before rendering. */
export async function initWorkspaces() {
  workspaces.set(await api.workspacesList());
  // The sandbox self-test can take a few seconds; don't hold up the window for it.
  void api
    .sandboxStatus()
    .then((s) => sandbox.set(s))
    .catch((e) => console.warn("Could not check the sandbox", e));
}

const sandbox = createStore<SandboxStatus | null>("sush.sandbox-status", null, false);

/** Whether Cowork commands run in an OS sandbox here; null until checked. */
export const useSandboxStatus = () => useSyncExternalStore(sandbox.subscribe, sandbox.get);

export const getWorkspaces = () => workspaces.get();

export const useWorkspaces = () => useSyncExternalStore(workspaces.subscribe, workspaces.get);

export function useWorkspace(id: string | undefined): Workspace | null {
  const all = useWorkspaces();
  return id ? (all.find((w) => w.id === id) ?? null) : null;
}

/** Ask the user for a folder (the picker opens in Rust); null if they cancelled. */
export async function addWorkspace(): Promise<Workspace | null> {
  const added = await api.workspaceAdd();
  if (added) changed(workspaces.get().some((w) => w.id === added.id) ? workspaces.get() : [...workspaces.get(), added]);
  return added;
}

/** Change some of a workspace's settings; the rest stay as they are. */
export async function updateWorkspace(
  workspace: Workspace,
  patch: Partial<{ access: WorkspaceAccess; approval: EditApproval; commands: WorkspaceCommands }>,
) {
  const current = workspaces.get().find((w) => w.id === workspace.id) ?? workspace;
  const { id, access, approval, commands } = { ...current, ...patch };
  const updated = await api.workspaceUpdate(id, access, approval, commands);
  changed(workspaces.get().map((w) => (w.id === id ? updated : w)));
  return updated;
}

/** Forget a workspace; its sessions stay but lose file access. */
export async function removeWorkspace(id: string) {
  await api.workspaceRemove(id);
  changed(workspaces.get().filter((w) => w.id !== id));
}

// --- file changes -------------------------------------------------------------------

/** Bumped per workspace and per thread whenever files may have changed. */
const versions = createStore<Readonly<Record<string, number>>>("sush.workspace-versions", {}, false);

export function notifyFilesChanged(threadId: string, workspaceId: string) {
  versions.set((v) => ({ ...v, [workspaceId]: (v[workspaceId] ?? 0) + 1, [threadId]: (v[threadId] ?? 0) + 1 }));
}

/** After the user changed a file themselves (saving in the viewer). */
export function notifyWorkspaceChanged(workspaceId: string) {
  versions.set((v) => ({ ...v, [workspaceId]: (v[workspaceId] ?? 0) + 1 }));
}

/** Changes whenever files in this workspace (or touched by this thread) may have changed. */
export const useFilesVersion = (key: string | undefined) =>
  useSyncExternalStore(versions.subscribe, () => (key ? (versions.get()[key] ?? 0) : 0));

/**
 * The turns of a Cowork session that changed files, by the user message that
 * started each. For a session shared with this app, the host says (secret files left out).
 */
export function useTurnChanges(threadId: string, enabled: boolean): Map<string, string[]> {
  const version = useFilesVersion(threadId);
  const [turns, setTurns] = useState<TurnChanges[]>([]);
  useEffect(() => {
    if (!enabled) return setTurns([]);
    let live = true;
    const load = isSharedThread(threadId)
      ? api.shareRequest<TurnChanges[]>(threadId, { kind: "get-turn-changes" })
      : api.turnChanges(threadId);
    load
      .then((t) => live && setTurns(t))
      .catch((e) => console.warn("Could not load file changes", e));
    return () => {
      live = false;
    };
  }, [threadId, enabled, version]);
  return useMemo(() => new Map(turns.map((t) => [t.turnId, t.paths])), [turns]);
}

/** Before/after text of each file a turn changed, refreshed as files change. */
export function useTurnDiff(threadId: string, turnId: string | undefined): FileDiff[] | null {
  const version = useFilesVersion(threadId);
  const [diff, setDiff] = useState<FileDiff[] | null>(null);
  useEffect(() => {
    if (!turnId) return setDiff(null);
    let live = true;
    const load = isSharedThread(threadId)
      ? api.shareRequest<FileDiff[]>(threadId, { kind: "get-diff", turnId })
      : api.turnDiff(threadId, turnId);
    load
      .then((d) => live && setDiff(d))
      .catch((e) => console.warn("Could not load the diff", e));
    return () => {
      live = false;
    };
  }, [threadId, turnId, version]);
  return diff;
}

// --- git ------------------------------------------------------------------------------

/** The workspace's git state, or null outside a repo; refreshed as files change. */
export function useGitInfo(workspaceId: string | undefined): GitInfo | null {
  const version = useFilesVersion(workspaceId);
  const [info, setInfo] = useState<GitInfo | null>(null);
  useEffect(() => {
    if (!workspaceId) return setInfo(null);
    let live = true;
    api
      .workspaceGit(workspaceId)
      .then((g) => live && setInfo(g))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [workspaceId, version]);
  return info;
}

/**
 * Where the pull request card reads git and CI: the owner's workspace, or, in a
 * session shared with this app, the host (`thread` is `shared:…`).
 */
export interface BranchSource {
  key: string;
  /** The files-version key (`useFilesVersion`): bumps when the session's files change. */
  versionKey: string;
  branchStatus: (base?: string) => Promise<BranchStatus>;
  pipeline: (pr?: number) => Promise<Pipeline>;
  failure: (job: number) => Promise<CheckFailure>;
}

export function branchSource(workspaceId: string | undefined, threadId: string): BranchSource | null {
  if (workspaceId) {
    return {
      key: workspaceId,
      versionKey: workspaceId,
      branchStatus: (base) => api.workspaceBranchStatus(workspaceId, base),
      pipeline: (pr) => api.workspacePrChecks(workspaceId, pr),
      failure: (job) => api.workspaceCheckFailure(workspaceId, job),
    };
  }
  if (!isSharedThread(threadId)) return null;
  return {
    key: threadId,
    versionKey: threadId,
    branchStatus: (base) => api.shareRequest<BranchStatus>(threadId, { kind: "branch-status", base: base ?? null }),
    pipeline: (pr) => api.shareRequest<Pipeline>(threadId, { kind: "pr-checks", pr: pr ?? null }),
    failure: (job) => api.shareRequest<CheckFailure>(threadId, { kind: "check-failure", job }),
  };
}

/** The branch against `base`, read again whenever files change or `refresh` does. */
export function useBranchStatus(
  source: BranchSource | null,
  base: string | undefined,
  refresh?: unknown,
): { status: BranchStatus | null; error: string | null } {
  const version = useFilesVersion(source?.versionKey);
  const [result, setResult] = useState<{ status: BranchStatus | null; error: string | null }>({ status: null, error: null });
  const read = useRef(source);
  read.current = source;
  const key = source?.key;
  useEffect(() => {
    if (!key || !read.current) return setResult({ status: null, error: null });
    let live = true;
    read.current
      .branchStatus(base)
      .then((status) => live && setResult({ status, error: null }))
      .catch((e) => live && setResult({ status: null, error: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [key, base, version, refresh]);
  return result;
}

/** Polling while checks run, and while they're settled (a re-run or a new push can start them). */
const PIPELINE_BUSY_MS = 4_000;
const PIPELINE_IDLE_MS = 30_000;

/** Reads in flight or just done, by source and pull request: the card and the tray share one gh call. */
const pipelineReads = new Map<string, { at: number; read: Promise<Pipeline> }>();
function readPipeline(source: BranchSource, pr: number | undefined): Promise<Pipeline> {
  const key = `${source.key}:${pr ?? ""}`;
  const last = pipelineReads.get(key);
  if (last && Date.now() - last.at < 2_000) return last.read;
  const read = source.pipeline(pr);
  pipelineReads.set(key, { at: Date.now(), read });
  return read;
}

/**
 * The branch's pull request and its CI checks, as GitHub reports them. Polls
 * while the pull request is open; stops once it's merged or closed, or when
 * there's nothing to follow (no gh, no pull request), until `refresh` or
 * `head` (a new commit) changes.
 */
export function usePrPipeline(source: BranchSource | null, pr: number | undefined, head: string | undefined, refresh?: unknown) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const read = useRef(source);
  read.current = source;
  const key = source?.key;
  useEffect(() => {
    if (!key) return setPipeline(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const poll = () => {
      timer = undefined;
      // Skip polls while hidden (macOS also counts a covered window as hidden), but never the first read:
      // the card holds Merge until it has one.
      if (document.hidden && !first) return void (timer = setTimeout(poll, PIPELINE_IDLE_MS));
      first = false;
      if (!read.current) return;
      readPipeline(read.current, pr)
        .then((p) => {
          if (!live) return;
          setPipeline(p);
          if (p.kind !== "live" || p.pr.state === "merged" || p.pr.state === "closed") return;
          const busy = p.checks.some((c) => c.status === "running" || c.status === "pending");
          timer = setTimeout(poll, busy ? PIPELINE_BUSY_MS : PIPELINE_IDLE_MS);
        })
        .catch((e) => live && setPipeline({ kind: "unavailable", reason: errorMessage(e) }));
    };
    poll();
    // Back in view: read now rather than at the next idle tick, up to 30s away.
    const onVisible = () => {
      if (document.hidden || timer === undefined) return;
      clearTimeout(timer);
      poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, pr, head, refresh]);
  return pipeline;
}

/** Failures read, by source and job: a finished job's log doesn't change. */
const failures = new Map<string, CheckFailure>();

/** Reading a failed job's log again after an error: GitHub can take a moment to have it. */
const FAILURE_RETRY_MS = 5_000;
const FAILURE_TRIES = 24;

/**
 * Why a failed CI job failed. `failure` is null while it's read; `error`
 * says why it couldn't be, once retrying for about two minutes didn't help.
 */
export function useCheckFailure(
  source: BranchSource | null,
  job: number | null | undefined,
): { failure: CheckFailure | null; error: string | null } {
  const id = source && job != null ? `${source.key}:${job}` : null;
  const [result, setResult] = useState<{ failure: CheckFailure | null; error: string | null }>(() => ({
    failure: id ? (failures.get(id) ?? null) : null,
    error: null,
  }));
  const read = useRef(source);
  read.current = source;
  useEffect(() => {
    if (!id || job == null) return setResult({ failure: null, error: null });
    const known = failures.get(id);
    if (known) return setResult({ failure: known, error: null });
    setResult({ failure: null, error: null });
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      read.current
        ?.failure(job)
        .then((f) => {
          failures.set(id, f);
          if (live) setResult({ failure: f, error: null });
        })
        .catch((e) => {
          if (!live) return;
          if (n + 1 < FAILURE_TRIES) timer = setTimeout(() => attempt(n + 1), FAILURE_RETRY_MS);
          else setResult({ failure: null, error: errorMessage(e) });
        });
    };
    attempt(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, job]);
  return result;
}

/** The last history read per folder (`source`) and view, shown at once when the graph reopens. */
const lastLogs = new Map<string, GitLog>();

/**
 * Up to `limit` commits of a folder's history (every branch when `all`), read
 * with `read`: a workspace here, or a shared session's folder on its host.
 * `source` names the folder (it keys the last reads); it's read again when
 * `version` (its files changed) or `refresh` does. Starts from the last one
 * read, if any, while the fresh one loads.
 */
export function useGitLog(
  source: string,
  read: (limit: number, all: boolean) => Promise<GitLog>,
  version: unknown,
  limit: number,
  all: boolean,
  refresh?: unknown,
): { log: GitLog | null; error: string | null; loading: boolean } {
  const key = `${source}:${all}`;
  const [result, setResult] = useState<{ log: GitLog | null; error: string | null; loading: boolean }>(() => ({
    log: lastLogs.get(key) ?? null,
    error: null,
    loading: true,
  }));
  // The latest `read`, so a new closure each render doesn't read again.
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let live = true;
    // Another folder's history never stands in for this one's.
    setResult((r) => ({ log: lastLogs.get(key) ?? (r.log && lastLogs.get(`${source}:${!all}`) === r.log ? r.log : null), error: r.error, loading: true }));
    readRef
      .current(limit, all)
      .then((log) => {
        lastLogs.set(key, log);
        if (live) setResult({ log, error: null, loading: false });
      })
      .catch((e) => live && setResult({ log: null, error: errorMessage(e), loading: false }));
    return () => {
      live = false;
    };
  }, [key, source, limit, all, version, refresh]);
  return result;
}

/** Check out another branch in the workspace folder. */
export async function switchBranch(workspaceId: string, branch: string) {
  await api.workspaceGitSwitch(workspaceId, branch);
  versions.set((v) => ({ ...v, [workspaceId]: (v[workspaceId] ?? 0) + 1 }));
}

/**
 * Sessions that will get their own worktree when their first message is
 * sent, with the branch it starts from. Only untouched sessions are listed.
 */
const pendingWorktrees = createStore<Readonly<Record<string, string>>>("sush.pending-worktrees", {}, false);

export const usePendingWorktree = (threadId: string) =>
  useSyncExternalStore(pendingWorktrees.subscribe, () => pendingWorktrees.get()[threadId]);

/** Turn "work in a new worktree" on (from `base`) or off for an untouched session. */
export function setPendingWorktree(threadId: string, base: string | undefined) {
  pendingWorktrees.set(({ [threadId]: _, ...rest }) => (base ? { ...rest, [threadId]: base } : rest));
}

/**
 * If this session asked for a worktree, create it from `workspaceId` and
 * return the new workspace; null otherwise.
 */
export async function takePendingWorktree(threadId: string, workspaceId: string): Promise<Workspace | null> {
  const base = pendingWorktrees.get()[threadId];
  if (!base) return null;
  const created = await api.worktreeCreate(workspaceId, base);
  setPendingWorktree(threadId, undefined);
  changed([...workspaces.get(), created]);
  return created;
}

// --- side panel -------------------------------------------------------------------------

export interface PanelState {
  files: boolean;
  terminal: boolean;
  browser: boolean;
  graph: boolean;
}

/**
 * Which parts of the Cowork side panel are open; remembered across sessions.
 * Per window: a browser pane showing in two would pull the one browser back and forth.
 */
const PANELS: PanelState = { files: true, terminal: false, browser: false, graph: false };
const panels = createStore<PanelState>("sush.cowork-panels", PANELS, true, false);

/** Stored before the graph existed, a state lacks it; fill it in so the identity stays stable. */
let filled: [PanelState, PanelState] | null = null;
const getPanels = () => {
  const p = panels.get();
  if (filled?.[0] !== p) filled = [p, { ...PANELS, ...p }];
  return filled[1];
};

export const usePanels = () => useSyncExternalStore(panels.subscribe, getPanels);

export function togglePanel(which: keyof PanelState, open?: boolean) {
  panels.set((p) => ({ ...p, [which]: open ?? !p[which] }));
}

export interface OpenFiles {
  tabs: string[];
  active: string | null;
}

const NO_FILES: OpenFiles = { tabs: [], active: null };
/** Files open in the viewer, per workspace. */
const openFiles = createStore<Readonly<Record<string, OpenFiles>>>("sush.open-files", {}, false);

export const useOpenFiles = (workspaceId: string) =>
  useSyncExternalStore(openFiles.subscribe, () => openFiles.get()[workspaceId] ?? NO_FILES);

/** Show a file in the viewer (opening the files panel if it's closed), at `line` if given. */
export function openFile(workspaceId: string, path: string, line?: number) {
  openFiles.set((all) => {
    const cur = all[workspaceId] ?? NO_FILES;
    const tabs = cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path];
    return { ...all, [workspaceId]: { tabs, active: path } };
  });
  togglePanel("files", true);
  if (line) reveal.set({ workspaceId, path, line });
}

/** A line the viewer should scroll to once it shows the file; it clears this when it has. */
const reveal = createStore<{ workspaceId: string; path: string; line: number } | null>("sush.file-reveal", null, false);

export function useRevealLine(workspaceId: string, path: string): number | undefined {
  return useSyncExternalStore(reveal.subscribe, () => {
    const r = reveal.get();
    return r?.workspaceId === workspaceId && r.path === path ? r.line : undefined;
  });
}

export const clearRevealLine = () => reveal.set(null);

/** Close a tab; asks first if it has unsaved edits. Returns whether it closed. */
export function closeFile(workspaceId: string, path: string) {
  if (hasDraft(workspaceId, path) && !window.confirm(`${path.split("/").pop()} has unsaved changes. Close it anyway?`)) return false;
  setDraft(workspaceId, path, undefined);
  openFiles.set((all) => {
    const cur = all[workspaceId] ?? NO_FILES;
    const at = cur.tabs.indexOf(path);
    const tabs = cur.tabs.filter((t) => t !== path);
    const active = cur.active === path ? (tabs[Math.min(at, tabs.length - 1)] ?? null) : cur.active;
    return { ...all, [workspaceId]: { tabs, active } };
  });
  return true;
}

export function selectFile(workspaceId: string, path: string) {
  openFiles.set((all) => ({ ...all, [workspaceId]: { ...(all[workspaceId] ?? NO_FILES), active: path } }));
}

// --- unsaved edits ----------------------------------------------------------------------

/** Text the user typed in the viewer and hasn't saved, by workspace and path. Kept while switching tabs. */
const drafts = createStore<Readonly<Record<string, string>>>("sush.file-drafts", {}, false);

const draftKey = (workspaceId: string, path: string) => `${workspaceId}\n${path}`;

export const useDraft = (workspaceId: string, path: string) =>
  useSyncExternalStore(drafts.subscribe, () => drafts.get()[draftKey(workspaceId, path)]);

/** Whether each path has unsaved edits, for the tabs. */
export function useUnsaved(workspaceId: string): (path: string) => boolean {
  const all = useSyncExternalStore(drafts.subscribe, drafts.get);
  return (path) => draftKey(workspaceId, path) in all;
}

export const hasDraft = (workspaceId: string, path: string) => draftKey(workspaceId, path) in drafts.get();

export function setDraft(workspaceId: string, path: string, text: string | undefined) {
  const key = draftKey(workspaceId, path);
  if (text === undefined && !(key in drafts.get())) return;
  drafts.set((all) => {
    const next = { ...all };
    if (text === undefined) delete next[key];
    else next[key] = text;
    return next;
  });
}

/** Put back every file changed since `turnId` began, or only `path`. */
export async function undoTurn(threadId: string, workspaceId: string, turnId: string, path?: string) {
  const result = await api.undoTurn(threadId, turnId, path);
  notifyFilesChanged(threadId, workspaceId);
  return result;
}
