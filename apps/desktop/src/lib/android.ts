// What the Android app does differently at startup (docs/android.md).

import { api } from "@/lib/tauri";

/** Keeps the system bars in step with Sush's theme. Call once, on Android. */
export function initAndroid() {
  const html = document.documentElement;
  let last: boolean | null = null;
  const sync = () => {
    const dark = html.classList.contains("dark");
    if (dark === last) return;
    last = dark;
    void api.androidBars(dark).catch(() => {});
  };
  new MutationObserver(sync).observe(html, { attributes: true, attributeFilter: ["class"] });
  sync();
}
