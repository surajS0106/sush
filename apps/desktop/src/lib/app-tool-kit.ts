// Types and helpers shared by the app's feature toolsets (`app-tools.ts`). Kept apart
// from the registry so the toolsets can import them without an import cycle.

import type { ToolSpec } from "@/lib/tauri";

export type ToolResult = { output: unknown } | { errorText: string };
export type Args = Record<string, unknown>;

/** What a tool call knows about where it was made. */
export interface ToolContext {
  /** The chat the call is in, when known. */
  threadId?: string;
}

/** What a write will do, for its approval card. */
export interface AppPlan {
  /** A question, e.g. "Pause “Daily briefing”?" */
  title: string;
  /** What changes, one row per field. */
  rows: { label: string; value: string; before?: string }[];
  /** Longer text shown under the rows (a prompt, a note's text). */
  body?: string;
  confirm: string;
  destructive?: boolean;
  apply: () => Promise<ToolResult> | ToolResult;
}

export type PlanResult = AppPlan | { error: string };

export interface AppToolset {
  id: "automations" | "projects" | "binders" | "reports";
  /** For the card's lines: "your automations", "your projects". */
  noun: string;
  specs: ToolSpec[];
  /** Tools that only read: they run without asking. */
  reads: ReadonlySet<string>;
  read: (name: string, args: Args, ctx: ToolContext) => Promise<ToolResult>;
  plan: (name: string, args: Args, ctx: ToolContext) => Promise<PlanResult>;
}

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** An item by id, or by an exact (any case) name; tells the model how to fix a miss. */
export function findBy<T extends { id: string }>(
  items: T[],
  ref: string | undefined,
  nameOf: (t: T) => string,
  what: string,
  listTool: string,
): { ok: true; item: T } | { ok: false; error: string } {
  if (!ref) return { ok: false, error: `Say which ${what}: its id or exact name from ${listTool}.` };
  const byId = items.find((t) => t.id === ref);
  if (byId) return { ok: true, item: byId };
  const named = items.filter((t) => nameOf(t).toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return { ok: true, item: named[0] };
  if (named.length > 1) return { ok: false, error: `Several ${what}s are called "${ref}". Pass the id from ${listTool}.` };
  const names = items.map(nameOf).slice(0, 20);
  return { ok: false, error: `No ${what} "${ref}". ${names.length ? `There are: ${names.map((n) => `"${n}"`).join(", ")}.` : `There are none yet.`}` };
}
