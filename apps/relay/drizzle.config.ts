// drizzle-kit generates the D1 migrations from `src/schema.ts`; wrangler applies
// them (`wrangler.jsonc` → `migrations_dir`).

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
