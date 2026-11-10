// Workflows: steps on a canvas joined by connections, run when their trigger
// fires (a CRM change, a click, later mail, calendar and files) or by hand.
// Automations stay the place for schedules; an automation can start a workflow.
//
// Like automations, workflows live in the UI (localStorage, followed across
// windows) and run while the app is open, in the leader window (`whenLeader`)
// for triggers or in the window that pressed Test run. Their agent steps are
// ordinary threads kept out of the session list; `sessions.ts` gives each its
// step's instructions and, for a tool step, only that tool. The engine is in
// `workflow-engine.ts`.
//
// Editing changes the draft; "Publish" makes the draft what triggers run, so a
// live workflow never runs half an edit. Test runs use the draft.

import {
  BellIcon,
  BotIcon,
  CheckSquareIcon,
  ClockIcon,
  FlagIcon,
  GitForkIcon,
  MergeIcon,
  ContactIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HandIcon,
  KanbanSquareIcon,
  MailIcon,
  MessageSquareIcon,
  NotebookPenIcon,
  CalendarIcon,
  FileIcon,
  TimerIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useSyncExternalStore } from "react";

import { createStore, getTarget } from "@/lib/store";
import type { ModelTarget } from "@/lib/transport";

// --- model ---------------------------------------------------------------------------------

export type NodeGroup = "trigger" | "agent" | "tool" | "logic" | "action";

export type NodeType =
  // triggers
  | "manual"
  | "crm-event"
  | "chat"
  | "automation"
  | "email"
  | "calendar"
  | "file"
  // steps
  | "agent"
  | "tool"
  | "if"
  | "approval"
  | "delay"
  | "parallel"
  | "join"
  | "end"
  | "crm-update"
  | "crm-log"
  | "board-task"
  | "notify"
  | "cowork";

/** Each node type's settings, all optional strings or numbers so drafts are easy to keep. */
export type NodeConfig = Record<string, string | number | boolean | undefined>;

export interface WfNode {
  id: string;
  type: NodeType;
  /** What the step is called on the canvas, and its `{{key}}` in later steps. */
  label: string;
  /** Unique within the workflow: how later steps refer to this one's output. */
  key: string;
  x: number;
  y: number;
  config: NodeConfig;
}

/** Most nodes have one output; If and Approval have Yes and No. */
export type Port = "out" | "yes" | "no";

export interface WfEdge {
  id: string;
  from: string;
  port: Port;
  to: string;
}

export interface WfComment {
  id: string;
  x: number;
  y: number;
  text: string;
  author: string;
  resolved: boolean;
  createdAt: number;
}

export interface Graph {
  nodes: WfNode[];
  edges: WfEdge[];
}

export interface Workflow extends Graph {
  id: string;
  name: string;
  description: string;
  comments: WfComment[];
  /** Triggers fire only while on. */
  enabled: boolean;
  /** What triggers run: the draft as last published. */
  live?: Graph & { at: number };
  /** The model its AI steps use, unless a step picks its own; none means the default model. */
  model?: ModelTarget;
  createdAt: number;
  updatedAt: number;
}

// --- node catalog ------------------------------------------------------------------------------

export interface NodeDef {
  type: NodeType;
  group: NodeGroup;
  label: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  ports: Port[];
  defaults: NodeConfig;
}

export const NODE_DEFS: NodeDef[] = [
  {
    type: "manual",
    group: "trigger",
    label: "Run by hand",
    subtitle: "Manual",
    description: "Starts when you press Run, with optional input.",
    icon: HandIcon,
    ports: ["out"],
    defaults: { input: "" },
  },
  {
    type: "crm-event",
    group: "trigger",
    label: "CRM change",
    subtitle: "CRM",
    description: "Starts when a company, contact or deal is added, changed, moves stage or is deleted.",
    icon: ContactIcon,
    ports: ["out"],
    defaults: { event: "stage-changed", kind: "deal", toStage: "", field: "" },
  },
  {
    type: "chat",
    group: "trigger",
    label: "Asked in chat",
    subtitle: "Chat",
    description: "Starts when you ask Sush to run it in any chat.",
    icon: MessageSquareIcon,
    ports: ["out"],
    defaults: {},
  },
  {
    type: "automation",
    group: "trigger",
    label: "From an automation",
    subtitle: "Automation",
    description: "Starts when an automation runs it on its schedule.",
    icon: TimerIcon,
    ports: ["out"],
    defaults: {},
  },
  {
    type: "email",
    group: "trigger",
    label: "New email",
    subtitle: "Mail",
    description: "Starts when an email matching a search arrives (checked every few minutes through a mail connector).",
    icon: MailIcon,
    ports: ["out"],
    defaults: { tool: "", args: "", every: 10 },
  },
  {
    type: "calendar",
    group: "trigger",
    label: "Calendar event",
    subtitle: "Calendar",
    description: "Starts before a meeting begins or after it ends (through a calendar connector).",
    icon: CalendarIcon,
    ports: ["out"],
    defaults: { tool: "", args: "", when: "starting", minutes: 10, every: 5 },
  },
  {
    type: "file",
    group: "trigger",
    label: "File changed",
    subtitle: "Folder",
    description: "Starts when Sush, a command or you change files in one of your Cowork folders.",
    icon: FileIcon,
    ports: ["out"],
    defaults: { workspaceId: "" },
  },
  {
    type: "agent",
    group: "agent",
    label: "Agent",
    subtitle: "AI step",
    description: "Sush works on a task with your tools (web, connectors, CRM, a folder) and passes on its answer.",
    icon: BotIcon,
    ports: ["out"],
    defaults: { prompt: "", workspaceId: "", output: "text" },
  },
  {
    type: "tool",
    group: "tool",
    label: "Use a tool",
    subtitle: "Connector",
    description: "Calls one connector tool, with arguments written from earlier steps.",
    icon: WrenchIcon,
    ports: ["out"],
    defaults: { tool: "", args: "" },
  },
  {
    type: "if",
    group: "logic",
    label: "If",
    subtitle: "Branch",
    description: "Goes Yes or No on a condition, or on a question Sush answers.",
    icon: GitBranchIcon,
    ports: ["yes", "no"],
    defaults: { mode: "compare", left: "", op: "is", right: "", question: "" },
  },
  {
    type: "approval",
    group: "logic",
    label: "Ask me first",
    subtitle: "Approval",
    description: "Waits for you to approve before going on (Yes) or stops that path (No).",
    icon: CheckSquareIcon,
    ports: ["yes", "no"],
    defaults: { message: "" },
  },
  {
    type: "delay",
    group: "logic",
    label: "Wait",
    subtitle: "Delay",
    description: "Waits some minutes before going on (while Sush is open).",
    icon: ClockIcon,
    ports: ["out"],
    defaults: { minutes: 5 },
  },
  {
    type: "parallel",
    group: "logic",
    label: "Do at the same time",
    subtitle: "Parallel",
    description: "Splits into branches that run side by side. Connect it to each branch's first step.",
    icon: GitForkIcon,
    ports: ["out"],
    defaults: {},
  },
  {
    type: "join",
    group: "logic",
    label: "Wait for branches",
    subtitle: "Join",
    description: "Waits for the branches connected into it (all of them, or the first to finish), then goes on with all their answers.",
    icon: MergeIcon,
    ports: ["out"],
    defaults: { mode: "all" },
  },
  {
    type: "end",
    group: "logic",
    label: "End",
    subtitle: "Finish",
    description: "Finishes the run here: as done, or as failed with a message you write (it shows in the run and as a notification).",
    icon: FlagIcon,
    ports: [],
    defaults: { outcome: "done", message: "" },
  },
  {
    type: "crm-update",
    group: "action",
    label: "Update CRM record",
    subtitle: "CRM",
    description: "Changes a company, contact or deal: its stage, owner, value or a field.",
    icon: ContactIcon,
    ports: ["out"],
    defaults: { record: "{{trigger.record.id}}", stage: "", owner: "", value: "", field: "", fieldValue: "" },
  },
  {
    type: "crm-log",
    group: "action",
    label: "Log on CRM record",
    subtitle: "CRM",
    description: "Adds a note, call or summary to a record's activity.",
    icon: NotebookPenIcon,
    ports: ["out"],
    defaults: { record: "{{trigger.record.id}}", kind: "ai", body: "" },
  },
  {
    type: "board-task",
    group: "action",
    label: "Create a task",
    subtitle: "Board",
    description: "Adds a task to your Board.",
    icon: KanbanSquareIcon,
    ports: ["out"],
    defaults: { title: "", description: "", priority: "medium" },
  },
  {
    type: "notify",
    group: "action",
    label: "Notify me",
    subtitle: "Notification",
    description: "Shows a notification in Sush.",
    icon: BellIcon,
    ports: ["out"],
    defaults: { title: "", body: "" },
  },
  {
    type: "cowork",
    group: "action",
    label: "Start a session",
    subtitle: "Cowork",
    description: "Opens a session (in a folder, or a chat) with a prompt, listed in the sidebar.",
    icon: FolderOpenIcon,
    ports: ["out"],
    defaults: { workspaceId: "", prompt: "" },
  },
];

export const GROUPS: { id: NodeGroup; label: string }[] = [
  { id: "trigger", label: "Start" },
  { id: "agent", label: "AI" },
  { id: "tool", label: "Tools" },
  { id: "logic", label: "Flow" },
  { id: "action", label: "Actions" },
];

export const defOf = (type: NodeType): NodeDef => NODE_DEFS.find((d) => d.type === type)!;
export const isTrigger = (n: { type: NodeType }) => defOf(n.type).group === "trigger";

// --- store ---------------------------------------------------------------------------------

const workflows = createStore<Workflow[]>("sush.workflows", []);

export const useWorkflows = () => useSyncExternalStore(workflows.subscribe, workflows.get);
export const getWorkflows = () => workflows.get();
export const getWorkflow = (id: string) => workflows.get().find((w) => w.id === id);

const uid = () => crypto.randomUUID().slice(0, 8);

/** `Research the company` → `research_the_company`, unique among `taken`. */
export function keyFor(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "step";
  let key = base;
  for (let n = 2; used.has(key) || key === "trigger"; n++) key = `${base}_${n}`;
  return key;
}

export function newNode(type: NodeType, at: { x: number; y: number }, taken: WfNode[]): WfNode {
  const def = defOf(type);
  return {
    id: uid(),
    type,
    label: def.label,
    key: def.group === "trigger" ? "trigger" : keyFor(def.label, taken.map((n) => n.key)),
    x: Math.round(at.x),
    y: Math.round(at.y),
    config: { ...def.defaults },
  };
}

export function createWorkflow(name = "Untitled workflow", graph?: Graph): Workflow {
  const now = Date.now();
  const nodes = graph?.nodes ?? [newNode("manual", { x: 0, y: 0 }, [])];
  const w: Workflow = {
    id: crypto.randomUUID(),
    name,
    description: "",
    nodes,
    edges: graph?.edges ?? [],
    comments: [],
    enabled: false,
    createdAt: now,
    updatedAt: now,
  };
  workflows.set((all) => [w, ...all]);
  return w;
}

export function updateWorkflow(id: string, change: (w: Workflow) => Workflow) {
  workflows.set((all) => all.map((w) => (w.id === id ? { ...change(w), updatedAt: Date.now() } : w)));
}

/** Put a deleted workflow back as it was (Undo). */
export function restoreWorkflow(w: Workflow) {
  workflows.set((all) => (all.some((x) => x.id === w.id) ? all : [w, ...all]));
}

export function deleteWorkflow(id: string) {
  workflows.set((all) => all.filter((w) => w.id !== id));
}

export function duplicateWorkflow(id: string): Workflow | undefined {
  const w = getWorkflow(id);
  if (!w) return;
  return createWorkflow(`${w.name} copy`, structuredClone({ nodes: w.nodes, edges: w.edges }));
}

/** Make the draft what triggers run. */
export function publish(id: string) {
  updateWorkflow(id, (w) => ({ ...w, live: { nodes: structuredClone(w.nodes), edges: structuredClone(w.edges), at: Date.now() } }));
}

/** Trigger types that start a workflow by themselves (and so need turning on). */
const SELF_STARTING: NodeType[] = ["crm-event", "email", "calendar", "file"];

/**
 * How a workflow starts, in words, and whether it starts by itself. Those that
 * do have the on/off switch; the rest start whenever they're asked.
 */
export function howItStarts(w: Workflow): { self: boolean; text: string } {
  const t = (w.live ?? w).nodes.find(isTrigger);
  if (!t) return { self: false, text: "No start yet" };
  if (SELF_STARTING.includes(t.type)) return { self: true, text: defOf(t.type).label };
  if (t.type === "chat") return { self: false, text: "Starts when you ask in a chat" };
  if (t.type === "automation") return { self: false, text: "Starts from an automation" };
  return { self: false, text: "Starts when you run it" };
}

/** Has the draft changed since it was published? */
export function hasDraftChanges(w: Workflow): boolean {
  if (!w.live) return true;
  const shape = (g: Graph) => JSON.stringify([g.nodes.map((n) => [n.id, n.type, n.key, n.config]), g.edges.map((e) => [e.from, e.port, e.to])]);
  return shape(w) !== shape(w.live);
}

// --- graph edits (with undo) ------------------------------------------------------------------

const history = new Map<string, Graph[]>();
const future = new Map<string, Graph[]>();

/** Change a workflow's graph, keeping the old one for ⌘Z. */
export function editGraph(id: string, change: (g: Graph) => Graph) {
  const w = getWorkflow(id);
  if (!w) return;
  const before = { nodes: w.nodes, edges: w.edges };
  const after = change(before);
  if (after === before) return;
  history.set(id, [...(history.get(id) ?? []), before].slice(-100));
  future.delete(id);
  updateWorkflow(id, (x) => ({ ...x, nodes: after.nodes, edges: after.edges }));
}

/** Move without an undo entry per pointer event; `commitMove` records the start once. */
export function moveNodes(id: string, moves: Record<string, { x: number; y: number }>) {
  updateWorkflow(id, (w) => ({ ...w, nodes: w.nodes.map((n) => (moves[n.id] ? { ...n, x: Math.round(moves[n.id].x), y: Math.round(moves[n.id].y) } : n)) }));
}

export function commitMove(id: string, before: Graph) {
  history.set(id, [...(history.get(id) ?? []), before].slice(-100));
  future.delete(id);
}

export function undo(id: string): boolean {
  const past = history.get(id);
  const w = getWorkflow(id);
  if (!past?.length || !w) return false;
  const prev = past[past.length - 1];
  history.set(id, past.slice(0, -1));
  future.set(id, [...(future.get(id) ?? []), { nodes: w.nodes, edges: w.edges }]);
  updateWorkflow(id, (x) => ({ ...x, ...prev }));
  return true;
}

export function redo(id: string): boolean {
  const next = future.get(id);
  const w = getWorkflow(id);
  if (!next?.length || !w) return false;
  const g = next[next.length - 1];
  future.set(id, next.slice(0, -1));
  history.set(id, [...(history.get(id) ?? []), { nodes: w.nodes, edges: w.edges }]);
  updateWorkflow(id, (x) => ({ ...x, ...g }));
  return true;
}

/** Would an edge from `from` to `to` close a loop? */
export function makesCycle(g: Graph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of g.edges) if (e.from === n) stack.push(e.to);
  }
  return false;
}

/** Connect `from`'s `port` to `to`; refuses loops, triggers as targets and duplicates. Returns why not. */
export function connect(id: string, from: string, port: Port, to: string): string | null {
  const w = getWorkflow(id);
  if (!w) return "That workflow is gone.";
  const target = w.nodes.find((n) => n.id === to);
  if (!target) return "That step is gone.";
  if (isTrigger(target)) return "A trigger starts a workflow; nothing connects into it.";
  if (w.edges.some((e) => e.from === from && e.port === port && e.to === to)) return null;
  if (makesCycle(w, from, to)) return "That would make a loop.";
  editGraph(id, (g) => ({ ...g, edges: [...g.edges, { id: uid(), from, port, to }] }));
  return null;
}

export function removeNodes(id: string, ids: string[]) {
  const gone = new Set(ids);
  editGraph(id, (g) => ({ nodes: g.nodes.filter((n) => !gone.has(n.id)), edges: g.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)) }));
}

export function removeEdge(id: string, edgeId: string) {
  editGraph(id, (g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }));
}

export function setNode(id: string, nodeId: string, patch: Partial<WfNode>) {
  editGraph(id, (g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch, config: { ...n.config, ...patch.config } } : n)) }));
}

// --- checks ------------------------------------------------------------------------------------

export interface Problem {
  nodeId?: string;
  text: string;
}

/** What stops a workflow from running as drawn. */
export function problems(g: Graph): Problem[] {
  const out: Problem[] = [];
  const triggers = g.nodes.filter(isTrigger);
  if (triggers.length === 0) out.push({ text: "Add a trigger: it's what starts the workflow." });
  if (triggers.length > 1) out.push({ text: "Keep one trigger per workflow." });
  for (const n of g.nodes) {
    const def = defOf(n.type);
    if (def.group !== "trigger" && !g.edges.some((e) => e.to === n.id)) out.push({ nodeId: n.id, text: `${n.label} isn't connected to anything before it.` });
    const c = n.config;
    const need = (cond: boolean, what: string) => cond || out.push({ nodeId: n.id, text: `${n.label}: ${what}` });
    if (n.type === "agent") need(!!String(c.prompt ?? "").trim(), "say what it should do.");
    if (n.type === "tool") need(!!c.tool, "pick a tool.");
    if (n.type === "if") need(c.mode === "ai" ? !!String(c.question ?? "").trim() : !!String(c.left ?? "").trim(), "set its condition.");
    if (n.type === "crm-update") need(!!(c.stage || c.owner || c.value || c.field), "pick what to change.");
    if (n.type === "crm-log") need(!!String(c.body ?? "").trim(), "write what to log.");
    if (n.type === "board-task") need(!!String(c.title ?? "").trim(), "give the task a title.");
    if (n.type === "notify") need(!!String(c.title ?? "").trim(), "give it a title.");
    if (n.type === "cowork") need(!!String(c.prompt ?? "").trim(), "write the prompt.");
    if (n.type === "file") need(!!c.workspaceId, "pick a folder.");
    if (n.type === "parallel") need(g.edges.filter((e) => e.from === n.id).length >= 2, "connect it to two or more branches.");
    if (n.type === "join") need(g.edges.filter((e) => e.to === n.id).length >= 2, "connect two or more branches into it.");
    if (n.type === "end" && c.outcome === "failed") need(!!String(c.message ?? "").trim(), "say why it failed.");
    if (n.type === "email" || n.type === "calendar") need(!!c.tool, "pick the connector tool to check.");
  }
  return out;
}

// --- templates -------------------------------------------------------------------------------

/** `{{trigger.record.name}}`, `{{research}}`, `{{research.summary}}`. */
const TEMPLATE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let v: unknown = ctx;
  for (const part of path.split(".")) {
    if (v == null) return undefined;
    if (typeof v === "string") {
      // A step's output that is JSON can be read into.
      try {
        v = JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/** Fill `{{…}}` from the trigger and earlier steps' outputs; unknown ones become empty. */
export function render(text: string, ctx: Record<string, unknown>): string {
  return text.replace(TEMPLATE, (_, path: string) => {
    const v = lookup(ctx, path);
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** A value a step can put in its text: stored as `{{key}}`, shown as a chip with `label`. */
export interface Variable {
  key: string;
  label: string;
  /** Which group it's listed under in the Insert menu: the trigger, or the step it comes from. */
  group: string;
}

/** What the trigger hands on, in words that fit it ("Deal's name", "New stage"). */
function triggerVariables(n: WfNode): Variable[] {
  const group = "What started it";
  const v = (key: string, label: string): Variable => ({ key, label, group });
  switch (n.type) {
    case "crm-event": {
      const kind = String(n.config.kind ?? "");
      const noun = kind === "deal" ? "Deal" : kind === "company" ? "Company" : kind === "contact" ? "Contact" : "Record";
      const out = [v("trigger.record.name", `${noun}'s name`), v("trigger.record.id", `The ${noun.toLowerCase()} itself`)];
      if (noun !== "Company") out.push(v("trigger.record.company", "Company"));
      if (noun === "Deal" || noun === "Company" || noun === "Record") out.push(v("trigger.record.value", "Value"), v("trigger.record.stage", "Stage"));
      if (noun === "Contact" || noun === "Record") out.push(v("trigger.record.email", "Email address"));
      out.push(v("trigger.record.owner", "Owner"));
      if (n.config.event === "stage-changed") out.push(v("trigger.to", "New stage"), v("trigger.from", "Old stage"));
      return out;
    }
    case "manual":
    case "chat":
    case "automation":
      return [v("trigger.input", "What it was given")];
    case "email":
      return [v("trigger.subject", "Email subject"), v("trigger.from", "Sender"), v("trigger.item", "The whole email")];
    case "calendar":
      return [v("trigger.title", "Event title"), v("trigger.start", "Start time"), v("trigger.item", "The whole event")];
    case "file":
      return [v("trigger.folder", "Folder")];
    default:
      return [];
  }
}

/** The steps before `nodeId` (what it can use), top to bottom. */
function stepsBefore(g: Graph, nodeId: string): WfNode[] {
  const before = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of g.edges) {
      if (e.to === n && !before.has(e.from)) {
        before.add(e.from);
        stack.push(e.from);
      }
    }
  }
  return g.nodes.filter((n) => before.has(n.id)).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The values a step can use: what the trigger hands on, and each earlier step's answer. */
export function variablesFor(g: Graph, nodeId: string): Variable[] {
  return stepsBefore(g, nodeId).flatMap((n) =>
    isTrigger(n) ? triggerVariables(n) : [{ key: n.key, label: n.label, group: "Earlier steps' answers" }],
  );
}

/** A stored `{{key}}`'s name in words, for any key in the workflow (or the key itself if it's unknown). */
export function variableLabel(g: Graph, key: string): string {
  const trigger = g.nodes.find(isTrigger);
  const fromTrigger = trigger ? triggerVariables(trigger).find((v) => v.key === key) : undefined;
  if (fromTrigger) return fromTrigger.label;
  if (key === "now") return "Now";
  if (key === "today") return "Today";
  const [stepKey, ...rest] = key.split(".");
  const step = g.nodes.find((n) => n.key === stepKey && !isTrigger(n));
  if (step) return rest.length ? `${step.label} › ${rest.join(" › ")}` : step.label;
  return key.replace(/^trigger\./, "").replace(/\./g, " › ");
}

/** Text with each `{{key}}` written as its name in brackets, for one-line summaries. */
export function humanize(g: Graph, text: string): string {
  return text.replace(TEMPLATE, (_, key: string) => `[${variableLabel(g, key)}]`);
}

// --- runs ------------------------------------------------------------------------------------

export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export interface StepRun {
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  /** What it was given, for the run panel. */
  input?: string;
  output?: string;
  /** What went wrong, in plain words. */
  error?: string;
  /** The error as the provider or tool gave it, when `error` rewords it. */
  errorDetail?: string;
  /** An agent or tool step's thread. */
  threadId?: string;
  /** The port it went out of. */
  port?: Port;
  /** Why it's waiting: an approval node's message, or an agent's tool approval. */
  waitingFor?: string;
}

export type RunStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export interface WfRun {
  id: string;
  workflowId: string;
  test: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** What started it, e.g. "Deal “Pilot” moved to Proposal". */
  reason: string;
  trigger: Record<string, unknown>;
  steps: Record<string, StepRun>;
  /** The window running it; another window answers its approvals through `decisions`. */
  runner: string;
  /** Approval answers by node id, from any window. */
  decisions?: Record<string, boolean>;
  /** Asked to stop from any window. */
  stopRequested?: boolean;
  error?: string;
}

const RUNS_KEPT = 60;
const runs = createStore<WfRun[]>("sush.workflow-runs", []);

export const useWorkflowRuns = () => useSyncExternalStore(runs.subscribe, runs.get);
export const getRuns = () => runs.get();
export const subscribeRuns = runs.subscribe;

export function putRun(run: WfRun) {
  runs.set((all) => [run, ...all.filter((r) => r.id !== run.id)].slice(0, RUNS_KEPT));
}

export function patchRun(id: string, change: (r: WfRun) => WfRun) {
  runs.set((all) => all.map((r) => (r.id === id ? change(r) : r)));
}

export function decide(runId: string, nodeId: string, yes: boolean) {
  patchRun(runId, (r) => ({ ...r, decisions: { ...r.decisions, [nodeId]: yes } }));
}

export function requestStop(runId: string) {
  patchRun(runId, (r) => ({ ...r, stopRequested: true }));
}

export function deleteRuns(workflowId: string) {
  runs.set((all) => all.filter((r) => r.workflowId !== workflowId));
}

// --- step threads ------------------------------------------------------------------------------

/**
 * Threads that agent and tool steps run on, with what their runs get: the
 * step's instructions and, for a tool step, its one tool. Kept here (and so
 * in every window) so an approval answered from any window gets the same config.
 */
export interface StepThread {
  workflowId: string;
  runId: string;
  nodeId: string;
  system: string;
  /** Only these tools (full names), offered from the start. */
  only?: string[];
  /** The model the step runs on. */
  target?: ModelTarget;
}

const stepThreads = createStore<Record<string, StepThread>>("sush.workflow-threads", {});

export const useStepThreads = () => useSyncExternalStore(stepThreads.subscribe, stepThreads.get);
export const stepThread = (threadId: string): StepThread | undefined => stepThreads.get()[threadId];

export function addStepThread(threadId: string, t: StepThread) {
  stepThreads.set((all) => {
    const entries = Object.entries({ ...all, [threadId]: t });
    // Keep the newest few hundred.
    return Object.fromEntries(entries.slice(-300));
  });
}

const stepSets = new WeakMap<Record<string, StepThread>, ReadonlySet<string>>();
/** Step threads as a set, for the session list's filter. */
export function useStepThreadIds(): ReadonlySet<string> {
  const all = useStepThreads();
  let set = stepSets.get(all);
  if (!set) stepSets.set(all, (set = new Set(Object.keys(all))));
  return set;
}

// --- errors ----------------------------------------------------------------------------------

/**
 * A model provider's account or connection problem, which no change to the
 * workflow fixes (and which a model asked to fix it would hit too), in plain
 * words. Null for anything else.
 */
export function providerTrouble(raw: string | undefined): { text: string; action: "credits" | "key" | "wait" | "network" } | null {
  if (!raw) return null;
  const who = /ollama/i.test(raw) ? "Ollama" : /anthropic/i.test(raw) ? "Anthropic" : /openai/i.test(raw) ? "OpenAI" : "Your model provider";
  if (/\b402\b|credits?\b|billing|insufficient[_ ]quota|payment required|subscribe/i.test(raw)) {
    return { action: "credits", text: `${who} turned the request down: the account is out of credits. Add credits with ${who === "Your model provider" ? "them" : who}, or switch to another model.` };
  }
  if (/\b(401|403)\b|unauthori[sz]ed|invalid (api )?key|forbidden/i.test(raw)) {
    return { action: "key", text: `${who} didn't accept the API key. Check the key in Settings → Providers, or switch to another model.` };
  }
  if (/\b429\b|rate.?limit|too many requests|overloaded|\b529\b/i.test(raw)) {
    return { action: "wait", text: `${who} is busy or limiting requests right now. Wait a minute and run it again, or switch to another model.` };
  }
  if (/error sending request|connection refused|timed out|dns|network|could not connect|failed to fetch/i.test(raw)) {
    return { action: "network", text: `Couldn't reach ${who === "Your model provider" ? "the model provider" : who}. Check your internet connection (or that Ollama is running, for a local model) and run it again.` };
  }
  return null;
}

// --- describing ------------------------------------------------------------------------------

export function durationText(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function whenText(at: number): string {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- models ----------------------------------------------------------------------------------

/** A step's own model, if it picked one (kept as two plain settings). */
export function stepModel(n: WfNode): ModelTarget | null {
  const providerId = String(n.config.modelProvider ?? "");
  const model = String(n.config.modelName ?? "");
  return providerId && model ? { providerId, model } : null;
}

/** The model a step (or, without one, the workflow's AI helpers) runs on: the step's, the workflow's, or the default. */
export function modelFor(w: Workflow, n?: WfNode): ModelTarget | null {
  return (n && stepModel(n)) ?? w.model ?? getTarget();
}
