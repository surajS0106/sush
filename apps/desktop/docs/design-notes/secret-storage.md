# Secret Storage — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12
- `secrets.rs` now routes every read, write and delete through a `backend` module with `read` / `write` / `remove` on a flat name (`provider:<id>`, `connector:<id>[:<n>]`). Release builds use the OS keyring under service `com.sush.app`. Debug builds use `dev-secrets.json` in the app config dir, created with mode `0600` on Unix and guarded by a mutex (`src-tauri/src/secrets.rs`).
- `secrets::init(&config_dir)` is called in the Tauri `setup` hook so the debug store knows where to write (`src-tauri/src/lib.rs`).
- The connector part-splitting logic (1000-char parts plus a count entry) is unchanged and now sits on top of the shared backend.

## Why

On macOS, a keychain item's "Always Allow" is bound to the code signature of the app that was allowed. `tauri dev` produces an ad-hoc signed binary whose signature changes on every rebuild. The keychain then treats each build as a new app and shows a "sush wants to access key com.sush.app" password prompt for every stored secret on every launch. `com.sush.app` is the keychain service name the secrets are filed under. In development that is pure friction with no security gain, since the developer owns both the machine and the secrets.

The trade-off: in debug builds, secrets sit in plaintext (owner-only) on disk, which breaks the usual "never on disk" rule. That only applies to `debug_assertions` builds, and release builds still use the keychain only. Keys saved in the keychain by earlier dev runs are not migrated, so they need to be entered once more in dev. A migration would have shown the same prompts it exists to remove.

## What makes it stand out

- One `cfg` switch picks the storage backend. Provider keys and chunked connector credentials share the same three primitives, so nothing above `secrets.rs` knows which store is in use.
- Release behavior is byte-for-byte the same service and entry names as before, so existing installed users keep their keychain items.
- The dev file is created owner-only (`0600`) and written under a lock, so concurrent connector writes cannot interleave.
- Compared with the usual fix (signing dev builds with a developer certificate), this needs no Apple account, certificate or per-machine setup.
