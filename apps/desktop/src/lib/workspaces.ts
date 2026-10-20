// Cowork workspaces: folders the user granted Sush. Rust owns them
// (`workspaces.rs`); this keeps a copy for the UI and tracks file changes so
// the file tree and the undo buttons refresh.

import { createContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import {
  api,
  errorMessage,
  type BranchStatus,
  type EditApproval,
  type FileDiff,
  type GitInfo,
  type GitLog,
  type SandboxStatus,
  type TurnChanges,
  type Workspace,
  type WorkspaceAccess,
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

export async function updateWorkspace(id: string, access: WorkspaceAccess, approval: EditApproval) {
  const updated = await api.workspaceUpdate(id, access, approval);
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

/** The turns of a Cowork session that changed files, by the user message that started each. */
export function useTurnChanges(threadId: string, enabled: boolean): Map<string, string[]> {
  const version = useFilesVersion(threadId);
  const [turns, setTurns] = useState<TurnChanges[]>([]);
  useEffect(() => {
    if (!enabled) return setTurns([]);
    let live = true;
    api
      .turnChanges(threadId)
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
    api
      .turnDiff(threadId, turnId)
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
 * The workspace's branch against `base`, refreshed as files change and when
 * `refresh` does. `error` says why there's none (not a repo, on the base itself).
 */
export function useBranchStatus(
  workspaceId: string | undefined,
  base: string | undefined,
  refresh?: unknown,
): { status: BranchStatus | null; error: string | null } {
  const version = useFilesVersion(workspaceId);
  const [result, setResult] = useState<{ status: BranchStatus | null; error: string | null }>({ status: null, error: null });
  useEffect(() => {
    if (!workspaceId) return setResult({ status: null, error: null });
    let live = true;
    api
      .workspaceBranchStatus(workspaceId, base)
      .then((status) => live && setResult({ status, error: null }))
      .catch((e) => live && setResult({ status: null, error: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [workspaceId, base, version, refresh]);
  return result;
}

/** The last history read per workspace and view, shown at once when the graph reopens. */
const lastLogs = new Map<string, GitLog>();

/**
 * Up to `limit` commits of the workspace's history (every branch when `all`),
 * read again as files change and when `refresh` does. Starts from the last
 * one read, if any, while the fresh one loads.
 */
export function useGitLog(
  workspaceId: string,
  limit: number,
  all: boolean,
  refresh?: unknown,
): { log: GitLog | null; error: string | null; loading: boolean } {
  const version = useFilesVersion(workspaceId);
  const key = `${workspaceId}:${all}`;
  const [result, setResult] = useState<{ log: GitLog | null; error: string | null; loading: boolean }>(() => ({
    log: lastLogs.get(key) ?? null,
    error: null,
    loading: true,
  }));
  useEffect(() => {
    let live = true;
    // Another workspace's history never stands in for this one's.
    setResult((r) => ({ log: lastLogs.get(key) ?? (r.log && lastLogs.get(`${workspaceId}:${!all}`) === r.log ? r.log : null), error: r.error, loading: true }));
    api
      .workspaceGitLog(workspaceId, limit, all)
      .then((log) => {
        lastLogs.set(key, log);
        if (live) setResult({ log, error: null, loading: false });
      })
      .catch((e) => live && setResult({ log: null, error: errorMessage(e), loading: false }));
    return () => {
      live = false;
    };
  }, [key, workspaceId, limit, all, version, refresh]);
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
