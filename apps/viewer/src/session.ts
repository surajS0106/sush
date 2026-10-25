// A shared session as a browser guest sees it: the relay connection, the
// host's messages applied in order (as `sush_core::share::replica` does), and
// the few things a browser guest asks for (attachments, and comments). It
// watches and comments; steering and approvals stay in the desktop app.
//
// The host is authoritative: what it sends is redacted already, and anything
// asked of it is checked there against this guest's role.

import { Device, generationOf, isSealed, open, seal, type ShareKey } from "./crypto";

export type Role = "owner" | "driver" | "collaborator" | "viewer";
export type RunStatus = "submitted" | "streaming" | "awaiting" | "ready" | "error";

export interface Member {
  userId: string;
  name: string;
  image?: string | null;
  role: Role;
  online: boolean;
}

export interface Author {
  userId: string;
  name: string;
  image?: string | null;
}

export interface Comment {
  id: string;
  author: Author;
  text: string;
  messageId?: string | null;
  at: number;
}

export interface Part {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  mediaType?: string;
  url?: string;
  filename?: string;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Part[];
  metadata?: { author?: Author; acceptedBy?: Author; [key: string]: unknown };
}

type Op =
  | { type: "reset"; messages: Message[] }
  | { type: "push"; message: Message }
  | { type: "push-part"; part: Part }
  | { type: "append-text"; index: number; delta: string }
  | { type: "set-part"; index: number; part: Part }
  | { type: "set-metadata"; metadata: Record<string, unknown> };

/** As `sush_core::agent::ui::apply`, on a copy. */
function applyOp(messages: Message[], op: Op): Message[] {
  if (op.type === "reset") return op.messages;
  if (op.type === "push") return [...messages, op.message];
  const last = messages.at(-1);
  if (!last) return messages;
  const parts = [...(last.parts ?? [])];
  let next: Message = last;
  switch (op.type) {
    case "push-part":
      next = { ...last, parts: [...parts, op.part] };
      break;
    case "append-text": {
      const p = parts[op.index];
      if (!p || typeof p.text !== "string") return messages;
      parts[op.index] = { ...p, text: p.text + op.delta };
      next = { ...last, parts };
      break;
    }
    case "set-part":
      if (op.index >= parts.length) return messages;
      parts[op.index] = op.part;
      next = { ...last, parts };
      break;
    case "set-metadata":
      next = { ...last, metadata: { ...(last.metadata ?? {}), ...op.metadata } };
      break;
  }
  return [...messages.slice(0, -1), next];
}

export interface ThreadInfo {
  title: string;
  kind: "chat" | "cowork";
  workspaceName?: string | null;
  hostName: string;
}

export type Link = "signing-in" | "connecting" | "lobby" | "live" | "offline" | "ended";

export interface View {
  link: Link;
  error: string | null;
  thread: ThreadInfo;
  messages: Message[];
  status: RunStatus;
  members: Member[];
  comments: Comment[];
  hostOnline: boolean;
  ownerAway: number | null;
  me: string | null;
  e2e: boolean;
}

interface HostMsg {
  type: string;
  epoch?: number;
  seq?: number;
  child?: string | null;
  [key: string]: unknown;
}

const MAX_COMMENTS = 200;

export class Session {
  private view: View;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private at: [number, number] | null = null;
  private replies = new Map<string, (r: { ok: boolean; data?: unknown; error?: string }) => void>();
  private keys: ShareKey[] = [];
  private device = new Device();
  private retry = 1000;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private shareId: string,
    info: ThreadInfo,
    key: ShareKey | null,
  ) {
    if (key) this.keys = [key];
    this.view = {
      link: "connecting",
      error: null,
      thread: info,
      messages: [],
      status: "ready",
      members: [],
      comments: [],
      hostOnline: false,
      ownerAway: null,
      me: null,
      e2e: !!key,
    };
  }

  get = () => this.view;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn();
  }

  connect() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/shares/${encodeURIComponent(this.shareId)}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => (this.retry = 1000);
    ws.onmessage = (e) => typeof e.data === "string" && this.onFrame(e.data);
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.set({ link: "offline", error: "Reconnecting…" });
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.ws?.close();
  }

  private toHost(msg: object) {
    const text = JSON.stringify({ v: 1, ...msg });
    const key = this.keys.at(-1);
    const body = key ? seal(key, this.shareId, this.device.signed(text)) : text;
    this.ws?.send(JSON.stringify({ t: "send", to: "host", body }));
  }

  private hello(tries = 0) {
    this.toHost({ type: "hello", minV: 1, caps: [], device: this.keys.length ? this.device.keys() : null });
    // The host answers with a snapshot; if none comes, ask again rather than sit empty.
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (this.at || this.closed || this.view.link !== "live") return;
      if (tries >= 3) return this.set({ error: `${this.view.thread.hostName}’s app isn’t answering. Try reloading the page.` });
      this.hello(tries + 1);
    }, 5000);
  }

  private onFrame(raw: string) {
    let f: { t: string; [key: string]: unknown };
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    switch (f.t) {
      case "welcome": {
        const admitted = !!f.admitted;
        const hostOnline = !!f.hostOnline;
        this.set({
          me: (f.you as { userId?: string } | undefined)?.userId ?? null,
          hostOnline,
          link: !admitted ? "lobby" : hostOnline ? "live" : "offline",
          error: admitted && !hostOnline ? `${this.view.thread.hostName} is offline. Waiting for them to come back…` : null,
        });
        if (admitted && hostOnline) this.hello();
        return;
      }
      case "admitted":
        this.set({ link: this.view.hostOnline ? "live" : "offline" });
        if (this.view.hostOnline) this.hello();
        return;
      case "host-online":
        this.set({ hostOnline: true, link: this.view.link === "lobby" ? "lobby" : "live", error: null });
        if (this.view.link !== "lobby") this.hello();
        return;
      case "host-offline":
        this.set({ hostOnline: false, link: this.view.link === "lobby" ? "lobby" : "offline", error: `${this.view.thread.hostName} is offline.` });
        return;
      case "closed":
        this.closed = true;
        this.set({ link: "ended", error: closedReason(String(f.reason ?? "")) });
        return;
      case "recv": {
        const from = f.from as { isHost?: boolean } | undefined;
        if (!from?.isHost || typeof f.body !== "string") return;
        this.onHost(f.body);
        return;
      }
    }
  }

  private onHost(body: string) {
    let text: string | null = body;
    if (this.keys.length) {
      text = open(this.keys, this.shareId, body);
      if (text === null) {
        // Sealed with a key we missed: the host sends it along with a fresh snapshot.
        const g = generationOf(body);
        if (g !== null && !this.keys.some((k) => k.generation === g)) this.resync();
        return;
      }
    } else if (isSealed(body)) {
      return;
    }
    let msg: HostMsg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.resync();
    }
    if (msg.v !== 1) return;
    switch (msg.type) {
      case "reply": {
        const done = this.replies.get(String(msg.re));
        this.replies.delete(String(msg.re));
        done?.({ ok: !!msg.ok, data: msg.data, error: msg.error as string | undefined });
        return;
      }
      case "rekey": {
        const generation = Number(msg.generation);
        if (this.keys.some((k) => k.generation === generation)) return;
        const key = this.device.openSealed(this.shareId, generation, String(msg.sealed));
        if (key) this.keys = [...this.keys, key].sort((a, b) => a.generation - b.generation);
        return;
      }
      case "incompatible":
        this.set({ error: "The host's Sush is a different version from this page's." });
        return;
      case "snapshot":
        return this.snapshot(msg);
    }
    // The ordered stream: each message must be the next one.
    if (typeof msg.epoch !== "number" || typeof msg.seq !== "number" || !this.at) return;
    const [epoch, seq] = this.at;
    if (msg.epoch < epoch) return;
    if (msg.epoch > epoch || msg.seq > seq + 1) return this.resync();
    if (msg.seq <= seq) return;
    this.at = [msg.epoch, msg.seq];
    // Sub-agents' threads aren't shown here; their ops still count toward the order.
    if (msg.child) return;
    switch (msg.type) {
      case "op":
        this.set({ messages: applyOp(this.view.messages, msg.op as Op) });
        return;
      case "status":
        this.set({ status: msg.status as RunStatus });
        return;
      case "members":
        this.set({ members: msg.members as Member[], ownerAway: (msg.ownerAway as number | null) ?? null });
        return;
      case "thread":
        this.set({ thread: msg.thread as ThreadInfo });
        return;
      case "comment":
        this.set({ comments: [...this.view.comments, msg.comment as Comment].slice(-MAX_COMMENTS) });
        return;
    }
  }

  private snapshot(msg: HostMsg) {
    this.at = [Number(msg.epoch), Number(msg.seq)];
    const threads = (msg.threads as { child?: string | null; messages: Message[]; status: RunStatus }[]) ?? [];
    const main = threads.find((t) => !t.child);
    this.set({
      link: "live",
      error: null,
      thread: msg.thread as ThreadInfo,
      messages: main?.messages ?? [],
      status: main?.status ?? "ready",
      members: (msg.members as Member[]) ?? [],
      comments: (msg.comments as Comment[]) ?? [],
      ownerAway: (msg.ownerAway as number | null) ?? null,
    });
  }

  private resync() {
    const last = this.at?.[1] ?? 0;
    this.at = null;
    this.toHost({ type: "resync", lastSeq: last });
  }

  /** Ask the host for something; it checks it against this guest's role. */
  request<T>(intent: object): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        reject(new Error("The host didn't answer."));
      }, 30_000);
      this.replies.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.data as T);
        else reject(new Error(r.error ?? "The host said no."));
      });
      this.toHost({ type: "intent", id, intent });
    });
  }

  role(): Role {
    return this.view.members.find((m) => m.userId === this.view.me)?.role ?? "viewer";
  }
}

function closedReason(reason: string) {
  return (
    {
      ended: "The host ended the session.",
      expired: "The session reached its time limit.",
      kicked: "The host removed you from the session.",
      denied: "The host didn't let you in.",
      superseded: "This session was opened somewhere else.",
    }[reason] ?? "The session closed."
  );
}
