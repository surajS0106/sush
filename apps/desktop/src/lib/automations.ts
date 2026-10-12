// Automations: a saved prompt that Sush runs on a schedule, or whenever the
// user asks. Each run is an ordinary session (a chat, or Cowork in the
// automation's folder) titled after the automation, so it streams, waits for
// approvals and is saved like any other. The schedule is kept here in the UI,
// like the library, so automations only run while the app is open; a run
// missed while it was closed happens once on the next launch.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { WEEKDAYS, type Schedule } from "@/lib/automation-save";
import { library, requestChat } from "@/lib/library";
import { sendMessage } from "@/lib/sessions";
import { createConversation, createStore, getConversations, getTarget } from "@/lib/store";
import { getWorkspaces } from "@/lib/workspaces";

export { DEFAULT_SCHEDULE, WEEKDAYS, type Frequency, type Schedule } from "@/lib/automation-save";

export interface AutomationRun {
  threadId: string;
  at: number;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  /** Runs as a Cowork session in this folder; otherwise as a chat. */
  workspaceId?: string;
  enabled: boolean;
  createdAt: number;
  /** When the schedule last changed or was resumed; runs due before it don't count as missed. */
  scheduledFrom: number;
  lastRunAt?: number;
  /** Newest first. */
  runs: AutomationRun[];
  /** A run started since the user last looked. */
  unseen?: boolean;
}

export type AutomationDraft = Pick<Automation, "name" | "prompt" | "schedule" | "workspaceId" | "enabled">;

/** Runs kept per automation; older sessions stay in the sidebar. */
const RUNS_KEPT = 20;

const automations = createStore<Automation[]>("sush.automations", []);

export const useAutomations = () => useSyncExternalStore(automations.subscribe, automations.get);
export const getAutomations = () => automations.get();

/** The automation a session was started by, if any. */
export function automationForThread(list: Automation[], threadId: string): Automation | undefined {
  return list.find((a) => a.runs.some((r) => r.threadId === threadId));
}

export function createAutomation(draft: AutomationDraft): Automation {
  const now = Date.now();
  const a: Automation = { ...draft, id: crypto.randomUUID(), createdAt: now, scheduledFrom: now, runs: [] };
  automations.set((all) => [a, ...all]);
  return a;
}

export function updateAutomation(id: string, patch: Partial<AutomationDraft>) {
  automations.set((all) =>
    all.map((a) => {
      if (a.id !== id) return a;
      const next = { ...a, ...patch };
      // A new schedule, or turning it back on, starts counting from now.
      const rescheduled = (patch.schedule && !sameSchedule(patch.schedule, a.schedule)) || (patch.enabled && !a.enabled);
      return rescheduled ? { ...next, scheduledFrom: Date.now() } : next;
    }),
  );
}

export function deleteAutomation(id: string) {
  automations.set((all) => all.filter((a) => a.id !== id));
}

export function markSeen(id: string) {
  if (automations.get().find((a) => a.id === id)?.unseen) {
    automations.set((all) => all.map((a) => (a.id === id ? { ...a, unseen: false } : a)));
  }
}

const sameSchedule = (a: Schedule, b: Schedule) => a.frequency === b.frequency && a.time === b.time && a.day === b.day;

// --- running ---------------------------------------------------------------------

/** Start a run now: a new session with the automation's prompt. Returns the session's id, or null if it couldn't start. */
export function runAutomation(id: string): string | null {
  const a = automations.get().find((a) => a.id === id);
  if (!a) return null;
  // A failed attempt still uses up this slot, so the scheduler doesn't retry it every tick.
  const fail = (description: string) => {
    toast.error(`“${a.name}” didn’t run`, { description });
    automations.set((all) => all.map((x) => (x.id === id ? { ...x, lastRunAt: Date.now() } : x)));
    return null;
  };
  if (a.workspaceId && !getWorkspaces().some((w) => w.id === a.workspaceId)) {
    return fail("Its folder was removed. Pick another one in the automation.");
  }
  // A new session's model is the default one.
  if (!getTarget()) return fail("Pick a model first. Add a provider in Settings if the list is empty.");
  const convo = createConversation(a.workspaceId, a.name);
  sendMessage(convo.id, a.prompt, []);
  const run = { threadId: convo.id, at: Date.now() };
  automations.set((all) =>
    all.map((x) => (x.id === id ? { ...x, lastRunAt: run.at, unseen: true, runs: [run, ...x.runs].slice(0, RUNS_KEPT) } : x)),
  );
  return convo.id;
}

/** Runs still listed in the sidebar, newest first. */
export function liveRuns(a: Automation): AutomationRun[] {
  const ids = new Set(getConversations().map((c) => c.id));
  return a.runs.filter((r) => ids.has(r.threadId));
}

// --- schedule ----------------------------------------------------------------------

const parseTime = (time: string): [number, number] => {
  const [h, m] = time.split(":").map(Number);
  return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0];
};

/** The first time the schedule fires strictly after `after`, or null for manual. */
export function nextRun(s: Schedule, after: number): Date | null {
  if (s.frequency === "manual") return null;
  const from = new Date(after);
  if (s.frequency === "hourly") {
    const d = new Date(from);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }
  const [h, m] = parseTime(s.time);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m);
    if (d.getTime() <= after) continue;
    const day = d.getDay();
    if (s.frequency === "weekdays" && (day === 0 || day === 6)) continue;
    if (s.frequency === "weekly" && day !== s.day) continue;
    return d;
  }
  return null;
}

/** When an enabled automation runs next. */
export function nextRunOf(a: Automation): Date | null {
  return a.enabled ? nextRun(a.schedule, Math.max(Date.now(), a.lastRunAt ?? 0)) : null;
}

/** A run that came due since the last one (or since the schedule was set). */
function isDue(a: Automation, now: number): boolean {
  if (!a.enabled) return false;
  const due = nextRun(a.schedule, Math.max(a.lastRunAt ?? 0, a.scheduledFrom));
  return !!due && due.getTime() <= now;
}

/** The longest the scheduler sleeps, in case the clock jumps (sleep, time zone change). */
const CHECK_EVERY_MS = 30_000;
/** Connectors start with the app; wait this long for them before running anyway. */
const CONNECTOR_GRACE_MS = 2 * 60_000;

/** A session App should open, e.g. from a run's "Open" toast. `at` tells repeat requests apart. */
const openRequest = createStore<{ threadId: string; at: number } | null>("sush.automations.open", null, false);
export const useOpenRunRequest = () => useSyncExternalStore(openRequest.subscribe, openRequest.get);

let started = false;

/**
 * Run automations as they come due while the app is open. It sleeps until the next one is due
 * (at most half a minute) and wakes again whenever automations change. Safe to call more than once.
 */
export function startScheduler() {
  if (started) return;
  started = true;
  const since = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    const connecting = Object.values(library.connectorStatus()).some((s) => s.state === "connecting");
    if (!connecting || Date.now() - since >= CONNECTOR_GRACE_MS) {
      const now = Date.now();
      for (const a of automations.get()) {
        if (!isDue(a, now)) continue;
        const threadId = runAutomation(a.id);
        if (threadId) {
          toast(`Running “${a.name}”`, {
            description: describeSchedule(a.schedule),
            action: { label: "Open", onClick: () => openRequest.set({ threadId, at: Date.now() }) },
          });
        }
      }
    }
    sleep();
  };

  const sleep = () => {
    clearTimeout(timer);
    const now = Date.now();
    let wait = CHECK_EVERY_MS;
    for (const a of automations.get()) {
      if (!a.enabled) continue;
      const due = nextRun(a.schedule, Math.max(a.lastRunAt ?? 0, a.scheduledFrom));
      if (due) wait = Math.min(wait, due.getTime() - now);
    }
    // Something already due (e.g. waiting on connectors) is retried shortly, not in a busy loop.
    timer = setTimeout(tick, Math.max(wait, 1_000));
  };

  automations.subscribe(sleep);
  timer = setTimeout(tick, 1_000);
}

// --- labels --------------------------------------------------------------------------

export function formatTime(time: string): string {
  const [h, m] = parseTime(time);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Daily at 8:00 AM", "Every Friday at 4:00 PM", … */
export function describeSchedule(s: Schedule): string {
  switch (s.frequency) {
    case "manual":
      return "Run manually";
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${formatTime(s.time)}`;
    case "weekdays":
      return `Weekdays at ${formatTime(s.time)}`;
    case "weekly":
      return `Every ${WEEKDAYS[s.day]} at ${formatTime(s.time)}`;
  }
}

/** "Today at 8:00 AM", "Tomorrow at …", "Fri, Oct 17 at …". */
export function formatWhen(d: Date, now = new Date()): string {
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

// --- templates ---------------------------------------------------------------------

export type TemplateIcon = "sunrise" | "inbox" | "calendar" | "list-checks" | "lightbulb" | "binoculars";

export interface AutomationTemplate {
  name: string;
  description: string;
  icon: TemplateIcon;
  prompt: string;
  schedule: Schedule;
}

export const TEMPLATES: AutomationTemplate[] = [
  {
    name: "Daily briefing",
    description: "What needs your attention today across calendar, email, and messages.",
    icon: "sunrise",
    schedule: { frequency: "weekdays", time: "08:00", day: 1 },
    prompt:
      "Give me a short briefing for today. Using my connected tools, check my calendar, email and messages, " +
      "and list what needs my attention: meetings to prepare for, replies I owe, and deadlines. Lead with the most urgent.",
  },
  {
    name: "Inbox triage",
    description: "Categorize your inbox and draft replies to anything urgent.",
    icon: "inbox",
    schedule: { frequency: "weekdays", time: "08:00", day: 1 },
    prompt:
      "Triage my unread email from the last day. Group it into Urgent, Needs a reply, FYI and Can ignore. " +
      "For anything urgent, draft a reply for me to review. Don't send anything.",
  },
  {
    name: "Meeting prep",
    description: "A short brief before each meeting on your calendar, covering attendees, context, and agenda.",
    icon: "calendar",
    schedule: { frequency: "weekdays", time: "08:00", day: 1 },
    prompt:
      "Look at today's meetings on my calendar. For each one, write a short brief: who's attending, " +
      "relevant context from recent email or past chats, and a suggested agenda.",
  },
  {
    name: "Weekly review",
    description: "A Friday summary of what happened this week.",
    icon: "list-checks",
    schedule: { frequency: "weekly", time: "16:00", day: 5 },
    prompt:
      "Summarize my week: what got done, what's still open, and what's coming up next week. " +
      "Use my past chats and connected tools. End with three priorities for Monday.",
  },
  {
    name: "Content ideas",
    description: "Draft a few post ideas each week from the latest news in your industry.",
    icon: "lightbulb",
    schedule: { frequency: "weekly", time: "09:00", day: 1 },
    prompt:
      "Find this week's most interesting news in my industry and draft five post ideas from it, " +
      "each with a hook and two or three key points.",
  },
  {
    name: "Monitor a topic",
    description: "Watch for news or mentions of a topic, competitor, or keyword.",
    icon: "binoculars",
    schedule: { frequency: "daily", time: "09:00", day: 1 },
    prompt: "Search the web for news and mentions of [topic] from the last day. Summarize anything new and link the sources.",
  },
];

/** Open a new chat ready for `/create-automation`. */
export const createAutomationInChat = () => requestChat("/create-automation ");
