// The model's tools for the user's Automations (`lib/automations.ts`). Saving a new
// one stays `automation_save` (its own card); these list and manage the saved ones.
//
//   automation_list    runs at once: every automation with its schedule and next run
//   automation_manage  pause, resume, run now, change or delete one; asks with a card

import type { AppToolset, Args, PlanResult, ToolContext, ToolResult } from "@/lib/app-tool-kit";
import { clip, findBy, str } from "@/lib/app-tool-kit";
import { parseSchedule, WEEKDAYS, weeklyDays, type Schedule } from "@/lib/automation-save";
import {
  deleteAutomation,
  describeSchedule,
  formatWhen,
  getAutomations,
  nextRunOf,
  runAutomation,
  updateAutomation,
  type Automation,
} from "@/lib/automations";
import type { ToolSpec } from "@/lib/tauri";
import { getWorkspaces } from "@/lib/workspaces";

export const AUTOMATION_LIST = "automation_list";
export const AUTOMATION_MANAGE = "automation_manage";

const ACTIONS = ["pause", "resume", "run", "update", "delete"] as const;
type Action = (typeof ACTIONS)[number];

const listTool: ToolSpec = {
  name: AUTOMATION_LIST,
  description:
    "List the user's automations in Sush: prompts that run on a schedule, each in a new session. Use it when they ask what's " +
    "scheduled or automated, and to find an automation before changing it with automation_manage.",
  inputSchema: { type: "object", properties: {} },
};

const manageTool: ToolSpec = {
  name: AUTOMATION_MANAGE,
  description:
    "Pause, resume, run now, change or delete one of the user's saved automations. To make a new automation use automation_save. " +
    "For update, pass only what changes (name, prompt, or the schedule as frequency, time and days). The user approves each change.",
  inputSchema: {
    type: "object",
    properties: {
      automation: { type: "string", description: "Its id or exact name from automation_list." },
      action: { type: "string", enum: [...ACTIONS] },
      name: { type: "string" },
      prompt: { type: "string", description: "The full new prompt; it replaces the old one." },
      frequency: { type: "string", enum: ["manual", "hourly", "daily", "weekdays", "weekly"] },
      time: { type: "string", description: "HH:MM, 24-hour." },
      days: { type: "array", items: { type: "string", enum: WEEKDAYS.map((d) => d.toLowerCase()) } },
    },
    required: ["automation", "action"],
  },
};

const folderName = (id: string | undefined) => (id ? getWorkspaces().find((w) => w.id === id)?.name : undefined);

function brief(a: Automation) {
  const next = a.enabled ? nextRunOf(a) : null;
  return {
    id: a.id,
    name: a.name,
    schedule: describeSchedule(a.schedule),
    enabled: a.enabled,
    ...(next ? { nextRun: formatWhen(next) } : {}),
    ...(a.lastRunAt ? { lastRun: formatWhen(new Date(a.lastRunAt)) } : {}),
    ...(folderName(a.workspaceId) ? { folder: folderName(a.workspaceId) } : {}),
    ...(a.workflowId ? { startsWorkflow: true } : {}),
    prompt: clip(a.prompt, 400),
  };
}

async function read(_name: string): Promise<ToolResult> {
  const all = getAutomations();
  return {
    output: JSON.stringify({
      automations: all.map(brief),
      ...(all.length === 0 ? { note: "No automations yet. Make one with automation_save." } : {}),
    }),
  };
}

/** The new schedule an update asks for, keeping what it doesn't mention. */
function nextSchedule(args: Args, current: Schedule): Schedule | string | undefined {
  if (args.frequency === undefined && args.time === undefined && args.days === undefined) return undefined;
  const frequency = str(args.frequency) ?? current.frequency;
  return parseSchedule({
    frequency,
    time: args.time ?? (frequency === "manual" || frequency === "hourly" ? undefined : current.time),
    // Days carry over only when the frequency stays weekly.
    days: args.days ?? (args.frequency === undefined && current.frequency === "weekly" ? weeklyDays(current).map((d) => WEEKDAYS[d]) : undefined),
  });
}

async function plan(_name: string, args: Args, _ctx: ToolContext): Promise<PlanResult> {
  const found = findBy(getAutomations(), str(args.automation), (a) => a.name, "automation", AUTOMATION_LIST);
  if (!found.ok) return { error: found.error };
  const a = found.item;
  const action = str(args.action) as Action;
  if (!ACTIONS.includes(action)) return { error: `action must be one of ${ACTIONS.join(", ")}.` };
  const quoted = `“${a.name}”`;

  if (action === "pause" || action === "resume") {
    const enabled = action === "resume";
    if (a.enabled === enabled) return { error: `${quoted} is already ${enabled ? "on" : "paused"}.` };
    return {
      title: `${enabled ? "Resume" : "Pause"} ${quoted}?`,
      rows: [{ label: "Schedule", value: describeSchedule(a.schedule) }],
      confirm: enabled ? "Resume" : "Pause",
      apply: () => {
        updateAutomation(a.id, { enabled });
        return { output: `${enabled ? "Resumed" : "Paused"} ${quoted}.` };
      },
    };
  }
  if (action === "run") {
    return {
      title: `Run ${quoted} now?`,
      rows: [{ label: "Runs as", value: a.workflowId ? "Its workflow" : folderName(a.workspaceId) ? `Cowork in ${folderName(a.workspaceId)}` : "A new chat" }],
      body: a.prompt,
      confirm: "Run now",
      apply: () => {
        const thread = runAutomation(a.id);
        return thread || a.workflowId
          ? { output: `Started ${quoted}. Its run is a new session in the sidebar${a.workflowId ? " (on the Workflows page, since it starts a workflow)" : ""}.` }
          : { errorText: `${quoted} couldn't start; the app showed the user why.` };
      },
    };
  }
  if (action === "delete") {
    return {
      title: `Delete ${quoted}?`,
      rows: [{ label: "Schedule", value: describeSchedule(a.schedule) }],
      body: "Its past runs stay in the sidebar.",
      confirm: "Delete",
      destructive: true,
      apply: () => {
        deleteAutomation(a.id);
        return { output: `Deleted ${quoted}.` };
      },
    };
  }

  // update
  const rows: { label: string; value: string; before?: string }[] = [];
  const patch: Partial<Pick<Automation, "name" | "prompt" | "schedule">> = {};
  const name = str(args.name);
  if (name && name !== a.name) {
    patch.name = name;
    rows.push({ label: "Name", before: a.name, value: name });
  }
  const prompt = str(args.prompt);
  if (prompt && prompt !== a.prompt) patch.prompt = prompt;
  const schedule = nextSchedule(args, a.schedule);
  if (typeof schedule === "string") return { error: `Not changed: ${schedule}.` };
  if (schedule && describeSchedule(schedule) !== describeSchedule(a.schedule)) {
    patch.schedule = schedule;
    rows.push({ label: "Schedule", before: describeSchedule(a.schedule), value: describeSchedule(schedule) });
  }
  if (patch.prompt) rows.push({ label: "Prompt", value: "Replaced (below)" });
  if (Object.keys(patch).length === 0) return { error: `Nothing would change: pass a new name, prompt or schedule for ${quoted}.` };
  return {
    title: `Change ${quoted}?`,
    rows,
    body: patch.prompt,
    confirm: "Save",
    apply: () => {
      updateAutomation(a.id, patch);
      const updated = getAutomations().find((x) => x.id === a.id);
      const next = updated?.enabled ? nextRunOf(updated) : null;
      return { output: `Updated ${quoted}.${next ? ` Next run: ${formatWhen(next)}.` : ""}` };
    },
  };
}

export const automationToolset: AppToolset = {
  id: "automations",
  noun: "your automations",
  specs: [listTool, manageTool],
  reads: new Set([AUTOMATION_LIST]),
  read,
  plan,
};
