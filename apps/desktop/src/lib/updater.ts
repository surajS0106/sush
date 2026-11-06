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
    const update = await check();
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
    if (!quiet) toast.error(`Couldn't check for updates: ${e instanceof Error ? e.message : String(e)}`);
  }
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
