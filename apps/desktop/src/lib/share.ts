// Live shared sessions ("Sush Multiplayer"). Rust does the work (`share.rs`):
// it holds the connection to the relay, decides what guests may see, and
// turns a joined share into ordinary run frames for `shared:<id>` threads,
// which `sessions.ts` shows like any other. This module mirrors the `share`
// frames (who's watching, the lobby, the connection), and has the actions the
// share dialog, the header's presence and the join dialog use.
//
// Rust owns the state and sends every window the same frames, so nothing here
// needs broadcasting between windows. Only the leader window raises toasts.

import { createContext, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { setToolRunning } from "@/lib/agent";
import { AUTH_URL, getAuthToken } from "@/lib/auth";
import { forgetThreads, onShareFrames, seedThread } from "@/lib/sessions";
import { createStore, threadMeta } from "@/lib/store";
import {
  api,
  errorMessage,
  type FileView,
  type RunFrame,
  type ShareAccount,
  type ShareMember,
  type ShareView,
  type WorkspaceEntry,
} from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";
import { isLeader } from "@/lib/windows";

/** Shares hosted here (by their thread) and joined (by `shared:<id>`). Ended ones stay until left. */
const shares = createStore<ReadonlyMap<string, ShareView>>("sush.shares", new Map(), false);

/** The host's name while a joined share is on screen: tool cards say they wait for them. */
export const WatchingHost = createContext<string | null>(null);

/** A picture to show for someone: a `data:` image or a built-in avatar. Never a URL to fetch. */
export function safeImage(image: string | null | undefined): string | null {
  if (!image) return null;
  if (image.startsWith("sush:avatar/")) return image;
  if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) return image;
  return null;
}

/** Who this app is on the relay, to leave out of "joined" notices. */
let me: string | null = null;

function apply(frame: Extract<RunFrame, { type: "share" | "share-gone" }>) {
  if (frame.type === "share-gone") {
    const prev = shares.get().get(frame.threadId);
    shares.set((all) => {
      const next = new Map(all);
      next.delete(frame.threadId);
      return next;
    });
    if (prev && prev.role !== "owner") forgetThreads(frame.threadId);
    return;
  }
  const next = frame.share;
  const prev = shares.get().get(next.threadId);
  if (isLeader()) announce(prev, next);
  shares.set((all) => new Map(all).set(next.threadId, next));
}

const online = (v: ShareView | undefined) => new Map((v?.members ?? []).filter((m) => m.online).map((m) => [m.userId, m]));

/** Toasts for what changed: someone knocking, joining or leaving, the share ending. */
function announce(prev: ShareView | undefined, next: ShareView) {
  if (next.role === "owner") {
    const known = new Set(prev?.lobby.map((p) => p.peerId));
    for (const p of next.lobby) {
      if (known.has(p.peerId)) continue;
      toast(`${p.name} wants to watch`, {
        description: p.email ? `${p.email} · ${next.thread.title}` : next.thread.title,
        duration: Infinity,
        action: { label: "Let in", onClick: () => void admit(next.threadId, p.userId, true) },
        cancel: { label: "Turn away", onClick: () => void admit(next.threadId, p.userId, false) },
      });
    }
  }
  // Only changes while connected: not everyone already there when it (re)connects.
  if (prev?.status === "live" && next.status === "live") {
    const before = online(prev);
    const after = online(next);
    for (const [id, m] of after) if (!before.has(id) && id !== me && m.role !== "owner") toast(`${m.name} joined`, { description: next.thread.title });
    for (const [id, m] of before) if (!after.has(id) && id !== me && m.role !== "owner") toast(`${m.name} left`, { description: next.thread.title });
  }
  if (prev && prev.status !== "ended" && next.status === "ended" && next.ended) {
    toast(next.role === "owner" ? "Sharing stopped" : "The shared session closed", { description: next.ended });
  }
  if (prev?.status === "lobby" && next.status === "live") toast.success(`You’re watching ${next.thread.hostName}’s session`);
}

/** Follow shares, including ones that were going before the page (re)loaded. Call after `initSessions`. */
export async function initShares() {
  onShareFrames(apply);
  // Sharing never stops the app from opening.
  const state = await api.sharesState().catch((e) => {
    console.error("Could not load shared sessions", e);
    return null;
  });
  if (!state) return;
  shares.set(new Map(state.shares.map((s) => [s.threadId, s])));
  for (const t of state.threads) {
    seedThread(t.threadId, { messages: t.messages as SushUIMessage[], status: t.status, error: t.error ?? undefined });
  }
  for (const callId of state.running) setToolRunning(callId, true);
  void api.shareAccount().then(
    (a) => (me = a.user?.id ?? null),
    () => {},
  );
}

// --- reading ------------------------------------------------------------------------

/** The share a thread is in (hosted, or joined), if any. */
export function useShare(threadId: string | undefined): ShareView | null {
  return useSyncExternalStore(shares.subscribe, () => (threadId ? (shares.get().get(threadId) ?? null) : null));
}

/** Shares joined here, newest last. */
export function useJoinedShares(): ShareView[] {
  const all = useSyncExternalStore(shares.subscribe, shares.get);
  return useMemo(() => [...all.values()].filter((s) => s.role !== "owner"), [all]);
}

/** Whether a hosted share is still going (an ended one can be started again). */
export const isLive = (s: ShareView | null): s is ShareView & { status: Exclude<ShareView["status"], "ended"> } =>
  !!s && s.status !== "ended";

/** Everyone watching now, the host first. */
export function watchers(s: ShareView): ShareMember[] {
  return s.members.filter((m) => m.online).sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.name.localeCompare(b.name)));
}

// --- hosting ------------------------------------------------------------------------

export async function startShare(threadId: string) {
  const thread = threadMeta(threadId);
  if (!thread) throw new Error("This session is gone.");
  return api.shareStart(thread);
}

/** A fresh invite link, copied to the clipboard. Each one can be revoked on its own. */
export async function copyInvite(threadId: string) {
  const invite = await api.shareInviteCreate(threadId);
  await navigator.clipboard.writeText(invite.link);
  return invite;
}

export function admit(threadId: string, userId: string, allow: boolean) {
  return api.shareAdmit(threadId, userId, allow).catch((e) => toast.error("Couldn’t answer", { description: errorMessage(e) }));
}

export const kick = (threadId: string, userId: string) => api.shareKick(threadId, userId);
export const setBrowseFiles = (threadId: string, browseFiles: boolean) => api.shareSetPolicy(threadId, { browseFiles });
export const endShare = (threadId: string) => api.shareEnd(threadId);
export const listInvites = (threadId: string) => api.shareInvitesList(threadId);
export const revokeInvite = (threadId: string, inviteId: string) => api.shareInviteRevoke(threadId, inviteId);

// --- joining ------------------------------------------------------------------------

/** Join from an invite link; returns the thread the share shows as. */
export async function joinShare(link: string): Promise<string> {
  const view = await api.shareJoin(link);
  shares.set((all) => new Map(all).set(view.threadId, view));
  return view.threadId;
}

export async function leaveShare(threadId: string) {
  await api.shareLeave(threadId);
}

/** A file the shared session worked on (or any, if the host lets guests browse). */
export const requestFile = (threadId: string, path: string) => api.shareRequest<FileView>(threadId, { kind: "get-file", path });

/** One folder level of the shared session's folder, if the host lets guests browse. */
export const requestDir = (threadId: string, path: string) => api.shareRequest<WorkspaceEntry[]>(threadId, { kind: "list-dir", path });

// --- the relay account --------------------------------------------------------------

const account = createStore<ShareAccount | null>("sush.shareAccount", null, false);

export function useShareAccount() {
  return useSyncExternalStore(account.subscribe, account.get);
}

export async function refreshShareAccount() {
  const a = await api.shareAccount();
  me = a.user?.id ?? null;
  account.set(a);
  return a;
}

/** The address a new relay setup starts from: the server this app signs in to. */
export const DEFAULT_RELAY = AUTH_URL;

/** Share through the server this app signs in to, with this app's own session. */
export async function shareWithAppAccount(relayUrl = DEFAULT_RELAY) {
  const token = getAuthToken();
  if (!token) throw new Error("Sign in to Sush first.");
  account.set(await api.shareAccountUseToken(relayUrl, token));
  me = account.get()?.user?.id ?? null;
}

export async function signInToRelay(relayUrl: string, email: string, password: string, name?: string) {
  account.set(await api.shareAccountSignIn(relayUrl, email, password, name));
  me = account.get()?.user?.id ?? null;
}

export async function signOutOfRelay() {
  await api.shareAccountSignOut();
  me = null;
  account.set({ relayUrl: null, user: null, error: null });
}
