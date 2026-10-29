// "Sign in with Sush": this server as a small OAuth 2.1 authorization server for Sush's own apps
// (Plinth so far), so they can link to a Sush account.
//
// - Clients are fixed (`CLIENTS`), public (no secret) and may only redirect to this machine
//   (`http://127.0.0.1|localhost|[::1]:<any port>/callback`, RFC 8252), with PKCE S256.
// - `/oauth/authorize` is a page in the browser: sign in with the Sush account (cookies, same
//   origin, plain forms and no script), then Allow or Cancel. Every POST checks its Origin.
// - `/oauth/token` trades the code for an access token (an hour) and a refresh token that rotates.
//   Only their hashes are kept (`oauth_grant`); Settings → Account in Sush lists the grants as
//   connected apps and revokes them.
// - Assertions say "this is the same account": the Sush app mints a one-time one for Plinth
//   (`POST /api/oauth/assertion`), passes it along when it connects to Plinth's MCP server, and
//   Plinth checks it here with its own token (`POST /oauth/assertion/check`). Plinth then skips its
//   pairing prompt, since both apps are signed in as the same person.

import { Hono, type Context } from "hono";

import { auth, db } from "./auth";
import { hashToken, randomId, user, type UserRow } from "./share/db";

/** The apps that can sign in with Sush, by client id. */
const CLIENTS: Record<string, { name: string }> = {
  plinth: { name: "Plinth" },
};

const ACCESS_TTL = 60 * 60 * 1000;
const CODE_TTL = 2 * 60 * 1000;
const ASSERTION_TTL = 2 * 60 * 1000;
/** Grants one account keeps per app; the oldest goes first (a few devices, a re-link). */
const GRANTS_PER_APP = 8;

db.run(`CREATE TABLE IF NOT EXISTS oauth_grant (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
)`);

interface GrantRow {
  id: string;
  user_id: string;
  client_id: string;
  access_hash: string;
  access_expires: number;
  refresh_hash: string;
  created_at: number;
  last_used_at: number;
}

interface Code {
  userId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  expires: number;
}

/** Codes and assertions live for a minute or two, so memory is enough; a restart just means trying again. */
const codes = new Map<string, Code>();
const assertions = new Map<string, { userId: string; audience: string; expires: number }>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires <= now) codes.delete(k);
  for (const [k, v] of assertions) if (v.expires <= now) assertions.delete(k);
}

/** Whether a redirect comes back to this machine, at `/callback` on any port. */
export function isLoopbackCallback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.pathname === "/callback" && !u.username && !u.hash;
  } catch {
    return false;
  }
}

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}

/** Checks an authorization request's parameters; a string is what's wrong with them. */
function readRequest(q: URLSearchParams): AuthorizeRequest | string {
  const clientId = q.get("client_id") ?? "";
  if (!CLIENTS[clientId]) return "That app can't sign in with Sush.";
  if (q.get("response_type") !== "code") return "That app asked for a kind of sign-in Sush doesn't offer.";
  const redirectUri = q.get("redirect_uri") ?? "";
  if (!isLoopbackCallback(redirectUri)) return "Sush only sends sign-ins back to apps on this computer.";
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return "That app's sign-in is missing its PKCE challenge.";
  return { clientId, redirectUri, challenge, state: q.get("state") ?? "" };
}

function requestQuery(r: AuthorizeRequest): string {
  return new URLSearchParams({
    client_id: r.clientId,
    response_type: "code",
    redirect_uri: r.redirectUri,
    code_challenge: r.challenge,
    code_challenge_method: "S256",
    ...(r.state ? { state: r.state } : {}),
  }).toString();
}

function back(r: AuthorizeRequest, params: Record<string, string>): string {
  const u = new URL(r.redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (r.state) u.searchParams.set("state", r.state);
  return u.toString();
}

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Nothing on these pages runs script or loads anything; forms post here or go back to the app.
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*; frame-ancestors 'none'; base-uri 'none'";

function page(c: Context, title: string, body: string, status: 200 | 400 | 401 = 200) {
  c.header("Content-Security-Policy", PAGE_CSP);
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--soft:#6b6b6b;--line:#e3e3e3;--field:#fafafa;--accent:#1a1a1a;--on-accent:#fff;--bad:#c4302b}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ededed;--soft:#9a9a9a;--line:#2c2c2c;--field:#1c1c1c;--accent:#ededed;--on-accent:#141414;--bad:#ff6b63}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{width:100%;max-width:24rem}h1{font-size:20px;line-height:1.3;margin:0 0 8px}p{margin:0 0 16px;color:var(--soft)}
label{display:block;font-size:13px;font-weight:500;margin:0 0 4px}input{width:100%;font:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--fg);margin:0 0 12px}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}button{font:inherit;font-weight:500;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.go{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.who{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:12px;margin:0 0 16px}
.who b{display:block}.who span{color:var(--soft);font-size:13px}.err{color:var(--bad)}.link{border:0;padding:0;color:var(--soft);text-decoration:underline;font-weight:400}
</style></head><body><main>${body}</main></body></html>`,
    status,
  );
}

/** Same-origin POSTs only: the browser's Origin (or, failing that, Referer) must be this server. */
function sameOrigin(c: Context): boolean {
  const own = new URL(c.req.url).origin;
  const origin = c.req.header("origin");
  if (origin) return origin === own;
  const referer = c.req.header("referer");
  try {
    return !!referer && new URL(referer).origin === own;
  } catch {
    return false;
  }
}

/** Copies the auth handler's cookies onto our redirect. */
function redirectWithCookies(c: Context, from: Response, to: string) {
  const headers = new Headers({ Location: to, "Cache-Control": "no-store" });
  for (const cookie of from.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function signInPage(c: Context, r: AuthorizeRequest, error?: string) {
  const app = escape(CLIENTS[r.clientId]!.name);
  return page(
    c,
    `Sign in to ${CLIENTS[r.clientId]!.name} with Sush`,
    `<h1>Sign in to ${app} with Sush</h1>
<p>Use your Sush account. ${app} gets your name, email and picture.</p>
${error ? `<p class="err" role="alert">${escape(error)}</p>` : ""}
<form method="post" action="/oauth/sign-in">
<input type="hidden" name="next" value="${escape(requestQuery(r))}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="go" type="submit">Sign in</button></div>
</form>`,
    error ? 401 : 200,
  );
}

function consentPage(c: Context, r: AuthorizeRequest, u: UserRow) {
  const app = escape(CLIENTS[r.clientId]!.name);
  const hidden = [...new URLSearchParams(requestQuery(r))].map(([k, v]) => `<input type="hidden" name="${k}" value="${escape(v)}">`).join("");
  return page(
    c,
    `Allow ${CLIENTS[r.clientId]!.name} to use your Sush account?`,
    `<h1>Allow ${app} to use your Sush account?</h1>
<p>${app} will show your name, email and picture, and know when Sush connects to it as you. It can't read your chats or change your account.</p>
<div class="who"><div><b>${escape(u.name || "Unnamed")}</b><span>${escape(u.email)}</span></div></div>
<form method="post" action="/oauth/authorize">${hidden}
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="go" type="submit" name="decision" value="allow">Allow</button></div>
</form>
<form method="post" action="/oauth/sign-out"><input type="hidden" name="next" value="${escape(requestQuery(r))}">
<p style="margin:16px 0 0">Not you? <button class="link" type="submit">Use another account</button></p></form>
<p style="margin-top:16px;font-size:13px">You can disconnect ${app} any time in Sush: Settings → Account.</p>`,
  );
}

const formParams = async (c: Context) => new URLSearchParams((await c.req.text()).slice(0, 16 << 10));

/** Mints tokens for a grant (new, or replacing a refreshed one's). */
function issue(userId: string, clientId: string, replacing?: string) {
  const access = randomId(32);
  const refresh = randomId(32);
  const now = Date.now();
  if (replacing) {
    db.run("UPDATE oauth_grant SET access_hash = ?, access_expires = ?, refresh_hash = ?, last_used_at = ? WHERE id = ?", [
      hashToken(access),
      now + ACCESS_TTL,
      hashToken(refresh),
      now,
      replacing,
    ]);
  } else {
    db.run(
      "INSERT INTO oauth_grant (id, user_id, client_id, access_hash, access_expires, refresh_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomId(), userId, clientId, hashToken(access), now + ACCESS_TTL, hashToken(refresh), now, now],
    );
    db.run(
      `DELETE FROM oauth_grant WHERE user_id = ? AND client_id = ? AND id NOT IN
         (SELECT id FROM oauth_grant WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT ${GRANTS_PER_APP})`,
      [userId, clientId, userId, clientId],
    );
  }
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh };
}

/** The grant and account behind an app's bearer token, if it's current. */
function bearerGrant(c: Context): { grant: GrantRow; user: UserRow } | null {
  const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const grant = db.query<GrantRow, [string]>("SELECT * FROM oauth_grant WHERE access_hash = ?").get(hashToken(token));
  if (!grant || grant.access_expires <= Date.now()) return null;
  const u = user(grant.user_id);
  if (!u) return null;
  // At most one write a minute per grant.
  if (Date.now() - grant.last_used_at > 60_000) db.run("UPDATE oauth_grant SET last_used_at = ? WHERE id = ?", [Date.now(), grant.id]);
  return { grant, user: u };
}

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status);

/** The browser pages and the endpoints apps call (from their native side, so no CORS). */
export const oauth = new Hono();

oauth.get("/.well-known/oauth-authorization-server", (c) => {
  const base = new URL(c.req.url).origin;
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

oauth.get("/oauth/authorize", async (c) => {
  const r = readRequest(new URL(c.req.url).searchParams);
  if (typeof r === "string") return page(c, "Sush can't sign that app in", `<h1>Sush can't sign that app in</h1><p>${escape(r)}</p>`, 400);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const u = session && user(session.user.id);
  return u ? consentPage(c, r, u) : signInPage(c, r);
});

oauth.post("/oauth/sign-in", async (c) => {
  if (!sameOrigin(c)) return c.text("Forbidden", 403);
  const form = await formParams(c);
  const r = readRequest(new URLSearchParams(form.get("next") ?? ""));
  if (typeof r === "string") return page(c, "Sush can't sign that app in", `<h1>Sush can't sign that app in</h1><p>${escape(r)}</p>`, 400);
  const res = await auth.api.signInEmail({ body: { email: form.get("email") ?? "", password: form.get("password") ?? "" }, asResponse: true });
  if (!res.ok) {
    const message = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
    return signInPage(c, r, message || "That email and password don't match a Sush account.");
  }
  return redirectWithCookies(c, res, `/oauth/authorize?${requestQuery(r)}`);
});

oauth.post("/oauth/sign-out", async (c) => {
  if (!sameOrigin(c)) return c.text("Forbidden", 403);
  const r = readRequest(new URLSearchParams((await formParams(c)).get("next") ?? ""));
  const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
  return redirectWithCookies(c, res, typeof r === "string" ? "/" : `/oauth/authorize?${requestQuery(r)}`);
});

oauth.post("/oauth/authorize", async (c) => {
  if (!sameOrigin(c)) return c.text("Forbidden", 403);
  const form = await formParams(c);
  const r = readRequest(form);
  if (typeof r === "string") return page(c, "Sush can't sign that app in", `<h1>Sush can't sign that app in</h1><p>${escape(r)}</p>`, 400);
  if (form.get("decision") !== "allow") {
    return c.redirect(back(r, { error: "access_denied", error_description: "The sign-in was cancelled in the browser." }), 303);
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return signInPage(c, r);
  sweep();
  const code = randomId(32);
  codes.set(code, { userId: session.user.id, clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.challenge, expires: Date.now() + CODE_TTL });
  return c.redirect(back(r, { code }), 303);
});

oauth.post("/oauth/token", async (c) => {
  const form = await formParams(c);
  const clientId = form.get("client_id") ?? "";
  if (!CLIENTS[clientId]) return oauthError(c, "invalid_client", "That app can't sign in with Sush.", 401);
  switch (form.get("grant_type")) {
    case "authorization_code": {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!code || code.expires <= Date.now() || code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri")) {
        return oauthError(c, "invalid_grant", "That sign-in code isn't valid any more; sign in again.");
      }
      const verifier = form.get("code_verifier") ?? "";
      const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
      if (challenge !== code.challenge) return oauthError(c, "invalid_grant", "The PKCE verifier doesn't match.");
      if (!user(code.userId)) return oauthError(c, "invalid_grant", "That account no longer exists.");
      return c.json(issue(code.userId, clientId), 200, { "Cache-Control": "no-store" });
    }
    case "refresh_token": {
      const grant = db
        .query<GrantRow, [string, string]>("SELECT * FROM oauth_grant WHERE refresh_hash = ? AND client_id = ?")
        .get(hashToken(form.get("refresh_token") ?? ""), clientId);
      if (!grant || !user(grant.user_id)) return oauthError(c, "invalid_grant", "That sign-in has ended; sign in with Sush again.");
      return c.json(issue(grant.user_id, clientId, grant.id), 200, { "Cache-Control": "no-store" });
    }
    default:
      return oauthError(c, "unsupported_grant_type", "Sush takes authorization codes and refresh tokens.");
  }
});

/** RFC 7009: ends the grant either token belongs to. Always 200, whether or not it was known. */
oauth.post("/oauth/revoke", async (c) => {
  const h = hashToken((await formParams(c)).get("token") ?? "");
  db.run("DELETE FROM oauth_grant WHERE access_hash = ? OR refresh_hash = ?", [h, h]);
  return c.body(null, 200);
});

oauth.get("/oauth/userinfo", (c) => {
  const found = bearerGrant(c);
  if (!found) return oauthError(c, "invalid_token", "Sign in with Sush again.", 401);
  const { user: u } = found;
  return c.json({ sub: u.id, name: u.name, email: u.email, picture: u.image });
});

/** Whether an assertion the Sush app minted belongs to the account this app is signed in as. One use. */
oauth.post("/oauth/assertion/check", async (c) => {
  const found = bearerGrant(c);
  if (!found) return oauthError(c, "invalid_token", "Sign in with Sush again.", 401);
  sweep();
  const key = hashToken((await formParams(c)).get("assertion") ?? "");
  const a = assertions.get(key);
  assertions.delete(key);
  const sameAccount = !!a && a.expires > Date.now() && a.audience === found.grant.client_id && a.userId === found.user.id;
  return c.json({ sameAccount });
});

/** The Sush app's side, with its session's bearer token (CORS in index.ts). */
export const oauthAccount = new Hono<{ Variables: { userId: string } }>();

oauthAccount.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Sign in first." }, 401);
  c.set("userId", session.user.id);
  await next();
});

/** Settings → Account → Connected apps: one row per app, with its newest sign-in. */
oauthAccount.get("/apps", (c) => {
  const rows = db
    .query<{ client_id: string; linked_at: number; last_used_at: number; devices: number }, [string]>(
      `SELECT client_id, MIN(created_at) AS linked_at, MAX(last_used_at) AS last_used_at, COUNT(*) AS devices
         FROM oauth_grant WHERE user_id = ? GROUP BY client_id ORDER BY last_used_at DESC`,
    )
    .all(c.get("userId"));
  return c.json(
    rows
      .filter((r) => CLIENTS[r.client_id])
      .map((r) => ({ id: r.client_id, name: CLIENTS[r.client_id]!.name, linkedAt: r.linked_at, lastUsedAt: r.last_used_at, devices: r.devices })),
  );
});

/** Disconnects an app everywhere: all its tokens for this account stop working. */
oauthAccount.delete("/apps/:id", (c) => {
  db.run("DELETE FROM oauth_grant WHERE user_id = ? AND client_id = ?", [c.get("userId"), c.req.param("id")]);
  return c.body(null, 204);
});

/** A one-time "this is me" for an app (`audience`), good for two minutes. */
oauthAccount.post("/assertion", async (c) => {
  const audience = ((await c.req.json().catch(() => ({}))) as { audience?: string }).audience ?? "";
  if (!CLIENTS[audience]) return c.json({ error: "Unknown app." }, 400);
  sweep();
  const assertion = randomId(32);
  assertions.set(hashToken(assertion), { userId: c.get("userId"), audience, expires: Date.now() + ASSERTION_TTL });
  return c.json({ assertion });
});
