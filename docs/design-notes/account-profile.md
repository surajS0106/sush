# Account Profile — Design Notes

Last updated: 2026-10-29

## What changed

### 2026-10-29 (Sign in with Sush, Connected apps)
- `apps/server/src/oauth.ts`: the auth server is also a small OAuth 2.1 server for Sush's own apps (client `plinth`): a script-free authorize page (sign in, Allow/Cancel, "Use another account"), PKCE S256, loopback `/callback` redirects only, hashed tokens in `oauth_grant`, rotating refresh tokens, userinfo, revoke, and one-time "same account" assertions the Sush app mints for Plinth.
- Settings → Account → Connected apps lists linked apps with Disconnect (`settings-dialog.tsx` `ConnectedAppsGroup`, `lib/auth.ts`). Connecting the Plinth connector passes an assertion so Plinth skips its pairing prompt for the same account (`library.ts` `signIn`, `connector_auth.rs`).
- Why: Plinth links to the person's existing Sush account instead of a second account. Details: `../plinth/docs/design-notes/sush-account.md`.

### 2026-10-12 (latest)
- Email is shown as read-only text again; the email-change helper and the server's `changeEmail` setting were removed (`settings-dialog.tsx`, `lib/auth.ts`, `apps/server/src/auth.ts`).

### 2026-10-12 (later)
- Four more built-in avatars: ikura gunkan, inari, hand roll and a matcha cup, for twelve in all (three rows in the picker's four-column grid) (`apps/desktop/src/lib/avatars.ts`).

### 2026-10-12
- Settings > Account can now edit the name and email inline (email editing later removed, see above) and change the password; before, it only displayed them (`apps/desktop/src/components/settings-dialog.tsx`, `AccountSection`, `ProfileField`, `PasswordDialog`).
- A pencil button on the profile picture opens a menu: Upload photo, Choose an avatar, Remove (`settings-dialog.tsx`).
- Uploaded photos are center-cropped and scaled to a 256px JPEG data URL on the client before saving (`apps/desktop/src/lib/avatars.ts`, `photoToDataUrl`).
- Eight built-in avatars: pixel-art sushi (salmon, tuna, shrimp, tamago, two maki rolls, onigiri, wasabi) drawn in the mascot's palette, stored as `sush:avatar/<key>` (`lib/avatars.ts`, `AVATARS`; picker in `AvatarPicker`).
- `UserAvatar` renders a photo, a built-in avatar or the name's initial; the sidebar profile button shows it once a picture is set (`apps/desktop/src/components/user-avatar.tsx`, `components/app-sidebar.tsx`).
- Client helpers `updateProfile`, `changePassword` (and `changeEmail`, since removed) wrap better-auth calls and throw readable errors (`apps/desktop/src/lib/auth.ts`).
- The auth server enabled email changes for unverified accounts (since removed) (`apps/server/src/auth.ts`).

## Why

The account page showed details the user could not change, which read as broken. Fields save on blur or Enter rather than through a form-level Save button, matching how other Settings rows apply immediately.

The picture is kept in better-auth's existing `user.image` column instead of a new blob store or Tauri command, so it follows the account and needs no schema change. The cost is that the image travels with every session fetch, which is why photos are shrunk to roughly tens of KB before upload.

Built-in avatars give people who do not want to upload a photo something more personal than an initial. Drawing them as sushi sprites in the mascot's colors keeps them on-brand. They are stored as ids rather than images, so a sprite can be redrawn later without migrating accounts.

The email stays read-only because it is the account's sign-in identity; changing it without a verification step would let a typo lock someone out.

Changing the password signs out other sessions, which is the expected outcome when someone suspects their password was exposed.

## What makes it stand out

- Avatars are 12×12 sprites rendered as SVG with one `rect` per horizontal run and `crispEdges`, so they stay sharp at any size and add no image assets (`spriteRects`).
- Photo handling crops to a square and flattens transparency onto white before JPEG encoding, so transparent PNGs do not turn black.
- `UserAvatar` is a single component with a three-step fallback (photo, sprite, initial), shared by Settings and the sidebar.
- The avatar picker is a radiogroup with `aria-checked` and visible focus rings; the picture button has an `aria-label`.
