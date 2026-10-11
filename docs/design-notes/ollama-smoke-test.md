# Ollama smoke test — Design Notes

Last updated: 2026-10-11

## What changed

### 2026-10-11
- Added a standalone script that checks a local Ollama server: reachability, installed models, and a streamed chat reply (`test_ollama.py`).

## Why

`bun run dev` starts Ollama alongside the app, and local models are a preset provider. When chat fails, it is unclear whether the cause is Ollama or the app. The script checks Ollama directly, with no dependency on the Tauri or Rust build.

It uses only the Python standard library so it runs without a venv or `pip install`. The trade-off is hand-rolled NDJSON parsing instead of the `ollama` client package.

## What makes it stand out

- Zero third-party dependencies; `urllib` and `json` only.
- Fails at the earliest broken step with a specific message: server unreachable, no models pulled, or empty reply.
- Exits 0 on pass and 1 on failure, so it can be used in scripts.
- Streams the reply the same way the app consumes it (`/api/chat` with `stream: true`), so it exercises the streaming path.
- Model, prompt and host are overridable via arguments and `OLLAMA_HOST`; the model defaults to the first one installed.
