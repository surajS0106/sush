// The relay's records of shared sessions: who owns each, the invites to it
// (only a hash of each token is kept), and who joined. What happens in a
// session is never stored here; the relay only forwards it (`relay.ts`).

import { db } from "../auth";

export { db };

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

export const HOUR = 60 * 60 * 1000;
/** How long a share lasts at most. */
export const SHARE_TTL_HOURS = 12;
export const INVITE_TTL_HOURS = { default: 24, max: 72 };
export const INVITE_USES = { default: 10, max: 25 };
/** Guests one share admits at most (seat and plan limits will hook in here). */
export const MAX_GUESTS = Number(process.env.SHARE_MAX_GUESTS ?? 10);

export interface ShareRow {
  id: string;
  owner_id: string;
  title: string;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
}

export interface InviteRow {
  id: string;
  share_id: string;
  token_hash: string;
  role_cap: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
  revoked_at: number | null;
}

export interface MemberRow {
  share_id: string;
  user_id: string;
  role_cap: string;
  joined_at: number;
  admitted: number;
  kicked_at: number | null;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** A random id or token: `bytes` random bytes, base64url. */
export function randomId(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(buf).toString("base64url");
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

/**
 * A picture the other side may show: a `data:` image (≤ 64 KB) or a built-in
 * avatar id. Never a URL, which every viewer's app would fetch.
 */
export function safeImage(image: string | null | undefined): string | null {
  if (!image) return null;
  if (image.startsWith("sush:avatar/") && image.length < 64) return image;
  if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(image) && image.length <= 64 * 1024) return image;
  return null;
}
