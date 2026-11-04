# Location Sharing: Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04 (weather card)
- `Store::forget_session_locations` now also removes a `weather_show` call that used the place, as it does a map. See `weather-card.md`.
- The `location_get` card says the weather loads from Open-Meteo (`src/components/location-card.tsx`).

### 2026-11-04 (device position on macOS)
- New `location_read` command (`src-tauri/src/location.rs`, `src-tauri/src/location/macos.rs`) reads one position through CoreLocation, asking for permission first if needed. `readLocation` (`src/lib/location.ts`) uses it on macOS and keeps `navigator.geolocation` on other platforms.
- New `src-tauri/Info.plist` holds the location usage strings, so `tauri dev` embeds them and builds without the icon config get them too. `Info.icon.plist` keeps its own copy.
- Blocked access now names the actual setting: System Settings → Privacy & Security → Location Services.
- An unbundled executable, which is what `tauri dev` runs, now gets an immediate error saying device location needs a built copy. The system logs showed `locationd` treating the dev binary as an unverified client: it showed no prompt and sent no reply, so the request waited out its 60 seconds.

### 2026-11-04
- The `location_get` card has a new device option, "Share for this session" ("Use device for this session" when an address is saved) (`src/components/location-card.tsx`). Its result carries `temporary: true` (`readLocation` in `src/lib/location.ts`).
- New `Store::forget_session_locations` (`crates/sush-core/src/store.rs`) rewrites each chat holding such a result: the `location_get` output becomes `{ removed, note }`, a `map_show` call whose input used the place becomes an error row with no input or output, and the exact place is replaced with `[location removed]` in any other string. The search index is rebuilt for those chats.
- It runs on `RunEvent::Exit` (`src-tauri/src/lib.rs`) and when the app loads (`AppState::load`, `src-tauri/src/state.rs`).
- The finished tool row reads "Shared location for this session", then "Location removed after its session" (`src/components/tool-parts.tsx`).
- Test: `session_locations_are_forgotten_and_others_kept`.

## Why

Every location request already asks, so there is no standing permission to limit. What lasts is the copy: a shared position stays in the chat's stored messages, its map and its search index. A session-only option has to remove that copy, or the label would promise more than it does.

A session ends when the user quits Sush. Chats have no end of their own, since they can be reopened at any time, so the app's run is the only clear boundary. The removal also runs at launch because a crash or force quit skips the exit event. In that case the location stays on disk until the next launch.

The card still asks on every request, including after a session-only share. Skipping the question would add a standing permission, which works against the reason for this option.

Device location could not work on macOS. A minimal WKWebView test with no private geolocation delegate, like the one Tauri's wry creates, got `PERMISSION_DENIED` from `getCurrentPosition` within 3 ms and showed no prompt. The card then told the user to change a privacy setting that had no effect. Going through CoreLocation avoids WebKit's private delegate API, at the cost of one more native dependency and a macOS-only code path.

## What makes it stand out

- The obvious version adds a button and a flag. This one removes the data, including maps drawn from the location, and has a test that checks the stored messages and the search index.
- It runs in Rust against SQLite, so it doesn't depend on a webview finishing an async save while the app closes.
- The removal happens in one transaction and is safe to run again.
- Later turns tell the model the location was removed and that it can ask again, so it doesn't work from an empty result.

Limits: the model and its provider have already received the location, and this can't recall it. The model's own rewording of a place, such as a city name, isn't recognised and stays in the chat. The location may also stay in the model's memory or files if it wrote it there against the tool's instructions. SQLite can keep deleted bytes in free pages or the WAL until they are overwritten, so this isn't a forensic erase.
