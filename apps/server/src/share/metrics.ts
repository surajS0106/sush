// Opt-in usage counts, so traction can be reported without watching anyone.
// The host chooses, when it starts a share, whether that share is counted;
// it's off unless the owner turned it on (Settings → Sharing). What's kept is
// weekly buckets only: shares started, guests per share, and messages guests
// sent per share (the host reports that number when the share ends, since the
// relay never reads the session). No user ids, no share ids, no content.
// Only admins (SUSH_ADMIN_EMAILS) can read the totals.

import { bucket, isoWeek, type Metric } from "./common";
import { db } from "./db";

export { isAdmin } from "./common";
export type { Metric };

db.run(`CREATE TABLE IF NOT EXISTS share_metric (
  week TEXT NOT NULL,
  metric TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, metric, bucket)
)`);

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
