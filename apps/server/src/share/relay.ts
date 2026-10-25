// Rooms for shared sessions. The relay forwards what the host and its guests
// send without reading it: only the routing header (`t`, `to`) is its business,
// and the body is passed on as an opaque string (ciphertext, once sessions are
// end-to-end encrypted). It adds who each message is from, from the signed-in
// account, so nobody can claim to be someone else.
//
// A guest can only write to the host, and only once the host has admitted
// them from the lobby. The host writes to everyone admitted, or to one guest.

import type { WSContext } from "hono/ws";

import { db, guestCount, liveShare, safeImage, user, type ShareRow, type UserRow } from "./db";
import { count } from "./metrics";
import { planFor } from "./plans";

export interface Peer {
  peerId: string;
  userId: string;
  name: string;
  image: string | null;
  isHost: boolean;
  /** A guest's invite: "viewer" or "collaborator". The host decides their role from it. */
  roleCap?: string;
}

interface Conn {
  peer: Peer;
  email: string;
  ws: WSContext;
  admitted: boolean;
  /** Token bucket for a guest's messages. */
  tokens: number;
  refilledAt: number;
}

interface Room {
  host?: Conn;
  guests: Map<string, Conn>;
  /** Ends the share if the host stays away. */
  hostGone?: ReturnType<typeof setTimeout>;
}

/** A guest may send this many messages a second, with bursts of `BURST`. */
const RATE = 10;
const BURST = 30;
/** Room for a message with a few images (the host checks each: at most 2 MB). */
const GUEST_MAX_BYTES = 8 * 1024 * 1024;
/** How long a share waits for its host to come back. */
const HOST_GRACE_MS = 5 * 60 * 1000;

const rooms = new Map<string, Room>();

const room = (shareId: string) => {
  let r = rooms.get(shareId);
  if (!r) rooms.set(shareId, (r = { guests: new Map() }));
  return r;
};

const send = (conn: Conn | undefined, frame: object) => {
  try {
    conn?.ws.send(JSON.stringify(frame));
  } catch {
    // Closing; its close handler cleans up.
  }
};

const admitted = (r: Room) => [...r.guests.values()].filter((g) => g.admitted);

function toAdmitted(r: Room, frame: object, except?: string) {
  for (const g of admitted(r)) if (g.peer.peerId !== except) send(g, frame);
}

function close(conn: Conn, reason: string) {
  send(conn, { t: "closed", reason });
  try {
    conn.ws.close(1000, reason);
  } catch {
    // Already gone.
  }
}

export function peerOf(user: UserRow, isHost: boolean, roleCap?: string): Peer {
  return {
    peerId: crypto.randomUUID(),
    userId: user.id,
    name: user.name || user.email.split("@")[0],
    image: safeImage(user.image),
    isHost,
    ...(roleCap ? { roleCap } : {}),
  };
}

/** The handlers for one connection, opened after the route checked who it is. */
export function connection(shareId: string, user: UserRow, isHost: boolean) {
  let conn: Conn | undefined;
  return {
    onOpen(_: Event, ws: WSContext) {
      const r = room(shareId);
      const member = isHost
        ? null
        : db
            .query<{ admitted: number; role_cap: string }, [string, string]>("SELECT admitted, role_cap FROM share_member WHERE share_id = ? AND user_id = ?")
            .get(shareId, user.id);
      const peer = peerOf(user, isHost, member?.role_cap);
      conn = { peer, email: user.email, ws, admitted: isHost || !!member?.admitted, tokens: BURST, refilledAt: Date.now() };
      if (isHost) {
        if (r.host) close(r.host, "superseded");
        r.host = conn;
        if (r.hostGone) clearTimeout(r.hostGone);
        r.hostGone = undefined;
        send(conn, {
          t: "welcome",
          you: peer,
          peers: admitted(r).map((g) => g.peer),
          lobby: [...r.guests.values()].filter((g) => !g.admitted).map((g) => ({ ...g.peer, email: g.email })),
          hostOnline: true,
          admitted: true,
        });
        toAdmitted(r, { t: "host-online" });
        return;
      }
      r.guests.set(peer.peerId, conn);
      send(conn, {
        t: "welcome",
        you: peer,
        peers: [...(r.host ? [r.host.peer] : []), ...admitted(r).filter((g) => g !== conn).map((g) => g.peer)],
        hostOnline: !!r.host,
        admitted: conn.admitted,
      });
      if (conn.admitted) {
        send(r.host, { t: "peer-joined", peer });
        toAdmitted(r, { t: "peer-joined", peer }, peer.peerId);
      } else {
        send(r.host, { t: "knock", peer: { ...peer, email: user.email } });
      }
    },

    onMessage(event: MessageEvent, _: WSContext) {
      if (!conn || typeof event.data !== "string") return;
      const r = room(shareId);
      let frame: { t?: string; to?: string; body?: unknown; userId?: string; allow?: boolean };
      try {
        frame = JSON.parse(event.data);
      } catch {
        return send(conn, { t: "error", code: "bad-frame" });
      }
      if (frame.t === "ping") return send(conn, { t: "pong" });
      if (conn.peer.isHost) return fromHost(shareId, r, conn, frame);

      // A guest: rate limited, small messages, only to the host, only once admitted.
      const now = Date.now();
      conn.tokens = Math.min(BURST, conn.tokens + ((now - conn.refilledAt) / 1000) * RATE);
      conn.refilledAt = now;
      if (conn.tokens < 1) return send(conn, { t: "error", code: "rate-limited" });
      conn.tokens -= 1;
      if (event.data.length > GUEST_MAX_BYTES) return send(conn, { t: "error", code: "too-large" });
      if (frame.t !== "send" || typeof frame.body !== "string" || !conn.admitted) return;
      send(r.host, { t: "recv", from: conn.peer, body: frame.body, ts: now });
    },

    onClose() {
      if (!conn) return;
      const r = rooms.get(shareId);
      if (!r) return;
      if (conn.peer.isHost) {
        if (r.host !== conn) return;
        r.host = undefined;
        toAdmitted(r, { t: "host-offline" });
        r.hostGone = setTimeout(() => endShare(shareId, "ended"), HOST_GRACE_MS);
        return;
      }
      r.guests.delete(conn.peer.peerId);
      send(r.host, { t: "peer-left", peerId: conn.peer.peerId, userId: conn.peer.userId });
      if (conn.admitted) toAdmitted(r, { t: "peer-left", peerId: conn.peer.peerId, userId: conn.peer.userId });
      if (!r.host && r.guests.size === 0 && !r.hostGone) rooms.delete(shareId);
    },
  };
}

function fromHost(shareId: string, r: Room, host: Conn, frame: { t?: string; to?: string; body?: unknown; userId?: string; allow?: boolean }) {
  if (frame.t === "send" && typeof frame.body === "string") {
    const out = { t: "recv", from: host.peer, body: frame.body, ts: Date.now() };
    if (frame.to === "all" || !frame.to) return toAdmitted(r, out);
    const guest = r.guests.get(frame.to);
    if (guest?.admitted) send(guest, out);
    return;
  }
  if (frame.t === "admit" && typeof frame.userId === "string") {
    const waiting = [...r.guests.values()].filter((g) => g.peer.userId === frame.userId && !g.admitted);
    if (frame.allow) {
      const owner = user(host.peer.userId);
      if (owner && guestCount(shareId) >= planFor(owner).maxGuests) return send(host, { t: "error", code: "full" });
      db.run("UPDATE share_member SET admitted = 1 WHERE share_id = ? AND user_id = ?", [shareId, frame.userId]);
      for (const g of waiting) {
        g.admitted = true;
        send(g, { t: "admitted", peers: [host.peer, ...admitted(r).filter((o) => o !== g).map((o) => o.peer)] });
        send(host, { t: "peer-joined", peer: g.peer });
        toAdmitted(r, { t: "peer-joined", peer: g.peer }, g.peer.peerId);
      }
    } else {
      db.run("UPDATE share_member SET kicked_at = ? WHERE share_id = ? AND user_id = ?", [Date.now(), shareId, frame.userId]);
      for (const g of waiting) close(g, "denied");
    }
  }
}

/** Close a member's connections (they were removed). */
export function kickUser(shareId: string, userId: string) {
  const r = rooms.get(shareId);
  if (!r) return;
  for (const g of [...r.guests.values()]) if (g.peer.userId === userId) close(g, "kicked");
}

/**
 * End a share: everyone is told and disconnected, and its invites stop working.
 * If the owner opted it into usage counts, they're taken now, once: guests from
 * the relay's own records, and `steers` as the host reports it (unknown when it expired).
 */
export function endShare(shareId: string, reason: "ended" | "expired", steers?: number) {
  db.run("UPDATE share SET ended_at = ? WHERE id = ? AND ended_at IS NULL", [Date.now(), shareId]);
  const row = db.query<ShareRow, [string]>("SELECT * FROM share WHERE id = ?").get(shareId);
  if (row?.metrics && !row.metrics_done) {
    db.run("UPDATE share SET metrics_done = 1 WHERE id = ?", [shareId]);
    const guests = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM share_member WHERE share_id = ? AND admitted = 1").get(shareId)?.n ?? 0;
    count("guests_per_share", guests);
    if (typeof steers === "number") count("steers_per_share", steers);
  }
  const r = rooms.get(shareId);
  if (!r) return;
  if (r.hostGone) clearTimeout(r.hostGone);
  for (const g of [...r.guests.values()]) close(g, reason);
  if (r.host) close(r.host, reason);
  rooms.delete(shareId);
}

// Shares that ran out of time close even if nobody notices.
setInterval(() => {
  for (const id of rooms.keys()) if (!liveShare(id)) endShare(id, "expired");
}, 60 * 1000);
