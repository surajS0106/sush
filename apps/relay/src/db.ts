// The hosted relay's records in D1: the same tables as the Bun relay
// (`schema.ts`), read and written the same way (`apps/server/src/share/db.ts`,
// `metrics.ts`). What happens in a session is never stored; rooms only forward it.

import { bucket, isoWeek, type MemberRow, type Metric, type ShareRow, type UserRow } from "../../server/src/share/common";

/** How invite tokens are kept: only their hash. */
export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A share that's still going, or null. */
export async function liveShare(db: D1Database, id: string): Promise<ShareRow | null> {
  const row = await db.prepare("SELECT * FROM share WHERE id = ?").bind(id).first<ShareRow>();
  if (!row || row.ended_at || row.expires_at <= Date.now()) return null;
  return row;
}

export function member(db: D1Database, shareId: string, userId: string): Promise<MemberRow | null> {
  return db.prepare("SELECT * FROM share_member WHERE share_id = ? AND user_id = ?").bind(shareId, userId).first<MemberRow>();
}

export function user(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT id, name, email, image FROM "user" WHERE id = ?').bind(id).first<UserRow>();
}

export async function guestCount(db: D1Database, shareId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM share_member WHERE share_id = ? AND admitted = 1 AND kicked_at IS NULL")
    .bind(shareId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function count(db: D1Database, metric: Metric, n = 0, at = Date.now()) {
  await db
    .prepare(
      "INSERT INTO share_metric (week, metric, bucket, count) VALUES (?, ?, ?, 1) ON CONFLICT (week, metric, bucket) DO UPDATE SET count = count + 1",
    )
    .bind(isoWeek(at), metric, bucket(metric, n))
    .run();
}

/** Weekly totals, newest first. */
export async function weekly(db: D1Database, limit = 26) {
  const { results } = await db
    .prepare(
      "SELECT week, metric, bucket, count FROM share_metric WHERE week IN (SELECT DISTINCT week FROM share_metric ORDER BY week DESC LIMIT ?) ORDER BY week DESC, metric, bucket",
    )
    .bind(limit)
    .all<{ week: string; metric: Metric; bucket: string; count: number }>();
  const weeks = new Map<string, Record<string, Record<string, number>>>();
  for (const r of results) {
    const w = weeks.get(r.week) ?? {};
    (w[r.metric] ??= {})[r.bucket] = r.count;
    weeks.set(r.week, w);
  }
  return [...weeks].map(([week, metrics]) => ({ week, ...metrics }));
}

/**
 * Mark a share ended, so its invites stop working. If the owner opted it into
 * usage counts, they're taken now, once: guests from the relay's own records,
 * and `steers` as the host reports it (unknown when it expired). The room is
 * closed separately (`Room.end`).
 */
export async function recordEnd(db: D1Database, shareId: string, steers?: number) {
  await db.prepare("UPDATE share SET ended_at = ? WHERE id = ? AND ended_at IS NULL").bind(Date.now(), shareId).run();
  const row = await db.prepare("SELECT * FROM share WHERE id = ?").bind(shareId).first<ShareRow>();
  if (!row?.metrics || row.metrics_done) return;
  await db.prepare("UPDATE share SET metrics_done = 1 WHERE id = ?").bind(shareId).run();
  const guests = await db.prepare("SELECT COUNT(*) AS n FROM share_member WHERE share_id = ? AND admitted = 1").bind(shareId).first<{ n: number }>();
  await count(db, "guests_per_share", guests?.n ?? 0);
  if (typeof steers === "number") await count(db, "steers_per_share", steers);
}
