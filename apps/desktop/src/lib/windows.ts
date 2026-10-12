// The app's windows. The first is "main"; a tab dragged out of the strip opens
// in a window of its own (`windows.rs`), running this same page. Each window
// keeps its own in-memory copy of the store, so a change made in one is
// broadcast for the others to apply. One window, the leader ("main" while it's
// open), runs what must happen once: UI-owned tool calls and automations.

import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

declare global {
  interface Window {
    /** Set by `windows.rs` on a window opened for a dragged-out tab. */
    __SUSH_OPEN_SESSION__?: string;
  }
}

export const WINDOW_LABEL = getCurrentWindow().label;
export const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

/** The session this window was opened to show, for one opened from a dragged-out tab. */
export const openedSession: string | null = window.__SUSH_OPEN_SESSION__ ?? null;

interface Broadcast<T> {
  from: string;
  payload: T;
}

/** Tell the other windows about a change made in this one; resolves once it's sent. */
export function broadcast<T>(event: string, payload: T): Promise<void> {
  return emit(event, { from: WINDOW_LABEL, payload } satisfies Broadcast<T>).catch((e) =>
    console.error(`Could not tell other windows about ${event}`, e),
  );
}

/** Apply changes the other windows broadcast. */
export function onBroadcast<T>(event: string, apply: (payload: T) => void) {
  void listen<Broadcast<T>>(event, (e) => {
    if (e.payload.from !== WINDOW_LABEL) apply(e.payload.payload);
  });
}

// Rust announces the leader (`runs.rs`) whenever a window subscribes to runs or closes.
// Listening from import, which comes before `initSessions` subscribes, so the first announcement isn't missed.
let leading = false;
const waiting: (() => void)[] = [];
void listen<string>("sush://leader", (e) => {
  if (leading || e.payload !== WINDOW_LABEL) return;
  leading = true;
  waiting.splice(0).forEach((start) => start());
});

/** Call `start` now if this window leads, or once it does. */
export function whenLeader(start: () => void) {
  if (leading) start();
  else waiting.push(start);
}

/** A tab from another window's drag, over or dropped on this window's strip, `x` CSS pixels from the left. */
export interface AttachTab {
  threadId: string;
  x: number;
}

/** A tab from another window being dragged over this window's strip (null once it leaves). */
export function onTabHover(hover: (tab: AttachTab | null) => void) {
  const unlisten = getCurrentWindow().listen<AttachTab | null>("sush://tab-hover", (e) => hover(e.payload));
  return () => void unlisten.then((fn) => fn());
}

/** Rust sends these to one window; the window's own `listen` hears only those (the module's hears any window's). */
export function onAttachTab(attach: (tab: AttachTab) => void) {
  const unlisten = getCurrentWindow().listen<AttachTab>("sush://attach-tab", (e) => attach(e.payload));
  return () => void unlisten.then((fn) => fn());
}
