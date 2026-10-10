import "katex/dist/katex.min.css";
import "./index.css";

import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { AuthGate } from "./components/auth-gate";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Light, dark, or follow the OS; the choice persists in localStorage. */}
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="sush.theme">
      <AuthGate>
        <App />
      </AuthGate>
    </ThemeProvider>
  </React.StrictMode>,
);
