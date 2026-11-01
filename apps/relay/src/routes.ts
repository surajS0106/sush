// The hosted relay's API for shared sessions, under /api/shares: the Bun relay's
// routes (`apps/server/src/share/routes.ts`; keep the two in step) on D1, with
// each share's room in a Durable Object (`room.ts`).
//
// Unlike a relay on the local network, this one is on the internet, so it only
// takes end-to-end encrypted shares: it never has anything it could read.

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import {
  HOUR,
  INVITE_TTL_HOURS,
  INVITE_USES,
  randomId,
  SHARE_TTL_HOURS,
  type InviteRow,
  type ShareRow,
  type UserRow,
} from "../../server/src/share/common";
import { planFor } from "../../server/src/share/plans";
import { authFor } from "./auth";
import { count, guestCount, hashToken, liveShare, member, recordEnd, user } from "./db";
import type { Env } from "./env";
import { JOINING_HEADER, type Joining } from "./room";

type App = { Bindings: Env; Variables: { user: UserRow; share: ShareRow; isHost: boolean } };

export const shares = new Hono<App>();

const room = (env: Env, shareId: string) => env.ROOMS.get(env.ROOMS.idFromName(shareId));

shares.use("*", async (c, next) => {
  const session = await authFor(c.env, c.req.raw).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in to the relay first." }, 401);
  const u = session.user;
  c.set("user", { id: u.id, name: u.name, email: u.email, image: u.image ?? null });
  await next();
});

const clamp = (n: unknown, fallback: number, max: number) =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;

/** What this account's plan allows (`plans.ts`). Before `/:id`, which would take "limits" for a share. */
shares.get("/limits", (c) => {
  const plan = planFor(c.get("user"));
  return c.json({ plan: plan.name, maxGuests: plan.maxGuests, roles: plan.roles, maxTtlHours: plan.maxTtlHours, e2e: plan.e2e });
});

/** Start sharing a session. `metrics`: the owner opted it into anonymous usage counts. */
shares.post("/", async (c) => {
  const body = await c.req
    .json<{ title?: unknown; ttlHours?: unknown; metrics?: unknown; e2e?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  if (body.e2e !== true) {
    return c.json({ error: "This relay is on the internet, so it only carries end-to-end encrypted sessions. Update Sush and try again." }, 400);
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Shared session";
  const plan = planFor(c.get("user"));
  const ttl = clamp(body.ttlHours, Math.min(SHARE_TTL_HOURS, plan.maxTtlHours), plan.maxTtlHours);
  const id = randomId();
  const now = Date.now();
  const expiresAt = now + ttl * HOUR;
  const metrics = body.metrics === true;
  await c.env.DB.prepare("INSERT INTO share (id, owner_id, title, created_at, expires_at, metrics, e2e) VALUES (?, ?, ?, ?, ?, ?, 1)")
    .bind(id, c.get("user").id, title, now, expiresAt, metrics ? 1 : 0)
    .run();
  if (metrics) await count(c.env.DB, "shares_created");
  return c.json({ shareId: id, expiresAt });
});

/** Routes on one share: it must still be going. Each route checks whether the caller may use it. */
const onShare = createMiddleware<App>(async (c, next) => {
  const share = await liveShare(c.env.DB, c.req.param("id") ?? "");
  if (!share) return c.json({ error: "This shared session has ended." }, 410);
  c.set("share", share);
  c.set("isHost", share.owner_id === c.get("user").id);
  await next();
});
shares.use("/:id", onShare);
shares.use("/:id/*", onShare);

const ownerOnly = (c: { get: (key: "isHost") => boolean }) => c.get("isHost");

shares.post("/:id/invites", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can invite people." }, 403);
  const body = await c.req.json<{ ttlHours?: unknown; maxUses?: unknown; roleCap?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const ttl = clamp(body.ttlHours, INVITE_TTL_HOURS.default, INVITE_TTL_HOURS.max);
  const maxUses = clamp(body.maxUses, INVITE_USES.default, INVITE_USES.max);
  // A link lets people watch, or also suggest. Driving is only ever handed over in the session.
  const roleCap = body.roleCap === "collaborator" ? "collaborator" : "viewer";
  if (!planFor(c.get("user")).roles.includes(roleCap)) return c.json({ error: "Your plan doesn't include links to suggest." }, 403);
  const share = c.get("share");
  const token = randomId(32);
  const id = randomId(9);
  const now = Date.now();
  // An invite can't outlive its share.
  const expiresAt = Math.min(now + ttl * HOUR, share.expires_at);
  await c.env.DB.prepare(
    "INSERT INTO share_invite (id, share_id, token_hash, role_cap, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, share.id, await hashToken(token), roleCap, now, expiresAt, maxUses)
    .run();
  return c.json({ inviteId: id, token, expiresAt, maxUses, roleCap });
});

shares.get("/:id/invites", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can see invites." }, 403);
  const { results } = await c.env.DB.prepare("SELECT * FROM share_invite WHERE share_id = ? ORDER BY created_at DESC")
    .bind(c.get("share").id)
    .all<InviteRow>();
  return c.json(
    results.map((r) => ({
      inviteId: r.id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxUses: r.max_uses,
      uses: r.uses,
      revoked: !!r.revoked_at,
      roleCap: r.role_cap,
    })),
  );
});

shares.delete("/:id/invites/:inviteId", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can revoke invites." }, 403);
  await c.env.DB.prepare("UPDATE share_invite SET revoked_at = ? WHERE id = ? AND share_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), c.req.param("inviteId"), c.get("share").id)
    .run();
  return c.json({ ok: true });
});

/** Redeem an invite: the caller becomes a member, waiting in the lobby until the host admits them. */
shares.post("/:id/join", async (c) => {
  const db = c.env.DB;
  const share = c.get("share");
  const me = c.get("user");
  if (c.get("isHost")) return c.json({ error: "This is your own session." }, 400);
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({ token: undefined }));
  const existing = await member(db, share.id, me.id);
  if (existing?.kicked_at) return c.json({ error: "The host removed you from this session." }, 403);
  if (!existing) {
    if (typeof body.token !== "string" || !body.token) return c.json({ error: "This link isn't complete." }, 400);
    const invite = await db
      .prepare("SELECT * FROM share_invite WHERE token_hash = ? AND share_id = ?")
      .bind(await hashToken(body.token), share.id)
      .first<InviteRow>();
    const now = Date.now();
    if (!invite || invite.revoked_at || invite.expires_at <= now || invite.uses >= invite.max_uses) {
      return c.json({ error: "This invite has expired or was revoked. Ask the host for a new link." }, 403);
    }
    const owner = await user(db, share.owner_id);
    if (owner && (await guestCount(db, share.id)) >= planFor(owner).maxGuests) {
      return c.json({ error: "This session is full. Ask the host to make room." }, 403);
    }
    await db.batch([
      db.prepare("UPDATE share_invite SET uses = uses + 1 WHERE id = ?").bind(invite.id),
      db.prepare("INSERT INTO share_member (share_id, user_id, role_cap, joined_at) VALUES (?, ?, ?, ?)").bind(share.id, me.id, invite.role_cap, now),
    ]);
  }
  const owner = await user(db, share.owner_id);
  return c.json({ shareId: share.id, title: share.title, hostName: owner?.name || "The host", expiresAt: share.expires_at, e2e: !!share.e2e });
});

shares.get("/:id", async (c) => {
  const share = c.get("share");
  if (!c.get("isHost") && !(await member(c.env.DB, share.id, c.get("user").id))) return c.json({ error: "You aren't in this session." }, 403);
  const owner = await user(c.env.DB, share.owner_id);
  return c.json({ shareId: share.id, title: share.title, hostName: owner?.name || "The host", expiresAt: share.expires_at });
});

shares.delete("/:id/members/:userId", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can remove people." }, 403);
  const share = c.get("share");
  const userId = c.req.param("userId");
  await c.env.DB.prepare("UPDATE share_member SET kicked_at = ? WHERE share_id = ? AND user_id = ?").bind(Date.now(), share.id, userId).run();
  await room(c.env, share.id).kick(userId);
  return c.json({ ok: true });
});

/** End the share. A share opted into usage counts may carry how many messages guests sent (`steers`). */
shares.delete("/:id", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can end the session." }, 403);
  const body = await c.req.json<{ steers?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const steers = typeof body.steers === "number" && Number.isFinite(body.steers) ? Math.min(Math.max(0, Math.floor(body.steers)), 100_000) : undefined;
  const id = c.get("share").id;
  await recordEnd(c.env.DB, id, steers);
  await room(c.env, id).end("ended");
  return c.json({ ok: true });
});

/** The room. The host, or a member the host hasn't removed; the room takes who they are from the Worker. */
shares.get("/:id/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Expected a WebSocket." }, 426);
  const share = c.get("share");
  const isHost = c.get("isHost");
  let joining: Joining = { shareId: share.id, expiresAt: share.expires_at, user: c.get("user"), isHost, admitted: isHost };
  if (!isHost) {
    const m = await member(c.env.DB, share.id, c.get("user").id);
    if (!m || m.kicked_at) return c.json({ error: "You aren't in this session." }, 403);
    joining = { ...joining, roleCap: m.role_cap, admitted: !!m.admitted };
  }
  // Set here whatever the caller sent: names can be any text, and headers carry only Latin-1.
  const headers = new Headers(c.req.raw.headers);
  headers.set(JOINING_HEADER, encodeURIComponent(JSON.stringify(joining)));
  return room(c.env, share.id).fetch(new Request(c.req.raw, { headers }));
});
