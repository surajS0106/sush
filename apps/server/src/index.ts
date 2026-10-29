import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { getMigrations } from "better-auth/db/migration";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { auth, trustedOrigins } from "./auth";
import { oauth, oauthAccount } from "./oauth";
import { isAdmin, weekly } from "./share/metrics";
import { shares } from "./share/routes";

// Create or update the auth tables before serving.
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

const app = new Hono();

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
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
// "Sign in with Sush" for Sush's own apps (Plinth): the browser pages and the endpoints the apps
// call from their native side (`oauth.ts`), and the Sush app's own view of its connected apps.
app.use(
  "/api/oauth/*",
  cors({ origin: trustedOrigins, allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], maxAge: 600 }),
);
app.route("/api/oauth", oauthAccount);
app.route("/", oauth);
// Shared sessions: the desktop app calls these from Rust, so no CORS.
app.route("/api/shares", shares);
app.get("/health", (c) => c.text("ok"));

// Weekly usage counts from shares their owners opted in (`share/metrics.ts`). Admins only.
app.get("/api/metrics/weekly", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in first." }, 401);
  if (!isAdmin(session.user.email)) return c.json({ error: "Only admins can see usage counts." }, 403);
  return c.json(weekly());
});

// An invite link opened in a browser: the browser viewer (`apps/viewer`), which watches
// and comments without installing Sush. Its token and key are after the `#`, which
// browsers never send. Without a viewer build, a page that says how to join from the app.
const viewerDir = process.env.SUSH_VIEWER_DIR ?? fileURLToPath(new URL("../../viewer/dist/", import.meta.url));
// Nothing it renders can load or run anything from elsewhere.
const VIEWER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

app.get("/join/:id", async (c) => {
  const page = Bun.file(join(viewerDir, "index.html"));
  if (await page.exists()) {
    c.header("Content-Security-Policy", VIEWER_CSP);
    c.header("Referrer-Policy", "no-referrer");
    return c.html(await page.text());
  }
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join a Sush session</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}code{font-size:.9em}</style></head>
<body><h1>Join a shared Sush session</h1>
<p>Open Sush, choose <b>Join shared session…</b> in the sidebar, and paste this page’s link (the whole address, including the part after <code>#</code>).</p>
<p>You need a Sharing account on this relay: Settings → Sharing.</p></body></html>`);
});

// The viewer's scripts and styles (built with `base: "/viewer/"`).
app.get("/viewer/*", async (c) => {
  const rel = normalize(c.req.path.slice("/viewer/".length));
  if (rel.startsWith("..") || isAbsolute(rel)) return c.notFound();
  const file = Bun.file(join(viewerDir, rel));
  if (!(await file.exists())) return c.notFound();
  c.header("Cache-Control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  return new Response(file);
});

// When bundled as the desktop app's sidecar, exit once the app is gone, even if
// it was killed before it could stop us.
const parentPid = Number(process.env.SUSH_PARENT_PID);
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 2000);
}

const port = Number(process.env.PORT ?? 3000);
console.log(`Auth server listening on http://localhost:${port}`);
if (process.env.SUSH_RELAY_LAN) {
  // Others on the network reach it at this machine's address (shown by `ipconfig` / `ifconfig`).
  console.log(`Relay for shared sessions on every network interface, port ${port}`);
}

export default {
  port,
  // The sidecar is for this machine only; a relay for the LAN listens on every interface.
  hostname: process.env.SUSH_RELAY_LAN ? "0.0.0.0" : "127.0.0.1",
  fetch: app.fetch,
  // Snapshots of long sessions can be large; guests' own messages are capped in `share/relay.ts`.
  websocket: { ...websocket, maxPayloadLength: 32 * 1024 * 1024 },
};
