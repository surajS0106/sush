import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";

/** Origins the desktop webview loads from: Vite in dev, Tauri's custom protocol in builds. */
export const trustedOrigins = ["http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  // Falls back to a dev-only secret; set BETTER_AUTH_SECRET in production.
  secret: process.env.BETTER_AUTH_SECRET,
  database: new Database(process.env.DATABASE_PATH ?? "auth.sqlite"),
  trustedOrigins,
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  // The Tauri webview is cross-origin to this server, where cookies are unreliable,
  // so the desktop client authenticates with a bearer token instead.
  plugins: [bearer()],
});
