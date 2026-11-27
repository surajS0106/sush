import "katex/dist/katex.min.css";
import "./index.css";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { AuthGate } from "./components/auth-gate";
import { WindowControls } from "./components/window-controls";
import { initBrowser } from "./lib/browser";
import { initDocs } from "./lib/docs";
import { initMemory } from "./lib/memory";
import { initNotebooks } from "./lib/notebooks";
import { initReports } from "./lib/reports";
import { initSessions } from "./lib/sessions";
import { initShares } from "./lib/share";
import { initWorkspaces } from "./lib/workspaces";
import { initSelectAll } from "./lib/select-all";
import { initZoom } from "./lib/zoom";
import { initAndroid } from "./lib/android";
import { isAndroid, isIOS, isMobile } from "./lib/utils";
import { initStore } from "./lib/store";
import { errorMessage } from "./lib/tauri";

// The webview ignores window.open and target="_blank", so external links (e.g. Streamdown's
// "Open link" button) would silently do nothing. Hand them to the OS default browser instead.
const isExternal = (url: string) => /^(https?:|mailto:|tel:)/i.test(url);
const nativeOpen = window.open.bind(window);
window.open = (url, target, features) => {
  const href = url?.toString();
  if (href && isExternal(href)) {
    void openUrl(href);
    return null;
  }
  return nativeOpen(url, target, features);
};
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (a && a.target === "_blank" && isExternal(a.href)) {
    e.preventDefault();
    void openUrl(a.href);
  }
});

// Marks the page for index.css's phone rules.
if (isMobile) document.documentElement.dataset.mobile = "";
if (isIOS) {
  document.documentElement.dataset.ios = "";
  // iOS zooms the page into any field with text under 16px when it's focused, and doesn't zoom back.
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover");
}
if (isAndroid) initAndroid();
else if (!isIOS) initZoom();
initSelectAll();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Conversations and memory load from disk before anything renders, so the UI
// can read them synchronously; then follow the runs already going.
Promise.all([initStore(), initMemory(), initWorkspaces(), initBrowser(), initReports(), initNotebooks(), initDocs()])
  .then(initSessions)
  // Shared sessions come after the runs: their frames arrive on the same channel.
  .then(initShares)
  .then(
  () =>
    root.render(
      <React.StrictMode>
        {/* Light, dark, or follow the OS; the choice persists in localStorage. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="sush.theme">
          <AuthGate>
            <App />
          </AuthGate>
          <WindowControls />
        </ThemeProvider>
      </React.StrictMode>,
    ),
  (e) =>
    root.render(
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="sush.theme">
        <div data-tauri-drag-region className="flex h-svh flex-col items-center justify-center gap-2 p-8 text-center">
          <h1 className="text-lg font-medium">Sush couldn’t open your local data</h1>
          <p className="max-w-md text-sm wrap-break-word text-muted-foreground">{errorMessage(e)}</p>
        </div>
        <WindowControls />
      </ThemeProvider>,
    ),
);
