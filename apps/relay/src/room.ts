// One shared session's room: a Durable Object per share, holding the host's and
// guests' WebSockets. It does what the Bun relay's rooms do
// (`apps/server/src/share/relay.ts`; keep the two in step): forward bodies it
// never reads, stamp who each is from, keep guests in the lobby until the host
// admits them, and rate-limit guests.
//
// It uses the Hibernation API, so an idle room costs nothing: who each socket
// is lives in the object's own SQLite, keyed by the peer id in the socket's
// attachment, and the host's grace period and the share's end are alarms.

import { DurableObject } from "cloudflare:workers";

import { BURST, GUEST_MAX_BYTES, HOST_GRACE_MS, peerOf, RATE, type Peer, type UserRow } from "../../server/src/share/common";
import { planFor } from "../../server/src/share/plans";
import { guestCount, recordEnd, user } from "./db";
import type { Env } from "./env";

/** The header the Worker passes who's connecting in (`routes.ts`); only the Worker can reach a room. */
export const JOINING_HEADER = "X-Sush-Joining";

/** Who's connecting, as the Worker checked them. */
export interface Joining {
  shareId: string;
  expiresAt: number;
  user: UserRow;
  isHost: boolean;
  /** A guest's invite: "viewer" or "collaborator". */
  roleCap?: string;
  admitted: boolean;
}

interface Conn {
  ws: WebSocket;
  peer: Peer;
  email: string;
  admitted: boolean;
}

type Frame = { t?: string; to?: string; body?: unknown; userId?: string; allow?: boolean };

const send = (conn: Conn | undefined, frame: object) => {
  try {
    conn?.ws.send(JSON.stringify(frame));
  } catch {
    // Closing; its close handler cleans up.
  }
};

function close(conn: Conn, reason: string) {
  send(conn, { t: "closed", reason });
  try {
    conn.ws.close(1000, reason);
  } catch {
    // Already gone.
  }
}

export class Room extends DurableObject<Env> {
  /** Guests' token buckets. Lost when the room hibernates, by which time they'd be full again anyway. */
  private buckets = new Map<string, { tokens: number; refilledAt: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS peer (peer_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // The apps' keepalives are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ t: "ping" }), JSON.stringify({ t: "pong" })));
  }

  async fetch(request: Request): Promise<Response> {
    const joining = JSON.parse(decodeURIComponent(request.headers.get(JOINING_HEADER) ?? "null")) as Joining | null;
    if (!joining || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket.", { status: 426 });
    }
    this.setMeta("share", JSON.stringify({ id: joining.shareId, expiresAt: joining.expiresAt }));
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const peer = peerOf(joining.user, joining.isHost, joining.roleCap);
    server.serializeAttachment({ peerId: peer.peerId });
    const conn: Conn = { ws: server, peer, email: joining.user.email, admitted: joining.isHost || joining.admitted };
    this.save(conn);
    this.opened(conn);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  private opened(conn: Conn) {
    if (conn.peer.isHost) {
      // The host's newer connection wins; the old one leaves without telling anyone.
      for (const old of this.conns().filter((c) => c.peer.isHost && c.ws !== conn.ws)) {
        this.forget(old);
        close(old, "superseded");
      }
      this.setMeta("hostGoneAt", null);
      const guests = this.conns().filter((c) => !c.peer.isHost);
      send(conn, {
        t: "welcome",
        you: conn.peer,
        peers: guests.filter((g) => g.admitted).map((g) => g.peer),
        lobby: guests.filter((g) => !g.admitted).map((g) => ({ ...g.peer, email: g.email })),
        hostOnline: true,
        admitted: true,
      });
      this.toAdmitted({ t: "host-online" });
      return;
    }
    const host = this.host();
    send(conn, {
      t: "welcome",
      you: conn.peer,
      peers: [...(host ? [host.peer] : []), ...this.admitted().filter((g) => g.ws !== conn.ws).map((g) => g.peer)],
      hostOnline: !!host,
      admitted: conn.admitted,
    });
    if (conn.admitted) {
      send(host, { t: "peer-joined", peer: conn.peer });
      this.toAdmitted({ t: "peer-joined", peer: conn.peer }, conn.peer.peerId);
    } else {
      send(host, { t: "knock", peer: { ...conn.peer, email: conn.email } });
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const conn = this.conn(ws);
    if (!conn || typeof message !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(message);
    } catch {
      return send(conn, { t: "error", code: "bad-frame" });
    }
    if (frame.t === "ping") return send(conn, { t: "pong" });
    if (conn.peer.isHost) return this.fromHost(conn, frame);

    // A guest: rate limited, small messages, only to the host, only once admitted.
    const now = Date.now();
    const bucket = this.buckets.get(conn.peer.peerId) ?? { tokens: BURST, refilledAt: now };
    bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.refilledAt) / 1000) * RATE);
    bucket.refilledAt = now;
    this.buckets.set(conn.peer.peerId, bucket);
    if (bucket.tokens < 1) return send(conn, { t: "error", code: "rate-limited" });
    bucket.tokens -= 1;
    if (message.length > GUEST_MAX_BYTES) return send(conn, { t: "error", code: "too-large" });
    if (frame.t !== "send" || typeof frame.body !== "string" || !conn.admitted) return;
    send(this.host(), { t: "recv", from: conn.peer, body: frame.body, ts: now });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const conn = this.conn(ws);
    if (conn) {
      this.left(conn);
      await this.schedule();
    }
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "error");
  }

  private async fromHost(host: Conn, frame: Frame) {
    if (frame.t === "send" && typeof frame.body === "string") {
      const out = { t: "recv", from: host.peer, body: frame.body, ts: Date.now() };
      if (frame.to === "all" || !frame.to) return this.toAdmitted(out);
      const guest = this.conns().find((c) => c.peer.peerId === frame.to);
      if (guest?.admitted) send(guest, out);
      return;
    }
    const share = this.share();
    if (frame.t !== "admit" || typeof frame.userId !== "string" || !share) return;
    const waiting = this.conns().filter((g) => !g.peer.isHost && g.peer.userId === frame.userId && !g.admitted);
    if (frame.allow) {
      const owner = await user(this.env.DB, host.peer.userId);
      if (owner && (await guestCount(this.env.DB, share.id)) >= planFor(owner).maxGuests) return send(host, { t: "error", code: "full" });
      await this.env.DB.prepare("UPDATE share_member SET admitted = 1 WHERE share_id = ? AND user_id = ?").bind(share.id, frame.userId).run();
      for (const g of waiting) {
        g.admitted = true;
        this.save(g);
        send(g, { t: "admitted", peers: [host.peer, ...this.admitted().filter((o) => o.ws !== g.ws).map((o) => o.peer)] });
        send(host, { t: "peer-joined", peer: g.peer });
        this.toAdmitted({ t: "peer-joined", peer: g.peer }, g.peer.peerId);
      }
    } else {
      await this.env.DB.prepare("UPDATE share_member SET kicked_at = ? WHERE share_id = ? AND user_id = ?").bind(Date.now(), share.id, frame.userId).run();
      for (const g of waiting) {
        close(g, "denied");
        this.left(g);
      }
    }
  }

  /** Close a member's connections (the host removed them). Called by the Worker. */
  async kick(userId: string) {
    for (const g of this.conns().filter((c) => !c.peer.isHost && c.peer.userId === userId)) {
      close(g, "kicked");
      this.left(g);
    }
  }

  /** Close the room: everyone is told and disconnected. Called by the Worker once the share is marked ended. */
  async end(reason: "ended" | "expired") {
    const conns = this.conns();
    this.ctx.storage.sql.exec("DELETE FROM peer");
    this.ctx.storage.sql.exec("DELETE FROM meta");
    await this.ctx.storage.deleteAlarm();
    for (const c of conns.filter((c) => !c.peer.isHost)) close(c, reason);
    for (const c of conns.filter((c) => c.peer.isHost)) close(c, reason);
  }

  /** The share ran out of time, or its host stayed away past the grace period. */
  async alarm() {
    const share = this.share();
    if (!share) return;
    const now = Date.now();
    const goneAt = Number(this.meta("hostGoneAt") ?? Infinity);
    if (share.expiresAt <= now || (goneAt <= now && !this.host())) {
      await recordEnd(this.env.DB, share.id);
      return this.end(share.expiresAt <= now ? "expired" : "ended");
    }
    await this.schedule();
  }

  /** Someone's connection is gone: tell the others. */
  private left(conn: Conn) {
    this.forget(conn);
    if (conn.peer.isHost) {
      if (this.host()) return;
      this.toAdmitted({ t: "host-offline" });
      this.setMeta("hostGoneAt", String(Date.now() + HOST_GRACE_MS));
      return;
    }
    const gone = { t: "peer-left", peerId: conn.peer.peerId, userId: conn.peer.userId };
    send(this.host(), gone);
    if (conn.admitted) this.toAdmitted(gone);
  }

  /** The next alarm: the share's end, or the host's grace period running out if sooner. */
  private async schedule() {
    const share = this.share();
    if (!share) return;
    await this.ctx.storage.setAlarm(Math.min(share.expiresAt, Number(this.meta("hostGoneAt") ?? Infinity)));
  }

  private toAdmitted(frame: object, except?: string) {
    for (const g of this.admitted()) if (g.peer.peerId !== except) send(g, frame);
  }

  // --- who's here -------------------------------------------------------------------

  /** Everyone connected whose peer is still on record. */
  private conns(): Conn[] {
    const rows = new Map(
      this.ctx.storage.sql
        .exec<{ peer_id: string; data: string }>("SELECT peer_id, data FROM peer")
        .toArray()
        .map((r) => [r.peer_id, JSON.parse(r.data) as Omit<Conn, "ws">]),
    );
    return this.ctx.getWebSockets().flatMap((ws) => {
      const row = rows.get(peerIdOf(ws));
      return row ? [{ ws, ...row }] : [];
    });
  }

  private conn(ws: WebSocket): Conn | undefined {
    const data = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM peer WHERE peer_id = ?", peerIdOf(ws)).toArray()[0]?.data;
    return data ? { ws, ...(JSON.parse(data) as Omit<Conn, "ws">) } : undefined;
  }

  private host() {
    return this.conns().find((c) => c.peer.isHost);
  }

  private admitted() {
    return this.conns().filter((c) => !c.peer.isHost && c.admitted);
  }

  private save({ ws: _, ...row }: Conn) {
    this.ctx.storage.sql.exec(
      "INSERT INTO peer (peer_id, data) VALUES (?, ?) ON CONFLICT (peer_id) DO UPDATE SET data = excluded.data",
      row.peer.peerId,
      JSON.stringify(row),
    );
  }

  private forget(conn: Conn) {
    this.ctx.storage.sql.exec("DELETE FROM peer WHERE peer_id = ?", conn.peer.peerId);
    this.buckets.delete(conn.peer.peerId);
  }

  private share(): { id: string; expiresAt: number } | null {
    const value = this.meta("share");
    return value ? JSON.parse(value) : null;
  }

  private meta(key: string): string | undefined {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
}

function peerIdOf(ws: WebSocket): string {
  return (ws.deserializeAttachment() as { peerId?: string } | null)?.peerId ?? "";
}
