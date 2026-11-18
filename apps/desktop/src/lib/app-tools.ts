// Model tools for the app's own features: Automations, Projects, Binders and
// Reports (Security, Review, Wiki). Each feature is a toolset with:
//
//   reads   run at once (`runTool` in `agent.ts`): lists, searches, reading a report
//   writes  planned first: the plan says what will change, and `components/app-tool-part.tsx`
//           shows it as a card to approve (in Auto mode it's applied without one)
//
// All of them are deferred (listed in the system prompt, loaded when needed), not offered
// in incognito chats, and private in shared sessions (`share/redact.rs`). The Board and the
// CRM have their own modules (`board-tools.ts`, `crm-tools.ts`) with richer cards.

import { automationToolset } from "@/lib/automation-tools";
import { binderToolset } from "@/lib/binder-tools";
import { projectToolset } from "@/lib/project-tools";
import { reportToolset } from "@/lib/report-tools";
import type { AppToolset, Args, ToolContext, ToolResult } from "@/lib/app-tool-kit";

export type { AppPlan, ToolContext } from "@/lib/app-tool-kit";

export const APP_TOOLSETS: AppToolset[] = [automationToolset, projectToolset, binderToolset, reportToolset];

const byName = new Map(APP_TOOLSETS.flatMap((t) => t.specs.map((s) => [s.name, t] as const)));

export const appToolset = (name: string) => byName.get(name);
export const APP_TOOL_NAMES: ReadonlySet<string> = new Set(byName.keys());
export const appToolSpecs = () => APP_TOOLSETS.flatMap((t) => t.specs);
export const isAppRead = (name: string) => !!byName.get(name)?.reads.has(name);

/** Run an app tool unasked: reads always, writes in Auto mode. Never throws. */
export async function runAppTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const set = byName.get(name);
  if (!set) return { errorText: `Unknown tool ${name}.` };
  try {
    if (set.reads.has(name)) return await set.read(name, args, ctx);
    const plan = await set.plan(name, args, ctx);
    return "error" in plan ? { errorText: plan.error } : await plan.apply();
  } catch (e) {
    return { errorText: e instanceof Error ? e.message : String(e) };
  }
}
