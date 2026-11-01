// Accounts on the hosted relay: the same better-auth setup as the Bun relay
// (`apps/server/src/auth.ts`), on D1, with passwords hashed natively (`password.ts`).

import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";

import { trustedOrigins } from "../../server/src/share/common";
import type { Env } from "./env";
import { hashPassword, verifyPassword } from "./password";

function create(env: Env, origin: string) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL || origin,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // The desktop app's origins, and the relay's own: the browser viewer it serves at
    // /join signs in from there, same-origin, with cookies.
    trustedOrigins: (request) => (request ? [...trustedOrigins, new URL(request.url).origin] : trustedOrigins),
    emailAndPassword: { enabled: true, minPasswordLength: 8, password: { hash: hashPassword, verify: verifyPassword } },
    user: { deleteUser: { enabled: true } },
    // Rate limits go by the caller's address, which Cloudflare puts here.
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    hooks: {
      // better-auth deletes without a password while the session is fresh; insist
      // on it so a stolen bearer token alone can't delete the account.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/delete-user" && !ctx.body?.password) {
          throw new APIError("BAD_REQUEST", { message: "Enter your password to delete your account." });
        }
      }),
    },
    // The desktop app reaches the relay from Rust, and its webview is cross-origin, so it uses a bearer token.
    plugins: [bearer()],
  });
}

let cached: { env: Env; auth: ReturnType<typeof create> } | undefined;

/** The relay's auth, made once per isolate (bindings only exist inside a request). */
export function authFor(env: Env, request: Request) {
  if (cached?.env !== env) cached = { env, auth: create(env, new URL(request.url).origin) };
  return cached.auth;
}
