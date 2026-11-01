/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the auth server; defaults to http://localhost:3000. */
  readonly VITE_AUTH_URL?: string;
  /** The relay a new Sharing setup suggests (the hosted one, `apps/relay`); defaults to the auth server. */
  readonly VITE_RELAY_URL?: string;
}
