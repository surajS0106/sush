// Chat sessions. Each conversation's agent run lives in Rust (`runs.rs`,
// `sush_core::agent`): it streams model steps, runs connector tools, and
// saves the thread. This module starts and stops runs, mirrors the messages
// they stream (one channel carries every thread, so chats keep going whatever
// is on screen), and runs the tools the UI owns when a run asks.
//
// A message sent while a run works steers it: it waits in the thread's queue
// until the run adds it at its next step boundary. Stopping pauses a reply;
// `resume` carries on with it.

import { Channel } from "@tauri-apps/api/core";
import type { FileUIPart } from "ai";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { buildContext, runTool, runTools, setToolRunning, type ToolResult } from "@/lib/agent";
import { budgetBlock } from "@/lib/budget";
import { expandMentions } from "@/lib/mentions";
import { getProject } from "@/lib/projects";
import { expandSlash } from "@/lib/skills";
import {
  applySaved,
  createStore,
  getAskUser,
  getConversations,
  getTarget,
  showMessages,
  subscribeConversations,
  threadMeta,
} from "@/lib/store";
import {
  api,
  errorMessage,
  type RunAction,
  type RunConfig,
  type RunFrame,
  type RunStatus,
  type ThreadOp,
  type ToolResponse,
} from "@/lib/tauri";
import type { ModelTarget, SushUIMessage } from "@/lib/transport";
import { notifyFilesChanged } from "@/lib/workspaces";

export interface ThreadView {
  messages: SushUIMessage[];
  status: RunStatus;
  error?: string;
}

/** Threads with a run this session. Others are read from the saved conversation. */
const views = createStore<ReadonlyMap<string, ThreadView>>("sush.threads", new Map(), false);
/** Messages sent while a thread's run worked, until the run adds them to the thread. */
const queues = createStore<ReadonlyMap<string, SushUIMessage[]>>("sush.queued", new Map(), false);
/** Per-conversation model and research choice, for its next request. */
const targets = new Map<string, ModelTarget>();
const research = new Map<string, boolean>();

function setView(id: string, change: (v: ThreadView) => ThreadView) {
  views.set((prev) => new Map(prev).set(id, change(prev.get(id) ?? saved(id))));
}

const EMPTY: SushUIMessage[] = [];
const savedViews = new WeakMap<SushUIMessage[], ThreadView>();

/** A view of the saved conversation; cached so `useSyncExternalStore` sees a stable value. */
function saved(id: string): ThreadView {
  const messages = getConversations().find((c) => c.id === id)?.messages ?? EMPTY;
  let view = savedViews.get(messages);
  if (!view) savedViews.set(messages, (view = { messages, status: "ready" }));
  return view;
}

/** Apply a run's change to a thread's messages, exactly as Rust does (`sush_core::agent::ui::apply`). */
export function applyOp(messages: SushUIMessage[], op: ThreadOp): SushUIMessage[] {
  if (op.type === "reset") return op.messages as SushUIMessage[];
  if (op.type === "push") return [...messages, op.message as SushUIMessage];
  const last = messages.at(-1);
  if (!last) return messages;
  type Part = SushUIMessage["parts"][number];
  let next: SushUIMessage;
  switch (op.type) {
    case "push-part":
      next = { ...last, parts: [...last.parts, op.part as Part] };
      break;
    case "append-text": {
      const parts = [...last.parts];
      const p = parts[op.index];
      if (p && "text" in p) parts[op.index] = { ...p, text: p.text + op.delta };
      next = { ...last, parts };
      break;
    }
    case "set-part": {
      const parts = [...last.parts];
      parts[op.index] = op.part as Part;
      next = { ...last, parts };
      break;
    }
    case "set-metadata":
      next = { ...last, metadata: { ...last.metadata, ...op.metadata } };
      break;
  }
  return [...messages.slice(0, -1), next];
}

function setQueue(id: string, change: (q: SushUIMessage[]) => SushUIMessage[]) {
  queues.set((prev) => {
    const next = change(prev.get(id) ?? NONE);
    const map = new Map(prev);
    if (next.length) map.set(id, next);
    else map.delete(id);
    return map;
  });
}

const NONE: SushUIMessage[] = [];

/** Drop queued messages the thread now has. */
function dequeue(id: string, op: ThreadOp) {
  const queued = queues.get().get(id);
  if (!queued || (op.type !== "push" && op.type !== "reset")) return;
  const added = new Set((op.type === "push" ? [op.message] : op.messages).map((m) => (m as SushUIMessage).id));
  if (queued.some((m) => added.has(m.id))) setQueue(id, (q) => q.filter((m) => !added.has(m.id)));
}

function onFrame(frame: RunFrame) {
  switch (frame.type) {
    case "op":
      setView(frame.threadId, (v) => ({ ...v, messages: applyOp(v.messages, frame.op) }));
      dequeue(frame.threadId, frame.op);
      break;
    case "status":
      setView(frame.threadId, (v) => ({ ...v, status: frame.status, error: frame.error ?? undefined }));
      break;
    case "tool-running":
      setToolRunning(frame.callId, frame.running);
      break;
    case "client-tool":
      void runTool(frame.name, frame.input).then((result) =>
        api.toolResult(frame.callId, result).catch((e) => console.error("Could not return a tool result", e)),
      );
      break;
    case "saved":
      applySaved(frame.thread, views.get().get(frame.thread.id)?.messages);
      break;
    case "files-changed":
      notifyFilesChanged(frame.threadId, frame.workspaceId);
      break;
  }
}

/** Follow every run, including ones that were going before the page (re)loaded. Call before rendering. */
export async function initSessions() {
  const channel = new Channel<RunFrame>();
  channel.onmessage = onFrame;
  const live = await api.runsSubscribe(channel);
  for (const run of live) {
    setView(run.threadId, () => ({ messages: run.messages as SushUIMessage[], status: run.status, error: run.error ?? undefined }));
  }
}

// --- actions ------------------------------------------------------------------------

/** The model a conversation's next request goes to. */
export function sessionTarget(id: string): ModelTarget | null {
  return targets.get(id) ?? getConversations().find((c) => c.id === id)?.target ?? getTarget();
}

export function setSessionTarget(id: string, target: ModelTarget) {
  targets.set(id, target);
}

export function setSessionResearch(id: string, on: boolean) {
  research.set(id, on);
}

/** Everything a request needs besides the messages; built fresh for every action. */
function runConfig(id: string, messages: SushUIMessage[]): RunConfig {
  const target = sessionTarget(id);
  if (!target) throw new Error("Pick a model first. Add a provider in Settings if the list is empty.");
  const convo = getConversations().find((c) => c.id === id);
  const ctx = buildContext({
    askUser: getAskUser(),
    research: research.get(id) ?? false,
    incognito: !!convo?.incognito,
    project: getProject(convo?.projectId),
  });
  // `/skill args` reaches the model as the skill's instructions plus the arguments,
  // and `@connector` with a note to use that connector.
  const expansions: Record<string, string> = {};
  for (const m of messages) {
    const text = m.role === "user" ? m.parts.find((p) => p.type === "text")?.text : undefined;
    const expanded = text === undefined ? undefined : expandMentions(expandSlash(text), text);
    if (expanded !== undefined && expanded !== text) expansions[m.id] = expanded;
  }
  return {
    providerId: target.providerId,
    model: target.model,
    system: ctx.system ?? null,
    tools: runTools(ctx.tools),
    research: ctx.research,
    expansions,
  };
}

async function start(id: string, action: RunAction, messages: SushUIMessage[]) {
  const thread = threadMeta(id);
  if (!thread) return;
  try {
    const config = runConfig(id, messages);
    // Past the budget's limit, new requests wait; finishing a turn that's waiting on a tool call doesn't.
    const blocked = action.type === "respond" ? null : budgetBlock(config.providerId);
    if (blocked) throw new Error(blocked);
    await api.runStart(thread, action, config);
  } catch (e) {
    // A steer that fails leaves the run it was meant for going; it stays queued, unsent.
    if (action.type === "steer") toast.error("Couldn’t send that message", { description: errorMessage(e) });
    else setView(id, (v) => ({ ...v, status: "error", error: errorMessage(e) }));
  }
}

const current = (id: string) => views.get().get(id)?.messages ?? saved(id).messages;

function userMessage(id: string, text: string, files: FileUIPart[]): SushUIMessage {
  return { id, role: "user", parts: text ? [...files, { type: "text", text }] : files };
}

/** Several messages as one, attachments first. */
function merge(messages: SushUIMessage[]): SushUIMessage {
  if (messages.length === 1) return messages[0];
  const parts = messages.flatMap((m) => m.parts);
  const files = parts.filter((p): p is FileUIPart => p.type === "file");
  const text = parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n\n");
  return userMessage(crypto.randomUUID(), text, files);
}

const isBusy = (id: string) => {
  const status = views.get().get(id)?.status;
  return status === "submitted" || status === "streaming";
};

/**
 * Send a message. While the run works, it steers the run instead: the run
 * adds it at its next step boundary. Otherwise anything still queued (from a
 * run that stopped before taking it) goes along with it.
 */
export function sendMessage(id: string, text: string, files: FileUIPart[]) {
  const sent = userMessage(crypto.randomUUID(), text, files);
  if (isBusy(id)) {
    setQueue(id, (q) => [...q, sent]);
    void start(id, { type: "steer", message: sent }, [...current(id), ...(queues.get().get(id) ?? NONE)]);
    return;
  }
  send(id, [...(queues.get().get(id) ?? NONE), sent]);
}

/** Send what's queued now, stopping the run if it's still working. */
export function sendQueued(id: string) {
  const queued = queues.get().get(id);
  if (queued?.length) send(id, queued);
}

/** Take a message out of the queue. Only before a run has it: once steered, it can't be called back. */
export function unqueue(id: string, messageId: string) {
  setQueue(id, (q) => q.filter((m) => m.id !== messageId));
}

function send(id: string, outgoing: SushUIMessage[]) {
  setQueue(id, () => NONE);
  const message = merge(outgoing);
  const messages = [...current(id), message];
  // Show it right away; the run's first update replaces this with the same.
  setView(id, (v) => ({ ...v, messages, status: "submitted", error: undefined }));
  showMessages(id, messages);
  void start(id, { type: "send", message, replace: null }, messages);
}

/** Replace a user message, dropping everything after it, and ask again. */
export function editMessage(id: string, messageId: string, text: string, files: FileUIPart[]) {
  const message = userMessage(messageId, text, files);
  const all = current(id);
  const at = all.findIndex((m) => m.id === messageId);
  const messages = [...(at < 0 ? all : all.slice(0, at)), message];
  setView(id, (v) => ({ ...v, messages, status: "submitted", error: undefined }));
  void start(id, { type: "send", message, replace: messageId }, messages);
}

/** Ask again for an assistant message (by default the last one). */
export function regenerate(id: string, messageId?: string) {
  setView(id, (v) => ({ ...v, status: "submitted", error: undefined }));
  void start(id, { type: "regenerate", messageId: messageId ?? null }, current(id));
}

/** Answer a tool call that waits for the user: an approval, a denial, or a result. */
export function respond(id: string, callId: string, response: ToolResponse) {
  void start(id, { type: "respond", callId, response }, current(id));
}

/** A tool card's result as a response. */
export const toResponse = (result: ToolResult): ToolResponse =>
  "output" in result ? { type: "output", output: result.output } : { type: "error", errorText: result.errorText };

/** Carry on with a stopped reply, or answer a message the app closed on. */
export function resume(id: string) {
  setView(id, (v) => ({ ...v, status: "submitted", error: undefined }));
  void start(id, { type: "resume" }, current(id));
}

/** Stop (pause) the run: the model stream and any tool calls in flight. The reply can be resumed. */
export function stop(id: string) {
  void api.runCancel(id).catch((e) => console.error("Could not stop the run", e));
}

export function clearError(id: string) {
  if (views.get().get(id)?.error) setView(id, (v) => ({ ...v, error: undefined, status: v.status === "error" ? "ready" : v.status }));
}

// --- hooks --------------------------------------------------------------------------

function subscribe(listener: () => void) {
  const a = views.subscribe(listener);
  const b = subscribeConversations(listener);
  return () => {
    a();
    b();
  };
}

/** A conversation's messages and run status, live while a run streams. */
export function useThread(id: string): ThreadView {
  return useSyncExternalStore(subscribe, () => views.get().get(id) ?? saved(id));
}

/** Messages waiting to steer a thread's run, oldest first. */
export function useQueued(id: string): SushUIMessage[] {
  return useSyncExternalStore(queues.subscribe, () => queues.get().get(id) ?? NONE);
}

/** `working`: streaming or running tools. `needs-input`: waiting on an approval or an answer. */
export type SessionStatus = "working" | "needs-input";

export function useSessionStatus(id: string): SessionStatus | null {
  return useSyncExternalStore(views.subscribe, () => {
    const status = views.get().get(id)?.status;
    return status === "submitted" || status === "streaming" ? "working" : status === "awaiting" ? "needs-input" : null;
  });
}

/** Across every Cowork session: `needs-input` if any is waiting on the user, else `working` if any is running. */
export function useCoworkStatus(): SessionStatus | null {
  return useSyncExternalStore(subscribe, () => {
    let working = false;
    for (const c of getConversations()) {
      if (!c.workspaceId) continue;
      const status = views.get().get(c.id)?.status;
      if (status === "awaiting") return "needs-input";
      if (status === "submitted" || status === "streaming") working = true;
    }
    return working ? "working" : null;
  });
}
