import "katex/dist/katex.min.css";
import "./index.css";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { AuthGate } from "./components/auth-gate";
import { WindowControls } from "./components/window-controls";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Light, dark, or follow the OS; the choice persists in localStorage. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="sush.theme">
      <AuthGate>
        <App />
      </AuthGate>
      <WindowControls />
    </ThemeProvider>
  </React.StrictMode>,
);
