// Cowork workspaces: folders the user granted Sush. Rust owns them
// (`workspaces.rs`); this keeps a copy for the UI and tracks file changes so
// the file tree and the undo buttons refresh.

import { createContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import {
  api,
  type EditApproval,
  type SandboxStatus,
  type TurnChanges,
  type Workspace,
  type WorkspaceAccess,
} from "@/lib/tauri";

const workspaces = createStore<Workspace[]>("sush.workspaces-cache", [], false);

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

export const useWorkspaces = () => useSyncExternalStore(workspaces.subscribe, workspaces.get);

export function useWorkspace(id: string | undefined): Workspace | null {
  const all = useWorkspaces();
  return id ? (all.find((w) => w.id === id) ?? null) : null;
}

/** Ask the user for a folder (the picker opens in Rust); null if they cancelled. */
export async function addWorkspace(): Promise<Workspace | null> {
  const added = await api.workspaceAdd();
  if (added) workspaces.set((all) => (all.some((w) => w.id === added.id) ? all : [...all, added]));
  return added;
}

export async function updateWorkspace(id: string, access: WorkspaceAccess, approval: EditApproval) {
  const updated = await api.workspaceUpdate(id, access, approval);
  workspaces.set((all) => all.map((w) => (w.id === id ? updated : w)));
  return updated;
}

/** Forget a workspace; its sessions stay but lose file access. */
export async function removeWorkspace(id: string) {
  await api.workspaceRemove(id);
  workspaces.set((all) => all.filter((w) => w.id !== id));
}

// --- file changes -------------------------------------------------------------------

/** Bumped per workspace and per thread whenever files may have changed. */
const versions = createStore<Readonly<Record<string, number>>>("sush.workspace-versions", {}, false);

export function notifyFilesChanged(threadId: string, workspaceId: string) {
  versions.set((v) => ({ ...v, [workspaceId]: (v[workspaceId] ?? 0) + 1, [threadId]: (v[threadId] ?? 0) + 1 }));
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

// --- side panel -------------------------------------------------------------------------

export interface PanelState {
  files: boolean;
  terminal: boolean;
}

/** Which parts of the Cowork side panel are open; remembered across sessions. */
const panels = createStore<PanelState>("sush.cowork-panels", { files: true, terminal: false });

export const usePanels = () => useSyncExternalStore(panels.subscribe, panels.get);

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

/** Show a file in the viewer (opening the files panel if it's closed). */
export function openFile(workspaceId: string, path: string) {
  openFiles.set((all) => {
    const cur = all[workspaceId] ?? NO_FILES;
    const tabs = cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path];
    return { ...all, [workspaceId]: { tabs, active: path } };
  });
  togglePanel("files", true);
}

export function closeFile(workspaceId: string, path: string) {
  openFiles.set((all) => {
    const cur = all[workspaceId] ?? NO_FILES;
    const at = cur.tabs.indexOf(path);
    const tabs = cur.tabs.filter((t) => t !== path);
    const active = cur.active === path ? (tabs[Math.min(at, tabs.length - 1)] ?? null) : cur.active;
    return { ...all, [workspaceId]: { tabs, active } };
  });
}

export function selectFile(workspaceId: string, path: string) {
  openFiles.set((all) => ({ ...all, [workspaceId]: { ...(all[workspaceId] ?? NO_FILES), active: path } }));
}

/** Put back every file changed since `turnId` began. */
export async function undoTurn(threadId: string, workspaceId: string, turnId: string) {
  const result = await api.undoTurn(threadId, turnId);
  notifyFilesChanged(threadId, workspaceId);
  return result;
}
