import { useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

import { api } from "@/lib/tauri";
import { isAndroid, isIOS } from "@/lib/utils";

/** Where the update flow is: the sidebar shows "Upgrade now" once `available`. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number | null }
  | { status: "installing"; version: string };

let state: UpdateState = { status: "idle" };
/** The release found: a Tauri `Update` on desktop; on Android, Rust keeps the release and this is its version. */
let pending: Update | { version: string } | null = null;
/** When the last check ended, so the phone's Home (which mounts often) doesn't ask GitHub every time. */
let lastChecked = 0;
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
  // iOS apps can't update themselves; a new build is installed from Xcode (docs/ios.md).
  if (isIOS) return;
  if (state.status !== "idle" && state.status !== "available") return;
  // GitHub's API, which Android checks, allows 60 unauthenticated requests an hour.
  if (quiet && isAndroid && Date.now() - lastChecked < 60 * 60 * 1000) return;
  const before = state;
  set({ status: "checking" });
  try {
    const update = isAndroid ? await api.androidUpdateCheck() : await checkWithRetry();
    lastChecked = Date.now();
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
    set(before.status === "available" && pending ? before : { status: "idle" });
    if (!quiet) toast.error("Couldn't check for updates", { description: describeCheckError(e) });
  }
}

/**
 * One plain check, as Yammer does. Only a feed that answered badly (GitHub's brief 5xx) gets a second
 * quick try; an unreachable feed fails rather than leaving "Checking…" up for a minute. The timeout
 * covers github.com's redirect plus the download from release-assets.githubusercontent.com, whose
 * connect alone can take several seconds on some networks (7.5 s seen), so 10 s was too tight.
 */
const CHECK_TIMEOUT_MS = 30_000;

async function checkWithRetry(): Promise<Update | null> {
  try {
    return await check({ timeout: CHECK_TIMEOUT_MS });
  } catch (e) {
    if (!/valid release JSON/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await new Promise((r) => setTimeout(r, 1000));
    return await check({ timeout: CHECK_TIMEOUT_MS });
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
  if (!("downloadAndInstall" in update)) return installOnAndroid(version);
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

/**
 * Android: Rust downloads the APK and opens Android's installer on it, which asks the user to
 * confirm (and, the first time, to let Sush install apps). Installing ends this process, so the
 * button only goes back to "available" in case the user cancels.
 */
async function installOnAndroid(version: string) {
  set({ status: "downloading", version, percent: null });
  const progress = new Channel<{ received: number; total: number }>();
  progress.onmessage = ({ received, total }) => {
    if (received >= total) set({ status: "installing", version });
    else set({ status: "downloading", version, percent: total ? Math.round((received / total) * 100) : null });
  };
  try {
    await api.androidUpdateInstall(progress);
  } catch (e) {
    toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    set({ status: "available", version });
  }
}
