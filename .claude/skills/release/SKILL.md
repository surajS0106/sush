---
name: release
description: Publish a commit of main as a Sush release by tagging it (the installers main already built for it go out), then move main on to the next version. Only when the user explicitly asks to cut or publish a release.
disable-model-invocation: true
argument-hint: "[commit, default main's latest] [next version, default the next minor]"
---

# Publish a release

How releases work: main always carries the version it will be released as (`tauri.conf.json`), and its notes are `UNRELEASED` in `apps/desktop/src/lib/changelog.ts`, which the app already shows as that version's What's new. Every push to main runs `.github/workflows/build.yml`, which builds signed installers for every platform and keeps them on the run. Pushing a tag `v<version>` runs `.github/workflows/release.yml`, which compiles nothing: it takes the installers of that commit's build, writes `latest.json`, and publishes the release (draft, attach, publish), about a minute. Releasing is tagging; nothing is bumped before the tag.

Arguments: `$ARGUMENTS`. The first is the commit to release (default: `origin/main`'s latest). The second is the version main moves to afterwards (default: next minor, `2.8.0` → `2.9.0`). Both are optional.

## 1. Check the commit is ready

```sh
git fetch origin --tags
git status                                  # on main, clean, nothing unpushed
git rev-parse origin/main                   # the commit to release, unless one was given
```

- Version: `git show <sha>:apps/desktop/src-tauri/tauri.conf.json | jq -r .version`. No tag `v<version>` may exist yet (`git tag -l v<version>`).
- Notes: at that commit, `UNRELEASED` is non-empty and `UNRELEASED_SUMMARY` set. These ship inside the installers, so if they need work, commit and push that first (a notes-only commit still rebuilds, about 6 minutes), and release that commit instead. Compare against `git log v<previous>..<sha>` for user-facing changes they miss. Write for users: what they can now do, not how it's built.
- CI and the build passed for that commit:

```sh
gh run list --commit <sha> --json workflowName,status,conclusion
```

  `CI` and `Build` should both be `success`. If `Build` is still running, say so and wait for it with `gh run watch <id>` before tagging (the release job would wait too, but a failing build is better caught now). Don't tag a commit whose CI failed.

## 2. Tag and push, after the user confirms

Pushing the tag publishes a public GitHub release, and every installed Sush offers it as an update. Show the user the commit (`git log -1 <sha>`), the version and the notes, and push only after they say yes:

```sh
git tag v<version> <sha>
git push origin v<version>
```

Then follow it: `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')`. It should finish in about a minute (longer only if it had to wait for or start a build). Check `https://github.com/surajS0106/sush/releases/latest/download/latest.json` shows the new version.

## 3. Move main to the next version

One commit, `Start v<next>`:

- The version, in all of: `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` (`[workspace.package] version`), `apps/desktop/package.json`, `apps/server/package.json`, `apps/viewer/package.json`, and the `sush` and `sush-core` entries in `Cargo.lock` (edit those two `version =` lines; don't run a cargo command that upgrades other dependencies). Confirm with `git grep -n '"<released-version>"' -- '*.json' Cargo.toml Cargo.lock` (only unrelated packages should remain).
- The notes: move `UNRELEASED` and `UNRELEASED_SUMMARY` into a new entry at the top of `RELEASED` (`version` the released one, `date` the release date, `summary`), then empty both.

```sh
git commit -am "Start v<next>"
git push origin main
```

This push builds the next version's installers like any other.

## If something goes wrong

- The release job says the tag doesn't match the app version: the tagged commit carries another version. Delete the tag (`git push origin :refs/tags/v<version>` and `git tag -d v<version>`) and tag the right commit.
- The build it used or started failed: fix it on main, then tag the new commit (delete the old tag first). A failed release job leaves no published release, so the update feed keeps serving the previous one.
- Rerunning the release job is safe: it replaces the files on the existing release and publishes it.
