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

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_AUTH_URL ?? "http://localhost:3000",
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
