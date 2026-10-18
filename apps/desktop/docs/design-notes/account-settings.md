# Account Settings — Design Notes

Last updated: 2026-10-14

## What changed

### 2026-10-14
- Delete account (issue #16). Settings → Account has a "Delete account" row below Sign out, with a destructive button (`src/components/settings-dialog.tsx`, `AccountSection`). The section's search keywords include "delete account".
- `DeleteAccountDialog` asks for the current password and explains that chats, memory and workspaces are stored on this computer and stay there. While the request runs, the dialog can't be dismissed; on failure it shows the server's message inline (`src/components/settings-dialog.tsx:687`).
- `deleteAccount(password)` in `src/lib/auth.ts` calls better-auth's `deleteUser`, then clears the bearer token and refreshes the session. `signOut` now uses the same `clearSession` helper, so both paths return the app to the sign-in screen in the same way.
- Server: `user.deleteUser.enabled` is on in `apps/server/src/auth.ts`, and a `hooks.before` middleware rejects `/delete-user` requests that carry no password.

## Why

A user could create an account but had no way to remove it. Deletion is irreversible, so the confirmation needs proof beyond the session: better-auth's default deletes without a password while the session is "fresh" (one day), which would let a leaked bearer token delete the account. Requiring the password on the server, not only in the UI, closes that gap. The trade-off is that a future social-login account with no password could not use this flow without adding email verification.

Local data is kept rather than wiped. Chats, memory and workspaces never reach the server, so deleting the account doesn't affect them, and wiping them needs a separate, careful Rust command. The dialog states this plainly so nobody assumes their data left the machine, or that it was erased.

## What makes it stand out

- The password check is enforced by the auth server, so calling `POST /delete-user` directly with a stolen token fails, unlike enabling better-auth's flag alone.
- One `clearSession` path for sign-out and delete: there is no second route back to sign-in to keep in sync.
- The dialog states where the user's data lives instead of a generic "this can't be undone" warning.
- The dialog can't be dismissed mid-request, so the UI can't drift from what the server did; errors appear inline next to the field instead of in a transient toast.
