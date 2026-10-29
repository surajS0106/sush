// Account auth against the Sush auth server (apps/server, better-auth).
//
// The webview is cross-origin to that server, so instead of cookies the
// server's bearer plugin returns a session token in `set-auth-token`; we keep
// it in localStorage and send it as `Authorization: Bearer` on every call.

import { createAuthClient } from "better-auth/react";

const TOKEN_KEY = "sush.authToken";

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    console.warn("Could not persist auth token", e);
  }
}

/** The server accounts live on. In dev it doubles as the relay for shared sessions. */
export const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? "http://localhost:3000";

/** This app's session token, to share through the same server without signing in again (`lib/share.ts`). */
export const getAuthToken = readToken;

export const authClient = createAuthClient({
  baseURL: AUTH_URL,
  fetchOptions: {
    auth: { type: "Bearer", token: readToken },
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) writeToken(token);
    },
  },
});

export const useSession = authClient.useSession;

/** Throws with the server's message when better-auth answers with an error. */
function check<T>(res: { data: T | null; error: { message?: string; statusText?: string } | null }): T | null {
  if (res.error) throw new Error(res.error.message || res.error.statusText || "Request failed");
  return res.data;
}

/** Name and/or picture; `image` is a data URL, a built-in avatar id (lib/avatars.ts) or null to clear it. */
export async function updateProfile(patch: { name?: string; image?: string | null }) {
  check(await authClient.updateUser(patch));
}

export async function changePassword(currentPassword: string, newPassword: string) {
  check(await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }));
}

/** Forget the token and refresh the session, which takes the app back to sign-in. */
async function clearSession() {
  writeToken(null);
  await authClient.getSession();
}

export async function signOut() {
  try {
    await authClient.signOut();
  } finally {
    // Drop the local token even if the server is unreachable.
    await clearSession();
  }
}

/** Deletes the account and its sessions on the server. Local chats, memory and workspaces are left alone. */
export async function deleteAccount(password: string) {
  check(await authClient.deleteUser({ password }));
  await clearSession();
}

// --- apps signed in with this account (apps/server/src/oauth.ts) ---------------------

/** An app linked to this account with "Sign in with Sush" (Plinth). */
export interface ConnectedApp {
  id: string;
  name: string;
  linkedAt: number;
  lastUsedAt: number;
  /** How many sign-ins (devices) it holds. */
  devices: number;
}

async function oauthApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${AUTH_URL}/api/oauth${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${readToken()}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const connectedApps = () => oauthApi<ConnectedApp[]>("/apps");

/** Disconnects an app on every device: its tokens stop working and it has to sign in again. */
export const disconnectApp = (id: string) => oauthApi<void>(`/apps/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * A one-time proof that this is the signed-in account, for `audience` (an app id). Plinth checks it
 * with this server and, when it's signed in as the same account, lets Sush connect without asking.
 * Null when signed out or the server can't be reached; the app then just asks as usual.
 */
export async function assertionFor(audience: string): Promise<string | null> {
  if (!readToken()) return null;
  try {
    return (await oauthApi<{ assertion: string }>("/assertion", { method: "POST", body: JSON.stringify({ audience }) })).assertion;
  } catch {
    return null;
  }
}
