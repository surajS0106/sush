// Deletes all but the newest incremental session of each crate in
// target/debug/incremental. rustc is meant to do this itself after each build,
// but on Windows the delete often fails (files still open) and every `tauri dev`
// rebuild leaves a few hundred MB behind. Run before `dev:app`.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "target", "debug", "incremental");

let crates: string[];
try {
  crates = readdirSync(root);
} catch {
  process.exit(0); // nothing built yet
}

let freed = 0;
for (const crate of crates) {
  const dir = join(root, crate);
  // Session dirs are `s-<time>-<rand>-<hash>` (or `-working` mid-build), each
  // with a `s-<time>-<rand>.lock` beside it.
  const sessions = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("s-"))
    .map((e) => ({ name: e.name, mtime: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const { name } of sessions.slice(1)) {
    const path = join(dir, name);
    const size = dirSize(path);
    try {
      rmSync(path, { recursive: true, force: true });
      rmSync(join(dir, name.split("-").slice(0, 3).join("-") + ".lock"), { force: true });
      freed += size;
    } catch {
      // Still in use by a running build; leave it for next time.
    }
  }
}

if (freed > 0) console.log(`pruned ${(freed / 1024 ** 2).toFixed(0)} MB of stale incremental sessions`);

function dirSize(path: string): number {
  let total = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}
