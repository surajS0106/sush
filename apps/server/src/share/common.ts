// What both relays share: this Bun server and the Cloudflare Worker (`apps/relay`).
// Nothing here touches a runtime (no Bun, no Workers APIs), so the two can't drift
// on limits, pictures or how usage is counted.

/** Origins the desktop webview loads from: Vite in dev, Tauri's custom protocol in builds. */
export const trustedOrigins = ["http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export const HOUR = 60 * 60 * 1000;
/** How long a share lasts unless asked otherwise (a plan sets the most, `plans.ts`). */
export const SHARE_TTL_HOURS = 12;
export const INVITE_TTL_HOURS = { default: 24, max: 72 };
export const INVITE_USES = { default: 10, max: 25 };
/** Guests one share admits at most on the largest plan (`plans.ts`). */
export const MAX_GUESTS = Number(process.env.SHARE_MAX_GUESTS ?? 10);

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

export type Metric = "shares_created" | "guests_per_share" | "steers_per_share";

/** The ISO week a time falls in, like 2026-W43. */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** A histogram bucket for a count. */
export function bucket(metric: Metric, n: number): string {
  if (metric === "shares_created") return "all";
  const edges = metric === "guests_per_share" ? [0, 1, 2, 5, 10] : [0, 5, 20, 50];
  let low = 0;
  for (const edge of edges) {
    if (n <= edge) return low === edge ? String(edge) : `${low}-${edge}`;
    low = edge + 1;
  }
  return `${low}+`;
}

export const isAdmin = (email: string) =>
  (process.env.SUSH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());

export interface ShareRow {
  id: string;
  owner_id: string;
  title: string;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
  metrics: number;
  metrics_done: number;
  e2e: number;
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
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface Peer {
  peerId: string;
  userId: string;
  name: string;
  image: string | null;
  isHost: boolean;
  /** A guest's invite: "viewer" or "collaborator". The host decides their role from it. */
  roleCap?: string;
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

/** A guest may send this many messages a second, with bursts of `BURST`. */
export const RATE = 10;
export const BURST = 30;
/** Room for a message with a few images (the host checks each: at most 2 MB). */
export const GUEST_MAX_BYTES = 8 * 1024 * 1024;
/** How long a share waits for its host to come back. */
export const HOST_GRACE_MS = 5 * 60 * 1000;

// The browser viewer (`apps/viewer`) at an invite link's address. Its token and key are
// after the `#`, which browsers never send.

/** Nothing the viewer renders can load or run anything from elsewhere. */
export const VIEWER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The page at an invite link without a viewer build: how to join from the app. */
export const JOIN_FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join a Sush session</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}code{font-size:.9em}</style></head>
<body><h1>Join a shared Sush session</h1>
<p>Open Sush, choose <b>Join shared session…</b> in the sidebar, and paste this page’s link (the whole address, including the part after <code>#</code>).</p>
<p>You need a Sharing account on this relay: Settings → Sharing.</p></body></html>`;
