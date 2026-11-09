import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

/** Where the update flow is: the sidebar shows "Upgrade now" once `available`. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number | null }
  | { status: "installing"; version: string };

let state: UpdateState = { status: "idle" };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Ask the release feed whether a newer version is out. `quiet` skips the toasts (the launch check). */
export async function checkForUpdate(quiet = false) {
  if (state.status !== "idle" && state.status !== "available") return;
  set({ status: "checking" });
  try {
    const update = await checkWithRetry();
    if (update) {
      pending = update;
      set({ status: "available", version: update.version });
    } else {
      pending = null;
      set({ status: "idle" });
      if (!quiet) toast("Sush is up to date");
    }
  } catch (e) {
    // Dev builds and offline machines have no feed to read; that's only worth a word when asked.
    set({ status: "idle" });
    if (!quiet) toast.error("Couldn't check for updates", { description: describeCheckError(e) });
  }
}

/**
 * One plain check, as Yammer does. Only a feed that answered badly (GitHub's brief 5xx) gets a second
 * quick try; a slow or unreachable feed fails at once rather than leaving "Checking…" up for a minute.
 */
async function checkWithRetry(): Promise<Update | null> {
  try {
    return await check({ timeout: 10_000 });
  } catch (e) {
    if (!/valid release JSON/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await new Promise((r) => setTimeout(r, 1000));
    return await check({ timeout: 10_000 });
  }
}

function describeCheckError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  // The plugin says this when the feed answered with an error status (GitHub down, or a release mid-publish).
  if (/valid release JSON/i.test(message)) return "The update server didn't respond properly. Try again in a few minutes.";
  if (/error sending request|dns|connect|timed? ?out/i.test(message)) return "Couldn't reach the update server. Check your connection and try again.";
  return message;
}

/** Download and install the latest release, then restart into it. */
export async function upgradeNow() {
  if (!pending) {
    await checkForUpdate();
    if (!pending) return;
  }
  const update = pending;
  const version = update.version;
  let total = 0;
  let done = 0;
  set({ status: "downloading", version, percent: null });
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        done += e.data.chunkLength;
        set({ status: "downloading", version, percent: total ? Math.min(100, Math.round((done / total) * 100)) : null });
      } else if (e.event === "Finished") set({ status: "installing", version });
    });
    await relaunch();
  } catch (e) {
    set({ status: "available", version });
    toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
