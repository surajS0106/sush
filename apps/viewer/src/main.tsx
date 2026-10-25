import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import "./styles.css";

/** A render error shows itself instead of leaving an empty page. */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="centered">
        <h1>This page hit a problem</h1>
        <p className="muted">Reloading usually helps. If it doesn’t, send the text below to whoever runs this relay.</p>
        <pre className="crash">{`${error.message}

${error.stack ?? ""}`}</pre>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
