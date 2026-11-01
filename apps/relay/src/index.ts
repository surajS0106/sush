// The hosted relay for shared sessions, as a Cloudflare Worker: what the Bun
// server (`apps/server`) does for shares, without the "Sign in with Sush" OAuth
// pages, which stay on the app's own server. Accounts and the share API run in
// the Worker; each share's room is a Durable Object (`room.ts`).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { isAdmin, JOIN_FALLBACK_HTML, trustedOrigins, VIEWER_CSP } from "../../server/src/share/common";
import { authFor } from "./auth";
import { weekly } from "./db";
import type { App } from "./env";
import { shares } from "./routes";

export { Room } from "./room";

const app = new Hono<App>();

// Logs method and path only: invite tokens travel in request bodies, never in a path.
app.use(logger());
app.use(
  "/api/auth/*",
  cors({
    origin: trustedOrigins,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    // The bearer plugin hands the session token back in this header.
    exposeHeaders: ["set-auth-token"],
    credentials: true,
    maxAge: 600,
  }),
);
app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(c.env, c.req.raw).handler(c.req.raw));
// Shared sessions: the desktop app calls these from Rust, so no CORS.
app.route("/api/shares", shares);
app.get("/health", (c) => c.text("ok"));

// Weekly usage counts from shares their owners opted in. Admins only.
app.get("/api/metrics/weekly", async (c) => {
  const session = await authFor(c.env, c.req.raw).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in first." }, 401);
  if (!isAdmin(session.user.email)) return c.json({ error: "Only admins can see usage counts." }, 403);
  return c.json(await weekly(c.env.DB));
});

// An invite link opened in a browser: the browser viewer, or how to join from the app without one.
app.get("/join/:id", async (c) => {
  const page = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  if (!page.ok) return c.html(JOIN_FALLBACK_HTML);
  c.header("Content-Security-Policy", VIEWER_CSP);
  c.header("Referrer-Policy", "no-referrer");
  return c.html(await page.text());
});

// The viewer's scripts and styles (built with `base: "/viewer/"`, so its files sit at the folder's root).
app.get("/viewer/*", async (c) => {
  const rel = c.req.path.slice("/viewer/".length);
  if (!rel || rel.split("/").some((s) => s === ".." || s === ".")) return c.notFound();
  const file = await c.env.ASSETS.fetch(new URL(`/${rel}`, c.req.url));
  if (!file.ok) return c.notFound();
  const res = new Response(file.body, file);
  res.headers.set("Cache-Control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  return res;
});

export default app;
