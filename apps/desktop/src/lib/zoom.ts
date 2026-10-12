// Whole-app zoom: Ctrl/Cmd + "=" or "+" zooms in, Ctrl/Cmd + "-" zooms out, Ctrl/Cmd + "0" resets.
// It's the webview's own zoom, so layout reflows as in a browser; the level persists.

import { getCurrentWebview } from "@tauri-apps/api/webview";

import { createStore } from "@/lib/store";

const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const zoom = createStore<number>("sush.zoom", 1);

/** The current zoom factor; CSS px × this = logical window px. */
export const getZoom = () => zoom.get();

function apply(level: number) {
  zoom.set(level);
  void getCurrentWebview()
    .setZoom(level)
    // The native browser pane is placed in window coordinates; let it re-measure.
    .then(() => window.dispatchEvent(new Event("resize")))
    .catch(() => {});
}

function step(dir: 1 | -1) {
  const current = zoom.get();
  const next =
    dir > 0 ? LEVELS.find((l) => l > current + 0.001) : [...LEVELS].reverse().find((l) => l < current - 0.001);
  if (next !== undefined) apply(next);
}

/** Restore the saved zoom and listen for the shortcuts. Call once at startup. */
export function initZoom() {
  if (zoom.get() !== 1) apply(zoom.get());
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") step(1);
      else if (e.key === "-" || e.key === "_") step(-1);
      else if (e.key === "0") apply(1);
      else return;
      e.preventDefault();
    },
    { capture: true },
  );
}
