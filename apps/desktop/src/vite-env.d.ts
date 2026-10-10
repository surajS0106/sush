/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the auth server; defaults to http://localhost:3000. */
  readonly VITE_AUTH_URL?: string;
}
