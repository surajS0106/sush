import { getMigrations } from "better-auth/db/migration";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { auth, trustedOrigins } from "./auth";

// Create or update the auth tables before serving.
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

const app = new Hono();

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
app.get("/health", (c) => c.text("ok"));

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

export default { port, fetch: app.fetch };
