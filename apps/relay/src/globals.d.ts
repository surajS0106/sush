// With `nodejs_compat`, Workers fill `process.env` from the vars and secrets
// (`apps/server/src/share/common.ts` and `plans.ts` read their settings there).
declare const process: { env: Record<string, string | undefined> };
