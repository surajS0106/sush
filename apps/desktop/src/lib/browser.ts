// The built-in browser's state for the UI. Rust owns the webview (`browser.rs`);
// this follows the page it shows and opens the pane when the agent uses it.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, type BrowserPage } from "@/lib/tauri";
import { togglePanel } from "@/lib/workspaces";

/** Null until a page has been opened. */
const page = createStore<BrowserPage | null>("sush.browser-page", null, false);

/** Follow the browser. Call before rendering. */
export async function initBrowser() {
  const current = await api.browserSubscribe((event) => {
    if (event.type === "reveal") togglePanel("browser", true);
    else page.set({ url: event.url, title: event.title, loading: event.loading });
  });
  page.set(current);
}

export const useBrowserPage = () => useSyncExternalStore(page.subscribe, page.get);
