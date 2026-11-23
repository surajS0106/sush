// The model's Board tools. They run in the UI (`runTool` in `agent.ts`) against
// the user's tasks (`lib/board.ts`, localStorage):
//
//   board_search  runs at once: tasks by words, status, priority and folder, as compact rows
//   board_write   adds, changes or deletes tasks; asks with a card showing each change
//                 (runs at once in Auto mode)
//
// Both are deferred: listed in the system prompt, loaded when needed.

import { createTask, deleteTask, getTasks, PRIORITIES, STATUSES, updateTask, type Priority, type Task, type TaskStatus } from "@/lib/board";
import type { ToolSpec, Workspace } from "@/lib/tauri";
import { getWorkspaces } from "@/lib/workspaces";

export const BOARD_SEARCH = "board_search";
export const BOARD_WRITE = "board_write";
export const BOARD_TOOL_NAMES: ReadonlySet<string> = new Set([BOARD_SEARCH, BOARD_WRITE]);

const PRIORITY_IDS = PRIORITIES.map((p) => p.id);
const STATUS_IDS = STATUSES.map((s) => s.id);

export const boardSearchTool: ToolSpec = {
  name: BOARD_SEARCH,
  description:
    "Search the tasks on the user's Board in Sush (their own task list, shown as Kanban columns). Use it when they ask " +
    "about their tasks, to-dos or what's on their plate, and to find a task's id before changing it with board_write. " +
    "Leave out every argument to list all open tasks.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for in titles and descriptions." },
      status: { type: "string", enum: STATUS_IDS },
      priority: { type: "string", enum: PRIORITY_IDS },
      folder: { type: "string", description: "Only tasks in this Cowork folder (its name); \"\" for tasks without one." },
      includeDone: { type: "boolean", description: "Include done tasks (left out by default unless status is done)." },
      limit: { type: "number", description: "Rows to return, up to 100 (default 50)." },
    },
  },
};

const taskSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "To change or delete a task; leave out to add one." },
    title: { type: "string", description: "Required when adding." },
    description: { type: "string", description: "Replaces the description; read it first to keep what's there." },
    priority: { type: "string", enum: PRIORITY_IDS, description: "Defaults to medium when adding." },
    status: { type: "string", enum: STATUS_IDS, description: "blocked shows as \"Needs attention\", review as \"Ready for review\". Defaults to todo." },
    folder: { type: "string", description: "A Cowork folder's name to work on the task in; \"\" to clear." },
    delete: { type: "boolean", description: "Delete the task (with id)." },
  },
};

export const boardWriteTool: ToolSpec = {
  name: BOARD_WRITE,
  description:
    "Add, change or delete tasks on the user's Board in Sush: one call for all the changes a request needs (up to 50). " +
    "Use it when they ask you to create a task, to-do or reminder for themselves, set its priority or status, mark it done, " +
    "or tidy the board. Only the fields you pass change. The user sees each change and approves it, so don't ask first; " +
    "say what you changed after.",
  inputSchema: {
    type: "object",
    properties: { tasks: { type: "array", items: taskSchema } },
    required: ["tasks"],
  },
};

// --- running -----------------------------------------------------------------------------

type Args = Record<string, unknown>;
type Result = { output: unknown } | { errorText: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A priority from what the model sent, forgiving common words. */
function toPriority(v: string): Priority | undefined {
  const s = v.toLowerCase().replace(/\s*priority$/, "");
  if ((PRIORITY_IDS as string[]).includes(s)) return s as Priority;
  if (["urgent", "critical", "highest", "p0", "p1", "important"].includes(s)) return "high";
  if (["normal", "med", "p2", "default"].includes(s)) return "medium";
  if (["lowest", "p3", "p4", "minor"].includes(s)) return "low";
  return undefined;
}

/** A status from its id or its label on the board. */
function toStatus(v: string): TaskStatus | undefined {
  const s = v.toLowerCase().replace(/[\s_]+/g, "-");
  if ((STATUS_IDS as string[]).includes(s)) return s as TaskStatus;
  const byLabel = STATUSES.find((x) => x.label.toLowerCase().replace(/\s+/g, "-") === s);
  if (byLabel) return byLabel.id;
  if (["to-do", "open", "new", "backlog"].includes(s)) return "todo";
  if (["doing", "started", "in-process", "wip"].includes(s)) return "in-progress";
  if (["needs-attention", "stuck", "waiting"].includes(s)) return "blocked";
  if (["in-review", "ready-for-review"].includes(s)) return "review";
  if (["complete", "completed", "finished", "closed"].includes(s)) return "done";
  return undefined;
}

const folderName = (id: string | undefined, folders: Workspace[]) => (id ? folders.find((w) => w.id === id)?.name : undefined);

/** A task as the model sees it: nothing empty, the folder by name. */
function brief(t: Task, folders: Workspace[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: t.id, title: t.title, priority: t.priority, status: t.status };
  if (t.description.trim()) out.description = t.description.length > 400 ? `${t.description.slice(0, 400)}…` : t.description;
  const folder = folderName(t.workspaceId, folders);
  if (folder) out.folder = folder;
  if (t.sessionIds.length) out.sessions = t.sessionIds.length;
  out.updated = day(t.updatedAt);
  return out;
}

function search(args: Args): Result {
  const folders = getWorkspaces();
  const query = (str(args.query) ?? "").toLowerCase();
  const status = str(args.status) ? toStatus(str(args.status)!) : undefined;
  if (str(args.status) && !status) return { errorText: `status must be one of ${STATUS_IDS.join(", ")}.` };
  const priority = str(args.priority) ? toPriority(str(args.priority)!) : undefined;
  if (str(args.priority) && !priority) return { errorText: `priority must be one of ${PRIORITY_IDS.join(", ")}.` };
  const folder = typeof args.folder === "string" ? args.folder.trim().toLowerCase() : undefined;
  const includeDone = args.includeDone === true || status === "done";
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
  const words = query.split(/\s+/).filter(Boolean);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const found = getTasks()
    .filter((t) => includeDone || t.status !== "done")
    .filter((t) => !status || t.status === status)
    .filter((t) => !priority || t.priority === priority)
    .filter((t) => folder === undefined || (folderName(t.workspaceId, folders) ?? "").toLowerCase() === folder)
    .filter((t) => words.every((w) => `${t.title}\n${t.description}`.toLowerCase().includes(w)))
    .sort((a, b) => rank[a.priority] - rank[b.priority] || b.updatedAt - a.updatedAt);
  return {
    output: JSON.stringify({
      today: day(Date.now()),
      matched: found.length,
      tasks: found.slice(0, limit).map((t) => brief(t, folders)),
      ...(found.length > limit ? { more: `${found.length - limit} more; narrow the search or raise limit.` } : {}),
      ...(getTasks().length === 0 ? { note: "The Board is empty." } : {}),
    }),
  };
}

// --- writes ------------------------------------------------------------------------------

/** One change a board_write call makes, worked out before the user approves it. */
export interface PlannedTaskChange {
  action: "add" | "update" | "delete";
  before?: Task;
  /** The task as it will be (for a delete, as it is). */
  after: Task;
  /** Fields that change, for the card. */
  changed: (keyof Task)[];
}

const COMPARED: (keyof Task)[] = ["title", "description", "priority", "status", "workspaceId"];

/** Work out what a board_write call would do, or why it can't. */
export function planBoardWrite(input: unknown, tasks: Task[], folders: Workspace[]): { ok: true; changes: PlannedTaskChange[] } | { ok: false; error: string } {
  const list = (input as Args | undefined)?.tasks;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "board_write needs `tasks`: a list of tasks to add, change or delete." };
  if (list.length > 50) return { ok: false, error: "board_write takes up to 50 tasks at a time." };
  const changes: PlannedTaskChange[] = [];
  for (const [i, raw] of (list as Args[]).entries()) {
    const at = `tasks[${i}]`;
    const id = str(raw.id);
    let before: Task | undefined;
    if (id) {
      before = tasks.find((t) => t.id === id);
      if (!before) return { ok: false, error: `${at}: no task with id ${id}. Find it with board_search.` };
    }
    if (raw.delete === true) {
      if (!before) return { ok: false, error: `${at}: pass the id of the task to delete.` };
      changes.push({ action: "delete", before, after: before, changed: [] });
      continue;
    }
    const now = Date.now();
    const after: Task = before
      ? { ...before }
      : { id: "", title: "", description: "", priority: "medium", status: "todo", sessionIds: [], order: 0, createdAt: now, updatedAt: now };
    if (raw.title !== undefined) after.title = str(raw.title) ?? "";
    if (!after.title) return { ok: false, error: `${at}: give the task a title.` };
    if (raw.description !== undefined) after.description = raw.description == null ? "" : String(raw.description).trim();
    if (raw.priority !== undefined) {
      const p = toPriority(String(raw.priority));
      if (!p) return { ok: false, error: `${at}: priority must be one of ${PRIORITY_IDS.join(", ")}.` };
      after.priority = p;
    }
    if (raw.status !== undefined) {
      const s = toStatus(String(raw.status));
      if (!s) return { ok: false, error: `${at}: status must be one of ${STATUS_IDS.join(", ")}.` };
      after.status = s;
    }
    if (raw.folder !== undefined) {
      const name = str(raw.folder);
      if (!name) after.workspaceId = undefined;
      else {
        const w = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
        if (!w) return { ok: false, error: `${at}: no Cowork folder "${name}". Folders: ${folders.map((f) => f.name).join(", ") || "none"}.` };
        after.workspaceId = w.id;
      }
    }
    const changed = before ? COMPARED.filter((k) => (before[k] ?? "") !== (after[k] ?? "")) : [];
    if (before && changed.length === 0) continue;
    changes.push({ action: before ? "update" : "add", before, after, changed });
  }
  if (changes.length === 0) return { ok: false, error: "Nothing would change: those tasks already have those values." };
  return { ok: true, changes };
}

/** Make the planned changes; the result for the model. */
export function applyBoardWrite(changes: PlannedTaskChange[]): Result {
  const done: string[] = [];
  for (const c of changes) {
    const { title, description, priority, status, workspaceId } = c.after;
    if (c.action === "add") {
      const t = createTask({ title, description, priority, status, workspaceId });
      done.push(`added "${t.title}" (${t.id}, ${t.priority} priority, ${t.status})`);
    } else if (c.action === "update") {
      updateTask(c.after.id, { title, description, priority, status, workspaceId });
      done.push(`updated "${title}" (${c.changed.join(", ")})`);
    } else {
      deleteTask(c.after.id);
      done.push(`deleted "${title}"`);
    }
  }
  return { output: `Done: ${done.join("; ")}. The tasks are on the Board page.` };
}

/** The tasks a finished board_write added or changed (deleted ones left out), from its input and output. */
export function writtenTaskIds(input: unknown, output: unknown): string[] {
  const ids: string[] = [];
  const items = (input as { tasks?: unknown })?.tasks;
  if (Array.isArray(items)) {
    for (const raw of items as Args[]) {
      const id = str(raw?.id);
      if (id && raw.delete !== true) ids.push(id);
    }
  }
  // Added tasks get their ids on apply: `added "Title" (<id>, …`.
  for (const m of String(output ?? "").matchAll(/added ".*?" \(([0-9a-f-]{36}),/g)) ids.push(m[1]);
  return [...new Set(ids)];
}

/** Run a Board tool unasked: the search always, the write in Auto mode. Never throws. */
export function runBoardTool(name: string, args: Args): Result {
  try {
    if (name === BOARD_SEARCH) return search(args);
    if (name === BOARD_WRITE) {
      const plan = planBoardWrite(args, getTasks(), getWorkspaces());
      return plan.ok ? applyBoardWrite(plan.changes) : { errorText: plan.error };
    }
    return { errorText: `Unknown Board tool ${name}.` };
  } catch (e) {
    return { errorText: e instanceof Error ? e.message : String(e) };
  }
}

/** A field's label and value as text, for a change list. */
export const TASK_FIELD_LABELS: Partial<Record<keyof Task, string>> = {
  title: "Title",
  description: "Description",
  priority: "Priority",
  status: "Status",
  workspaceId: "Folder",
};

export function taskFieldText(t: Task, field: keyof Task, folders: Workspace[]): string {
  if (field === "priority") return PRIORITIES.find((p) => p.id === t.priority)?.label ?? t.priority;
  if (field === "status") return STATUSES.find((s) => s.id === t.status)?.label ?? t.status;
  if (field === "workspaceId") return folderName(t.workspaceId, folders) ?? "";
  return String(t[field] ?? "");
}
