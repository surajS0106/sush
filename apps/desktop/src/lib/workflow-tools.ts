// The model's workflow tools, so a chat can start a workflow ("run my call
// brief for Northwind"):
//
//   workflow_list  runs at once: the workflows and how each starts
//   workflow_run   starts one whose trigger is "Run by hand" or "Asked in chat";
//                  asks first (it may change things), unless the user picked Auto
//
// The engine is loaded when a run starts, so `agent.ts` doesn't import it.

import { defOf, getWorkflows, isTrigger } from "@/lib/workflows";
import type { ToolSpec } from "@/lib/tauri";

export const WORKFLOW_LIST = "workflow_list";
export const WORKFLOW_RUN = "workflow_run";
export const WORKFLOW_TOOL_NAMES = new Set([WORKFLOW_LIST, WORKFLOW_RUN]);

export const workflowListTool: ToolSpec = {
  name: WORKFLOW_LIST,
  description: "List the user's workflows in Sush (automated steps they built), with how each starts and whether it's on.",
  inputSchema: { type: "object", properties: {} },
};

export const workflowRunTool: ToolSpec = {
  name: WORKFLOW_RUN,
  description:
    "Start one of the user's workflows by name, with input it reads as {{trigger.input}}. Only workflows that start by hand or from a chat " +
    "can be started this way; check with workflow_list. The user approves the start. It runs on its own; its steps show on the Workflows page.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, input: { type: "string", description: "What the workflow should work on." } },
    required: ["name"],
  },
};

type Result = { output: unknown } | { errorText: string };

export function listWorkflows(): Result {
  const all = getWorkflows();
  if (all.length === 0) return { output: "The user has no workflows yet. They make them on the Workflows page." };
  return {
    output: JSON.stringify(
      all.map((w) => {
        const t = (w.live ?? w).nodes.find(isTrigger);
        return {
          name: w.name,
          startsWhen: t ? defOf(t.type).label : "no trigger",
          canStartFromChat: !!t && ["manual", "chat", "automation"].includes(t.type),
          on: w.enabled,
          published: !!w.live,
          about: w.description || undefined,
        };
      }),
    ),
  };
}

export async function startFromChat(args: Record<string, unknown>): Promise<Result> {
  const name = typeof args.name === "string" ? args.name : "";
  if (!name.trim()) return { errorText: "workflow_run needs the workflow's `name`." };
  const { runByName } = await import("@/lib/workflow-engine");
  const r = runByName(name, typeof args.input === "string" ? args.input : "", "chat");
  return r.ok ? { output: `Started “${r.name}”. It runs on its own; its steps show on the Workflows page.` } : { errorText: r.error };
}

export async function runWorkflowTool(name: string, args: Record<string, unknown>): Promise<Result> {
  if (name === WORKFLOW_LIST) return listWorkflows();
  if (name === WORKFLOW_RUN) return startFromChat(args);
  return { errorText: `Unknown workflow tool ${name}.` };
}
