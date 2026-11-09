// What the model sees of automations: the `/create-automation` instructions and
// the `automation_save` tool, which the user approves in its card (tool-parts.tsx).
// Kept free of app imports so skills.ts and agent.ts can load it without a cycle.

import type { ToolSpec } from "@/lib/tauri";

export type Frequency = "manual" | "hourly" | "daily" | "weekdays" | "weekly";

const FREQUENCIES: Frequency[] = ["manual", "hourly", "daily", "weekdays", "weekly"];

export interface Schedule {
  frequency: Frequency;
  /** "HH:MM", 24-hour, local time. Ignored for manual and hourly. */
  time: string;
  /** 0 (Sunday) to 6, for weekly. The first of `days` when there are several. */
  day: number;
  /** For weekly: every day it runs, 0 (Sunday) to 6. Missing on older automations, which run on `day` only. */
  days?: number[];
}

export const DEFAULT_SCHEDULE: Schedule = { frequency: "daily", time: "09:00", day: 1 };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The days a weekly schedule runs on, in week order. */
export const weeklyDays = (s: Schedule): number[] => (s.days?.length ? [...new Set(s.days)].sort((a, b) => a - b) : [s.day]);

export const AUTOMATION_SAVE = "automation_save";

export const CREATE_AUTOMATION_INSTRUCTIONS = `Help the user set up an automation: a prompt that Sush runs on a schedule, each time in a new session, while the app is open.

1. Work out what should happen and when. If they've only given a rough idea, ask at most a few focused questions (using ask_user when it's available): what to check or produce, which tools or sources to use, and how often.
2. Write the prompt as a standalone request to yourself. Each run starts fresh with no memory of this chat, so include every detail it needs: sources, criteria, the format of the result. Runs happen unattended, so don't plan on asking the user questions; tools that act outside the app will still wait for their approval.
3. Call automation_save with a short name, the prompt and the schedule: \`frequency\` is one of manual, hourly, daily, weekdays or weekly; \`time\` is HH:MM, 24-hour; a weekly one lists its \`days\`, as many as it needs (Monday and Tuesday at 11 AM is frequency "weekly", days ["monday", "tuesday"], time "11:00"). The user reviews it before it's saved.
4. Once saved, tell them where to find it (Automations in the sidebar) and when it runs next.`;

const DAY_NAMES = WEEKDAYS.map((d) => d.toLowerCase());

export const automationSaveTool: ToolSpec = {
  name: AUTOMATION_SAVE,
  description:
    "Save an automation: a prompt Sush runs on a schedule, each run in a new session. The user reviews it before it's saved. " +
    "Use it when running /create-automation or when the user asks for something to happen regularly (daily, every Monday, …). " +
    'Example: Monday and Tuesday at 11 AM is {"frequency": "weekly", "days": ["monday", "tuesday"], "time": "11:00"}.',
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short title, e.g. 'Daily briefing'" },
      prompt: { type: "string", description: "The full, standalone request each run sends" },
      frequency: { type: "string", enum: FREQUENCIES },
      time: { type: "string", description: "Local time as HH:MM (24-hour). Required for daily, weekdays and weekly" },
      days: {
        type: "array",
        items: { type: "string", enum: DAY_NAMES },
        description: "For weekly: every day of the week it runs, e.g. [\"monday\", \"tuesday\"]",
      },
    },
    required: ["name", "prompt", "frequency"],
  },
};

export interface AutomationSaveInput {
  name: string;
  prompt: string;
  schedule: Schedule;
}

export type AutomationSaveResult = { ok: true; value: AutomationSaveInput } | { ok: false; error: string };

const EXAMPLE =
  'Call automation_save again with the fields fixed, e.g. {"name": "…", "prompt": "…", "frequency": "weekly", "days": ["monday", "tuesday"], "time": "11:00"}.';

/**
 * Reads the model's input leniently (a time inside `frequency`, a `schedule` string, a cron line,
 * "11 am", day names anywhere), and otherwise says exactly what's wrong so the model can fix it.
 */
export function parseAutomationSave(input: unknown): AutomationSaveResult {
  const i = (input ?? {}) as Record<string, unknown>;
  const name = str(i.name);
  const prompt = str(i.prompt);
  const problems: string[] = [];
  if (!name) problems.push("`name` is missing");
  if (!prompt) problems.push("`prompt` is missing");
  const schedule = parseSchedule(i);
  if (typeof schedule === "string") problems.push(schedule);
  if (problems.length || typeof schedule === "string") {
    return { ok: false, error: `Not saved: ${problems.join("; ")}. ${EXAMPLE}` };
  }
  return { ok: true, value: { name, prompt, schedule } };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const pad = (n: number) => String(n).padStart(2, "0");

// "mon", "monday", "mondays", "tues", "thurs", …
const DAY_RE = /\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday|s|r|rs)?s?\b/g;
const DAY_PREFIXES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function dayNames(text: string): number[] {
  return [...text.toLowerCase().matchAll(DAY_RE)].map((m) => DAY_PREFIXES.indexOf(m[1]));
}

/** Days from a `days`/`day` field: names, a list of names, or numbers 0–6. */
function daysField(v: unknown): number[] {
  if (Array.isArray(v)) return v.flatMap(daysField);
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 7 ? [v % 7] : [];
  return typeof v === "string" ? (/^\d$/.test(v.trim()) ? daysField(Number(v)) : dayNames(v)) : [];
}

/** "11:00", "11 am", "11:30 p.m.", "noon"; a bare "11" only when `bare` (an explicit time field). */
function parseTime(text: string, bare: boolean): string | null {
  const t = text.toLowerCase();
  if (/\bnoon\b/.test(t)) return "12:00";
  if (/\bmidnight\b/.test(t)) return "00:00";
  for (const m of t.matchAll(/(?<![\d:])(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/g)) {
    const [, hs, ms, ap] = m;
    if (!ms && !ap && !bare) continue;
    let h = Number(hs);
    const min = ms ? Number(ms) : 0;
    if (ap) {
      if (h < 1 || h > 12) continue;
      h = (h % 12) + (ap.startsWith("p") ? 12 : 0);
    }
    if (h > 23 || min > 59) continue;
    return `${pad(h)}:${pad(min)}`;
  }
  return null;
}

/** The day-of-week field of a cron line: "*", "1-5", "1,2", "mon,tue". */
function cronDays(field: string): number[] | null {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const out: number[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) out.push(d % 7);
    } else {
      const d = daysField(part);
      if (!d.length) return null;
      out.push(...d);
    }
  }
  return out;
}

function parseSchedule(i: Record<string, unknown>): Schedule | string {
  // Models also send the whole schedule as `schedule` or `cron`.
  const text = [i.frequency, i.schedule, i.cron, i.repeat].map(str).filter(Boolean).join(" ");
  if (!text) return '`frequency` is missing (one of manual, hourly, daily, weekdays, weekly)';
  const lower = text.toLowerCase();

  let frequency: Frequency | null = null;
  let days: number[] = [];
  let time: string | null = null;

  const cron = /^(?:cron:?\s*)?(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([\da-z,\-*]+)$/i.exec(text);
  if (cron) {
    const [m, h] = [Number(cron[1]), Number(cron[2])];
    const d = cronDays(cron[3].toLowerCase());
    if (m > 59 || h > 23 || !d) return `couldn't read the cron line "${text}"; use frequency, time and days instead`;
    time = `${pad(h)}:${pad(m)}`;
    days = d;
    frequency = "weekly";
  } else {
    days = dayNames(lower);
    if (/\bmanual/.test(lower)) frequency = "manual";
    else if (/\bhourly\b|\bevery hour\b/.test(lower)) frequency = "hourly";
    else if (/\bweekdays?\b|\bmon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?\b/.test(lower)) frequency = "weekdays";
    else if (days.length || /\bweekly\b|\bevery week\b/.test(lower)) frequency = "weekly";
    else if (/\bdaily\b|\bevery ?day\b/.test(lower)) frequency = "daily";
    time = parseTime(lower, false);
  }
  if (!frequency) return `\`frequency\` "${text}" isn't one of manual, hourly, daily, weekdays, weekly`;

  const timeField = str(i.time);
  if (timeField) {
    time = parseTime(timeField, true);
    if (!time) return `\`time\` "${timeField}" isn't a time; use HH:MM, 24-hour (e.g. "11:00")`;
  }
  const extra = [...daysField(i.days), ...daysField(i.day)];
  if (extra.length && frequency !== "weekdays") {
    days = cron ? days : [...days, ...extra];
    // A day list is more specific than "daily".
    if (frequency === "daily") frequency = "weekly";
  }

  if (frequency === "manual" || frequency === "hourly") return { frequency, time: time ?? DEFAULT_SCHEDULE.time, day: DEFAULT_SCHEDULE.day };

  if (frequency === "weekly") {
    days = [...new Set(days)].sort((a, b) => a - b);
    if (!days.length) return '`days` is missing: which days of the week does a weekly automation run? (e.g. ["monday"])';
    if (days.length === 7) frequency = "daily";
    else if (days.join() === "1,2,3,4,5") frequency = "weekdays";
  }
  if (!time) return `\`time\` is missing: when should it run? Pass HH:MM, 24-hour (e.g. "11:00")`;

  return frequency === "weekly"
    ? { frequency, time, day: days[0], days }
    : { frequency, time, day: DEFAULT_SCHEDULE.day };
}
