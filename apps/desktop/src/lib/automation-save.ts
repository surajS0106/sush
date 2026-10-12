// What the model sees of automations: the `/create-automation` instructions and
// the `automation_save` tool, which the user approves in its card (tool-parts.tsx).
// Kept free of app imports so skills.ts and agent.ts can load it without a cycle.

import type { ToolSpec } from "@/lib/tauri";

export type Frequency = "manual" | "hourly" | "daily" | "weekdays" | "weekly";

export interface Schedule {
  frequency: Frequency;
  /** "HH:MM", 24-hour, local time. Ignored for manual and hourly. */
  time: string;
  /** 0 (Sunday) to 6, for weekly. */
  day: number;
}

export const DEFAULT_SCHEDULE: Schedule = { frequency: "daily", time: "09:00", day: 1 };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const AUTOMATION_SAVE = "automation_save";

export const CREATE_AUTOMATION_INSTRUCTIONS = `Help the user set up an automation: a prompt that Sush runs on a schedule, each time in a new session, while the app is open.

1. Work out what should happen and when. If they've only given a rough idea, ask at most a few focused questions (using ask_user when it's available): what to check or produce, which tools or sources to use, and how often.
2. Write the prompt as a standalone request to yourself. Each run starts fresh with no memory of this chat, so include every detail it needs: sources, criteria, the format of the result. Runs happen unattended, so don't plan on asking the user questions; tools that act outside the app will still wait for their approval.
3. Call automation_save with a short name, the prompt and the schedule. The user reviews it before it's saved.
4. Once saved, tell them where to find it (Automations in the sidebar) and when it runs next.`;

export const automationSaveTool: ToolSpec = {
  name: AUTOMATION_SAVE,
  description:
    "Save an automation: a prompt Sush runs on a schedule, each run in a new session. The user reviews it before it's saved. " +
    "Use it when running /create-automation or when the user asks for something to happen regularly (daily, every Monday, …).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short title, e.g. 'Daily briefing'" },
      prompt: { type: "string", description: "The full, standalone request each run sends" },
      frequency: { type: "string", enum: ["manual", "hourly", "daily", "weekdays", "weekly"] },
      time: { type: "string", description: "Local time as HH:MM (24-hour), for daily, weekdays and weekly" },
      day: { type: "string", enum: WEEKDAYS.map((d) => d.toLowerCase()), description: "For weekly" },
    },
    required: ["name", "prompt", "frequency"],
  },
};

export interface AutomationSaveInput {
  name: string;
  prompt: string;
  schedule: Schedule;
}

export function parseAutomationSave(input: unknown): AutomationSaveInput | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = str(i.name);
  const prompt = str(i.prompt);
  const frequency = str(i.frequency) as Frequency;
  if (!name || !prompt || !["manual", "hourly", "daily", "weekdays", "weekly"].includes(frequency)) return null;
  const time = /^\d{1,2}:\d{2}$/.test(str(i.time)) ? str(i.time).padStart(5, "0") : DEFAULT_SCHEDULE.time;
  const day = WEEKDAYS.findIndex((d) => d.toLowerCase() === str(i.day).toLowerCase());
  return { name, prompt, schedule: { frequency, time, day: day < 0 ? DEFAULT_SCHEDULE.day : day } };
}
