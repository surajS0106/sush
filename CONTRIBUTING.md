# Contributing to Sush

Thanks for helping out. Bug reports, fixes and features are all welcome.

## Reporting a bug

Open an issue with your OS, the Sush version (the release you installed, or the commit you built), what you did, what you expected, and what happened. Logs are in the app's log directory (`auth-server.log` among them). Leave out API keys and anything else private.

Report security vulnerabilities privately through GitHub's "Report a vulnerability" button on the Security tab, not in a public issue.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Set up the prerequisites and run the app as described in the [README](README.md).
3. Keep the change focused. [CLAUDE.md](CLAUDE.md) describes the architecture and conventions; in short:
   - `crates/sush-core` stays free of any Tauri dependency.
   - If you change a Tauri command or a serde type, update `apps/desktop/src/lib/tauri.ts` to match.
   - A new endpoint that speaks the OpenAI or Anthropic format needs only a preset in `provider.rs`, no new code.
4. Before opening a pull request, run what CI runs:

   ```sh
   bun run typecheck
   bun --filter desktop build
   cargo test --workspace
   ```

5. Open a pull request that says what changed and why. Include a screenshot for UI changes.

## Secrets

Never commit API keys, tokens or `.env` files (`.env*` is gitignored). The app keeps keys in the OS keyring; tests use fakes.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
