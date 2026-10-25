// The relay's API for shared sessions, under /api/shares. Everything needs a
// signed-in account (bearer token). The owner creates a share and invites to
// it; a guest redeems an invite, which makes them a member waiting in the
// lobby until the host admits them; then both sides connect to the room.
//
// Invite tokens arrive only in request bodies, never in a path or query, so
// the request log never holds one, and only their hash is stored.

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { createMiddleware } from "hono/factory";

import { auth } from "../auth";
import {
  db,
  guestCount,
  hashToken,
  HOUR,
  INVITE_TTL_HOURS,
  INVITE_USES,
  liveShare,
  member,
  randomId,
  SHARE_TTL_HOURS,
  user,
  type InviteRow,
  type ShareRow,
  type UserRow,
} from "./db";
import { count } from "./metrics";
import { planFor } from "./plans";
import { connection, endShare, kickUser } from "./relay";

type Env = { Variables: { user: UserRow; share: ShareRow; isHost: boolean } };

export const shares = new Hono<Env>();

shares.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
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
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Shared session";
  const plan = planFor(c.get("user"));
  const ttl = clamp(body.ttlHours, Math.min(SHARE_TTL_HOURS, plan.maxTtlHours), plan.maxTtlHours);
  const id = randomId();
  const now = Date.now();
  const expiresAt = now + ttl * HOUR;
  const metrics = body.metrics === true;
  db.run("INSERT INTO share (id, owner_id, title, created_at, expires_at, metrics, e2e) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id,
    c.get("user").id,
    title,
    now,
    expiresAt,
    metrics ? 1 : 0,
    body.e2e === true ? 1 : 0,
  ]);
  if (metrics) count("shares_created");
  return c.json({ shareId: id, expiresAt });
});

/** Routes on one share: it must still be going. Each route checks whether the caller may use it. */
const onShare = createMiddleware<Env>(async (c, next) => {
  const share = liveShare(c.req.param("id") ?? "");
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
  db.run(
    "INSERT INTO share_invite (id, share_id, token_hash, role_cap, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, share.id, hashToken(token), roleCap, now, expiresAt, maxUses],
  );
  return c.json({ inviteId: id, token, expiresAt, maxUses, roleCap });
});

shares.get("/:id/invites", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can see invites." }, 403);
  const rows = db
    .query<InviteRow, [string]>("SELECT * FROM share_invite WHERE share_id = ? ORDER BY created_at DESC")
    .all(c.get("share").id);
  return c.json(
    rows.map((r) => ({
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

shares.delete("/:id/invites/:inviteId", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can revoke invites." }, 403);
  db.run("UPDATE share_invite SET revoked_at = ? WHERE id = ? AND share_id = ? AND revoked_at IS NULL", [
    Date.now(),
    c.req.param("inviteId"),
    c.get("share").id,
  ]);
  return c.json({ ok: true });
});

/** Redeem an invite: the caller becomes a member, waiting in the lobby until the host admits them. */
shares.post("/:id/join", async (c) => {
  const share = c.get("share");
  const me = c.get("user");
  if (c.get("isHost")) return c.json({ error: "This is your own session." }, 400);
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({ token: undefined }));
  const existing = member(share.id, me.id);
  if (existing?.kicked_at) return c.json({ error: "The host removed you from this session." }, 403);
  if (!existing) {
    if (typeof body.token !== "string" || !body.token) return c.json({ error: "This link isn't complete." }, 400);
    const invite = db
      .query<InviteRow, [string, string]>("SELECT * FROM share_invite WHERE token_hash = ? AND share_id = ?")
      .get(hashToken(body.token), share.id);
    const now = Date.now();
    if (!invite || invite.revoked_at || invite.expires_at <= now || invite.uses >= invite.max_uses) {
      return c.json({ error: "This invite has expired or was revoked. Ask the host for a new link." }, 403);
    }
    const owner = user(share.owner_id);
    if (owner && guestCount(share.id) >= planFor(owner).maxGuests) {
      return c.json({ error: "This session is full. Ask the host to make room." }, 403);
    }
    db.run("UPDATE share_invite SET uses = uses + 1 WHERE id = ?", [invite.id]);
    db.run("INSERT INTO share_member (share_id, user_id, role_cap, joined_at) VALUES (?, ?, ?, ?)", [share.id, me.id, invite.role_cap, now]);
  }
  const owner = user(share.owner_id);
  return c.json({ shareId: share.id, title: share.title, hostName: owner?.name || "The host", expiresAt: share.expires_at, e2e: !!share.e2e });
});

shares.get("/:id", (c) => {
  const share = c.get("share");
  if (!c.get("isHost") && !member(share.id, c.get("user").id)) return c.json({ error: "You aren't in this session." }, 403);
  const owner = user(share.owner_id);
  return c.json({ shareId: share.id, title: share.title, hostName: owner?.name || "The host", expiresAt: share.expires_at });
});

shares.delete("/:id/members/:userId", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can remove people." }, 403);
  const share = c.get("share");
  const userId = c.req.param("userId");
  db.run("UPDATE share_member SET kicked_at = ? WHERE share_id = ? AND user_id = ?", [Date.now(), share.id, userId]);
  kickUser(share.id, userId);
  return c.json({ ok: true });
});

/** End the share. A share opted into usage counts may carry how many messages guests sent (`steers`). */
shares.delete("/:id", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "Only the host can end the session." }, 403);
  const body = await c.req.json<{ steers?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const steers = typeof body.steers === "number" && Number.isFinite(body.steers) ? Math.min(Math.max(0, Math.floor(body.steers)), 100_000) : undefined;
  endShare(c.get("share").id, "ended", steers);
  return c.json({ ok: true });
});

/** The room. The host, or a member the host hasn't removed. */
shares.get(
  "/:id/ws",
  async (c, next) => {
    const share = c.get("share");
    if (!c.get("isHost")) {
      const m = member(share.id, c.get("user").id);
      if (!m || m.kicked_at) return c.json({ error: "You aren't in this session." }, 403);
    }
    await next();
  },
  upgradeWebSocket((c) => connection(c.get("share").id, c.get("user"), c.get("isHost"))),
);
