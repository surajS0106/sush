// The relay's records of shared sessions: who owns each, the invites to it
// (only a hash of each token is kept), and who joined. What happens in a
// session is never stored here; the relay only forwards it (`relay.ts`).

import { db } from "../auth";
import type { MemberRow, ShareRow, UserRow } from "./common";

export { db };
export { HOUR, INVITE_TTL_HOURS, INVITE_USES, MAX_GUESTS, randomId, safeImage, SHARE_TTL_HOURS } from "./common";
export type { InviteRow, MemberRow, ShareRow, UserRow } from "./common";

db.run(`CREATE TABLE IF NOT EXISTS share (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
)`);
db.run(`CREATE TABLE IF NOT EXISTS share_invite (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES share (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role_cap TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
)`);
db.run(`CREATE TABLE IF NOT EXISTS share_member (
  share_id TEXT NOT NULL REFERENCES share (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role_cap TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  admitted INTEGER NOT NULL DEFAULT 0,
  kicked_at INTEGER,
  PRIMARY KEY (share_id, user_id)
)`);
// Added later: whether the owner opted the share into usage counts (`metrics.ts`) and
// whether they were taken, and whether the share is end-to-end encrypted (for the viewer).
for (const column of ["metrics INTEGER NOT NULL DEFAULT 0", "metrics_done INTEGER NOT NULL DEFAULT 0", "e2e INTEGER NOT NULL DEFAULT 0"]) {
  try {
    db.run(`ALTER TABLE share ADD COLUMN ${column}`);
  } catch {
    // Already there.
  }
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** A share that's still going, or null. */
export function liveShare(id: string): ShareRow | null {
  const row = db.query<ShareRow, [string]>("SELECT * FROM share WHERE id = ?").get(id);
  if (!row || row.ended_at || row.expires_at <= Date.now()) return null;
  return row;
}

export function member(shareId: string, userId: string): MemberRow | null {
  return db.query<MemberRow, [string, string]>("SELECT * FROM share_member WHERE share_id = ? AND user_id = ?").get(shareId, userId);
}

export function user(id: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT id, name, email, image FROM user WHERE id = ?").get(id);
}

export function guestCount(shareId: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM share_member WHERE share_id = ? AND admitted = 1 AND kicked_at IS NULL")
      .get(shareId)?.n ?? 0
  );
}
