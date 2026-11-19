# Updater — Design Notes

Last updated: 2026-11-20

## What changed

### 2026-11-20
- The update check's timeout went from 10 s to 30 s, held in one constant, `CHECK_TIMEOUT_MS`, used by both the first check and the retry (`src/lib/updater.ts`).
- Added a "fixed" line to `UNRELEASED` in `src/lib/changelog.ts`.

## Why

The feed URL (`github.com/.../releases/latest/download/latest.json`) redirects to `release-assets.githubusercontent.com`, and the plugin's timeout covers both requests. On one user's network, connecting to the download host alone took about 7.5 s over both IPv4 and IPv6, and the whole fetch took about 10 s every time. With a 10 s limit, every manual check failed with "Couldn't reach the update server" even though the feed was healthy and 2.14.1 was published. Raising the limit to 30 s covers that. The trade-off: on a machine that really is offline, "Checking…" can now stay up for up to 30 s (60 s only in the rare 5xx retry path) before the error shows. Offline machines usually fail fast on DNS or connect anyway, so the longer wait mostly affects slow networks, where it lets the check succeed.

## What makes it stand out

- One timeout constant for both attempts, so the retry can't drift from the first check.
- The retry is still limited to GitHub's bad-response case ("valid release JSON"). A slow network gets one longer attempt instead of two short ones that both fail.
- The comment above the constant gives the measured reason, so the value isn't lowered again without data.
