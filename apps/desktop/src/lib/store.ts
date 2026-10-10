// Conversation and preference state.
//
// Interim: conversations live in localStorage. M4 moves them into SQLite on
// the Rust side; this module's API is what the UI depends on, so only its
// internals change then.

import { useSyncExternalStore } from "react";

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

const CONVERSATIONS_KEY = "sush.conversations";
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

const conversations = createStore<Conversation[]>(CONVERSATIONS_KEY, []);
const target = createStore<ModelTarget | null>(TARGET_KEY, null);
const askUser = createStore<boolean>(ASK_USER_KEY, true);
// Which conversation is mid-turn. Session-only: a stream never survives a restart.
const running = createStore<string | null>("sush.running", null, false);

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

export function useRunningId() {
  return useSyncExternalStore(running.subscribe, running.get);
}

export function setRunning(id: string, busy: boolean) {
  running.set((cur) => (busy ? id : cur === id ? null : cur));
}

export function createConversation(): Conversation {
  const now = Date.now();
  const convo: Conversation = { id: crypto.randomUUID(), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
  conversations.set((all) => [convo, ...all]);
  return convo;
}

export function saveMessages(id: string, messages: SushUIMessage[], usedTarget: ModelTarget | null) {
  conversations.set((all) =>
    all.map((c) =>
      c.id === id
        ? {
            ...c,
            messages,
            title: c.title === "New chat" ? titleFrom(messages) : c.title,
            target: usedTarget ?? c.target,
            updatedAt: Date.now(),
          }
        : c,
    ),
  );
}

export function togglePinned(id: string) {
  conversations.set((all) => all.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
}

export function deleteConversation(id: string) {
  conversations.set((all) => all.filter((c) => c.id !== id));
}

function titleFrom(messages: SushUIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.parts.find((p) => p.type === "text")?.text.trim();
  if (!text) return "New chat";
  const line = text.split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** An untouched chat if there is one, otherwise a new one. Reads live state, so repeated calls never pile up empty chats. */
export function getOrCreateEmptyConversation(): Conversation {
  return conversations.get().find((c) => c.messages.length === 0) ?? createConversation();
}
