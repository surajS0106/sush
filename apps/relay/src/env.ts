import type { Room } from "./room";

/** The Worker's bindings (`wrangler.jsonc`) and secrets. */
export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace<Room>;
  /** The browser viewer's build. */
  ASSETS: Fetcher;
  /** `bunx wrangler secret put BETTER_AUTH_SECRET` */
  BETTER_AUTH_SECRET: string;
  /** The relay's public address; without it, the address each request came to. */
  BETTER_AUTH_URL?: string;
}

/** Hono's types for the routes. */
export type App = { Bindings: Env };
