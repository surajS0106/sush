// Conversation and preference state.
//
// Conversations live in SQLite on the Rust side (`sush_core::store`). They're
// loaded once at startup (`initStore`) and kept in memory here, so reads stay
// synchronous. Agent runs save their own threads (`runs.rs`) and this copy
// mirrors those saves (`applySaved`); the UI's own changes (pins, renames,
// forks, deletes) are written through to Rust in order. Incognito chats are
// never written: Rust keeps their messages in memory until they're deleted.
// Preferences stay in localStorage.
//
// Every window (`lib/windows.ts`) has its own copy: the UI's changes are
// broadcast to the others, runs' saves reach them all, and stores kept in
// localStorage pick up other windows' writes from the `storage` event.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { api, errorMessage, type StoredThread, type ThreadMeta } from "@/lib/tauri";
import type { ModelTarget, SushUIMessage } from "@/lib/transport";
import { broadcast, onBroadcast } from "@/lib/windows";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  target?: ModelTarget;
  pinned?: boolean;
  /** Set for Cowork sessions: the workspace (granted folder) they work in. */
  workspaceId?: string;
  /** The project it's filed under (`lib/projects.ts`). */
  projectId?: string;
  /** Kept out of history, memory and search, and gone once closed. */
  incognito?: boolean;
  messages: SushUIMessage[];
}

/** Where earlier versions kept conversations; imported into SQLite once. */
const LEGACY_CONVERSATIONS_KEY = "sush.conversations";
const MIGRATED_KEY = "sush.conversations.migrated";
const TARGET_KEY = "sush.target";
const ASK_USER_KEY = "sush.askUser";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`Could not persist ${key}`, e); // quota exceeded, e.g. large images
  }
}

/**
 * Tiny observable store; components subscribe via `useSyncExternalStore`. A
 * persisted one follows other windows' writes, unless it's per window (`follow`
 * false): then each window starts from the last one written and goes its own way.
 */
export function createStore<T>(key: string, initial: T, persist = true, follow = true) {
  let state = persist ? read(key, initial) : initial;
  const listeners = new Set<() => void>();
  if (persist && follow) {
    window.addEventListener("storage", (e) => {
      if (e.key !== key) return;
      state = read(key, initial);
      listeners.forEach((l) => l());
    });
  }
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      if (persist) write(key, state);
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const conversations = createStore<Conversation[]>("sush.conversations-cache", [], false);

/** A change to the conversations made in another window. */
type Shared = { type: "upsert"; conversation: Conversation } | { type: "delete"; id: string };
const CONVERSATION_EVENT = "sush://conversation";
const share = (change: Shared) => void broadcast(CONVERSATION_EVENT, change);

onBroadcast<Shared>(CONVERSATION_EVENT, (change) => {
  if (change.type === "delete") return conversations.set((all) => all.filter((c) => c.id !== change.id));
  const next = change.conversation;
  conversations.set((all) => {
    const existing = all.find((c) => c.id === next.id);
    // Messages come from the runs, which every window follows; take only the rest.
    return existing ? all.map((c) => (c === existing ? { ...next, messages: existing.messages } : c)) : [next, ...all];
  });
});
const target = createStore<ModelTarget | null>(TARGET_KEY, null);
const askUser = createStore<boolean>(ASK_USER_KEY, true);

export const subscribeConversations = (l: () => void) => conversations.subscribe(l);

/** A conversation's metadata as Rust stores it. */
export function threadMeta(id: string): ThreadMeta | null {
  const c = conversations.get().find((c) => c.id === id);
  return c ? meta(c) : null;
}

/** Show messages in the in-memory copy before the run saves them, so a chat with a message in flight no longer counts as empty. */
export function showMessages(id: string, messages: SushUIMessage[]) {
  update(id, (c) => ({ ...c, messages }));
}

/** Mirror a save that Rust made (a run writes its thread itself). */
export function applySaved(saved: ThreadMeta, messages: SushUIMessage[] | undefined) {
  update(saved.id, (c) => ({ ...c, ...saved, messages: messages ?? c.messages }));
}

export function useConversations() {
  return useSyncExternalStore(conversations.subscribe, conversations.get);
}

export function useTarget() {
  return useSyncExternalStore(target.subscribe, target.get);
}

export const setTarget = (t: ModelTarget | null) => target.set(t);

/** Non-React reads, for tools and one-shot model calls. */
export const getConversations = () => conversations.get();
export const getTarget = () => target.get();

/** Whether models get the `ask_user` tool. Some local models reject any tools, so it can be turned off. */
export function useAskUser() {
  return useSyncExternalStore(askUser.subscribe, askUser.get);
}

export const setAskUser = (on: boolean) => askUser.set(on);
export const getAskUser = () => askUser.get();

interface NewConversation {
  workspaceId?: string;
  projectId?: string;
  incognito?: boolean;
}

/** A `title` other than "New chat" is kept; otherwise the first message names the session. */
export function createConversation(workspaceId?: string, title = "New chat", extra: Omit<NewConversation, "workspaceId"> = {}): Conversation {
  const now = Date.now();
  // Saved once it has messages, so untouched chats don't pile up on disk.
  const convo: Conversation = {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...(workspaceId ? { workspaceId } : {}),
    ...(extra.projectId ? { projectId: extra.projectId } : {}),
    ...(extra.incognito ? { incognito: true } : {}),
  };
  conversations.set((all) => [convo, ...all]);
  share({ type: "upsert", conversation: convo });
  return convo;
}

/** Point an untouched session at a folder (Cowork) or at none (a plain chat). */
export function setConversationWorkspace(id: string, workspaceId: string | undefined) {
  const next = update(id, (c) => {
    if (c.messages.length > 0) return c;
    const { workspaceId: _, ...rest } = c;
    return workspaceId ? { ...rest, workspaceId } : rest;
  });
  if (next) share({ type: "upsert", conversation: next });
}

/** Change metadata the user owns (title, pin, project) and write it through. */
function changeMeta(id: string, change: (c: Conversation) => Conversation) {
  const next = update(id, change);
  if (next) share({ type: "upsert", conversation: next });
  // An untouched chat is written along with its (empty) messages, so it exists to update.
  if (next && !next.incognito) persist(() => api.threadSave(meta(next), next.messages.length > 0 ? null : []));
}

export function togglePinned(id: string) {
  changeMeta(id, (c) => ({ ...c, pinned: !c.pinned }));
}

export function renameConversation(id: string, title: string) {
  const trimmed = title.trim();
  if (trimmed) changeMeta(id, (c) => ({ ...c, title: trimmed }));
}

/** File a chat under a project, or take it out of one (`undefined`). */
export function setConversationProject(id: string, projectId: string | undefined) {
  changeMeta(id, (c) => {
    const { projectId: _, ...rest } = c;
    return projectId ? { ...rest, projectId } : rest;
  });
}

/** A copy of a chat as it was last saved, to take in another direction. Not for incognito chats, whose messages only Rust holds. */
export function forkConversation(id: string): Conversation | null {
  const source = conversations.get().find((c) => c.id === id);
  if (!source || source.incognito) return null;
  const now = Date.now();
  const { pinned: _, ...rest } = source;
  const fork: Conversation = {
    ...rest,
    id: crypto.randomUUID(),
    title: `${source.title} (fork)`,
    createdAt: now,
    updatedAt: now,
    // Message ids are kept: they only need to be unique within a thread.
    messages: source.messages,
  };
  conversations.set((all) => [fork, ...all]);
  share({ type: "upsert", conversation: fork });
  persist(() => api.threadSave(meta(fork), fork.messages));
  return fork;
}

/** Delete a chat; for an incognito one this also drops the messages Rust holds for it. */
export function deleteConversation(id: string) {
  conversations.set((all) => all.filter((c) => c.id !== id));
  share({ type: "delete", id });
  persist(() => api.threadDelete(id));
}

/**
 * Make sure a new window can load `id` from disk: an untouched chat is
 * otherwise only in memory. Resolves once every earlier write has landed.
 */
export async function saveForAnotherWindow(id: string) {
  const c = conversations.get().find((c) => c.id === id);
  if (!c) return;
  // A window that opened before this chat was created hasn't heard of it either.
  await broadcast(CONVERSATION_EVENT, { type: "upsert", conversation: c } satisfies Shared);
  if (!c.incognito && c.messages.length === 0) persist(() => api.threadSave(meta(c), []));
  await writes;
}

/** A fresh incognito chat. */
export const createIncognitoConversation = () => createConversation(undefined, "New chat", { incognito: true });

/** Replace one conversation in memory; returns the new value, or null if it's gone. */
function update(id: string, change: (c: Conversation) => Conversation): Conversation | null {
  const current = conversations.get().find((c) => c.id === id);
  if (!current) return null;
  const next = change(current);
  conversations.set((all) => all.map((c) => (c.id === id ? next : c)));
  return next;
}

function meta({ messages: _, ...rest }: Conversation): ThreadMeta {
  return { ...rest, pinned: !!rest.pinned };
}

// Writes run one at a time, in the order they were made, so a slow save can't
// land after a newer one.
let writes = Promise.resolve();

function persist(write: () => Promise<unknown>) {
  writes = writes.then(write).then(
    () => undefined,
    (e) => {
      console.error("Could not save conversation", e);
      toast.error("Couldn’t save your chat", { description: errorMessage(e) });
    },
  );
}

/** Load conversations from disk, importing any left in localStorage by earlier versions. Call before rendering. */
export async function initStore() {
  if (!localStorage.getItem(MIGRATED_KEY)) {
    const legacy = readLegacy();
    if (legacy.length > 0) await api.threadsImport(legacy);
    // The old copy stays in localStorage for one release, in case something needs recovering.
    localStorage.setItem(MIGRATED_KEY, String(Date.now()));
  }
  const threads = await api.threadsLoad();
  conversations.set(threads as Conversation[]);
}

function readLegacy(): StoredThread[] {
  try {
    const raw = localStorage.getItem(LEGACY_CONVERSATIONS_KEY);
    const all = raw ? (JSON.parse(raw) as StoredThread[]) : [];
    return Array.isArray(all) ? all.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)) : [];
  } catch {
    return [];
  }
}

/** An untouched chat if there is one, otherwise a new one. Reads live state, so repeated calls never pile up empty chats. */
export function getOrCreateEmptyConversation(workspaceId?: string, projectId?: string): Conversation {
  return (
    conversations
      .get()
      .find((c) => c.messages.length === 0 && !c.incognito && c.workspaceId === workspaceId && c.projectId === projectId) ??
    createConversation(workspaceId, "New chat", { projectId })
  );
}
