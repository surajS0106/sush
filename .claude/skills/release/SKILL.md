---
name: release
description: Bump the Sush version everywhere it is declared, commit, and tag a release, which triggers the GitHub release workflow. Only when the user explicitly asks to cut or prepare a release.
disable-model-invocation: true
argument-hint: <new-version, e.g. 0.2.0>
---

# Cut a release

Target version: `$ARGUMENTS`. If it's empty, ask for it. It must be plain semver without a `v`.

## 1. Preconditions

- On `main`, with a clean working tree (`git status`). If not, stop and tell the user.
- Run the `check` skill. Don't tag a failing build.

## 2. Bump the version (all five must match)

- `apps/desktop/src-tauri/tauri.conf.json`: `"version"` (installers and the release name come from this)
- `Cargo.toml`: `[workspace.package] version`
- `apps/desktop/package.json`: `"version"`
- `apps/server/package.json`: `"version"`
- `Cargo.lock`: refresh with `cargo update -p sush -p sush-core` (or any `cargo build`) so the workspace crate versions update. Don't upgrade other dependencies.

Confirm with: `git grep -n "<old-version>" -- '*.json' Cargo.toml` (should find no version fields).

## 3. Commit and tag

```sh
git commit -am "Release v<version>"
git tag v<version>
```

## 4. Push, after the user confirms

Pushing the tag publishes a public GitHub release (`.github/workflows/release.yml`). It builds Windows, macOS arm64/x64, and Linux installers with the auth server compiled as a sidecar. Show the user the commit and tag, and push only after they say yes:

```sh
git push origin main
git push origin v<version>
```

The workflow needs the `BETTER_AUTH_SECRET` repo secret. Mention it if you can't confirm that it's set (`gh secret list`).
