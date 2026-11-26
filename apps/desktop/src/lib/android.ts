// What the Android app does differently at startup (docs/android.md).

import { api } from "@/lib/tauri";

/** Marks the page for index.css, and keeps the system bars in step with Sush's theme. Call once, on Android. */
export function initAndroid() {
  const html = document.documentElement;
  html.dataset.android = "";
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
