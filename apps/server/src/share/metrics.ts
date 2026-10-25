// Opt-in usage counts, so traction can be reported without watching anyone.
// The host chooses, when it starts a share, whether that share is counted;
// it's off unless the owner turned it on (Settings → Sharing). What's kept is
// weekly buckets only: shares started, guests per share, and messages guests
// sent per share (the host reports that number when the share ends, since the
// relay never reads the session). No user ids, no share ids, no content.
// Only admins (SUSH_ADMIN_EMAILS) can read the totals.

import { db } from "./db";

db.run(`CREATE TABLE IF NOT EXISTS share_metric (
  week TEXT NOT NULL,
  metric TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, metric, bucket)
)`);

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

export function count(metric: Metric, n = 0, at = Date.now()) {
  db.run(
    "INSERT INTO share_metric (week, metric, bucket, count) VALUES (?, ?, ?, 1) ON CONFLICT (week, metric, bucket) DO UPDATE SET count = count + 1",
    [isoWeek(at), metric, bucket(metric, n)],
  );
}

/** Weekly totals, newest first. */
export function weekly(limit = 26) {
  const rows = db
    .query<{ week: string; metric: Metric; bucket: string; count: number }, [number]>(
      "SELECT week, metric, bucket, count FROM share_metric WHERE week IN (SELECT DISTINCT week FROM share_metric ORDER BY week DESC LIMIT ?) ORDER BY week DESC, metric, bucket",
    )
    .all(limit);
  const weeks = new Map<string, Record<string, Record<string, number>>>();
  for (const r of rows) {
    const w = weeks.get(r.week) ?? {};
    (w[r.metric] ??= {})[r.bucket] = r.count;
    weeks.set(r.week, w);
  }
  return [...weeks].map(([week, metrics]) => ({ week, ...metrics }));
}

export const isAdmin = (email: string) =>
  (process.env.SUSH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
