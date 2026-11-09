/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the auth server; defaults to http://localhost:3000. */
  readonly VITE_AUTH_URL?: string;
}

/** The app version from tauri.conf.json (vite.config.ts). */
declare const __APP_VERSION__: string;
/** The day this bundle was built, `YYYY-MM-DD` (vite.config.ts). */
declare const __BUILD_DATE__: string;
