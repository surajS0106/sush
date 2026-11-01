# Sush relay on Cloudflare

The hosted relay for shared sessions, on Cloudflare's free plan. It does what `bun run dev:relay` does on your LAN, but at a public `https://` address, so people can join from anywhere.

**What it can see.** It only accepts end-to-end encrypted sessions (the app always encrypts through a relay that isn't on your local network). It stores accounts, plus who owns, was invited to and joined each share. Session content goes through it as ciphertext, and the key stays in the part of the invite link after `#`, which never reaches a server. Your files, keys and the agent all stay on the host's machine. One caveat: the browser viewer's code is served by the relay, so someone who controlled the relay could serve a viewer that reads the key. The desktop app doesn't have that problem.

## Deploy (once)

You need a free Cloudflare account. From the repo root:

```sh
bun install
cd apps/relay
bunx wrangler login
bunx wrangler d1 create sush-relay          # copy the database_id into wrangler.jsonc
bunx wrangler secret put BETTER_AUTH_SECRET # paste the output of: openssl rand -base64 32
cd ../..
bun run deploy:relay                        # builds the viewer, creates the tables, deploys
```

Wrangler prints the address, like `https://sush-relay.<you>.workers.dev`. Then:

- In Sush, Settings → Sharing: set the relay to that address, and create an account on it.
- For release builds: add a repository variable `SUSH_RELAY_URL` with the address (GitHub → Settings → Secrets and variables → Actions → Variables). New installs then suggest it.
- Optionally `bunx wrangler secret put BETTER_AUTH_URL` with the same address (otherwise each request's own address is used).

Later deploys are `bun run deploy:relay`. New files in `migrations/` are applied as part of it.

## Changing the tables

The tables are defined in `src/schema.ts` with Drizzle. After changing it, run `bun run db:generate` in `apps/relay` (or `bunx drizzle-kit generate --name <what changed>`): drizzle-kit writes the next migration into `migrations/` and its snapshot into `migrations/meta/`. Commit both, and never edit a generated migration by hand. The next `bun run dev:relay-cf` or `bun run deploy:relay` applies it (wrangler keeps track of which ones have run). Keep the share tables in step with the Bun relay (`apps/server/src/share/db.ts`).

## Run it locally

```sh
echo 'BETTER_AUTH_SECRET=dev-only-secret-change-me' > apps/relay/.dev.vars
bun run dev:relay-cf   # http://localhost:8787, with a local D1 and Durable Objects
```

## Settings

`wrangler.jsonc` → `vars`: `SUSH_PLANS`, `SUSH_TEAM_EMAILS`, `SUSH_ADMIN_EMAILS`, as on the Bun relay (`apps/server/src/share/plans.ts`, `metrics.ts`).

## Free plan limits

- 100,000 requests a day. With hibernation, an idle room uses nothing, and messages over a WebSocket count far less than requests.
- 10 ms of CPU per request. Passwords are hashed with PBKDF2 in Web Crypto (`src/password.ts`), not better-auth's JavaScript scrypt, which goes over it. If sign-ins ever fail with error 1102, lower `ITERATIONS` there; existing passwords keep working.
- D1: 5 GB and 5 million reads a day.

## Keeping it in step with the Bun relay

`apps/server/src/share/common.ts` and `plans.ts` are shared: limits, plans, pictures, usage buckets, the viewer's CSP. The room (`src/room.ts`) and routes (`src/routes.ts`) mirror `apps/server/src/share/relay.ts` and `routes.ts`, so a change to the protocol goes in both.
