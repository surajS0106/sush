// Conversation and preference state.
//
// Conversations live in SQLite on the Rust side (`sush_core::store`). They're
// loaded once at startup (`initStore`) and kept in memory here, so reads stay
// synchronous. Agent runs save their own threads (`runs.rs`) and this copy
// mirrors those saves (`applySaved`); the UI's own changes (pins, deletes)
// are written through to Rust in order. Preferences stay in localStorage.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { api, errorMessage, type StoredThread, type ThreadMeta } from "@/lib/tauri";
import type { ModelTarget, SushUIMessage } from "@/lib/transport";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  target?: ModelTarget;
  pinned?: boolean;
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

/** Tiny observable store; components subscribe via `useSyncExternalStore`. */
export function createStore<T>(key: string, initial: T, persist = true) {
  let state = persist ? read(key, initial) : initial;
  const listeners = new Set<() => void>();
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

export function createConversation(): Conversation {
  const now = Date.now();
  // Saved once it has messages, so untouched chats don't pile up on disk.
  const convo: Conversation = { id: crypto.randomUUID(), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
  conversations.set((all) => [convo, ...all]);
  return convo;
}

export function togglePinned(id: string) {
  const next = update(id, (c) => ({ ...c, pinned: !c.pinned }));
  if (next) persist(() => api.threadSave(meta(next), next.messages.length > 0 ? null : []));
}

export function deleteConversation(id: string) {
  conversations.set((all) => all.filter((c) => c.id !== id));
  persist(() => api.threadDelete(id));
}

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
export function getOrCreateEmptyConversation(): Conversation {
  return conversations.get().find((c) => c.messages.length === 0) ?? createConversation();
}
