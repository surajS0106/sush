// `todo_write`: the model's working plan for a multi-step task, like Claude
// Code's to-do list. Each call sends the whole list; the chat shows the latest
// one as a checklist (`TodoPart` in `components/tool-parts.tsx`) and earlier
// ones as a line. Nothing is stored apart from the call itself, so the plan
// lives in the thread and survives reloads, rewinds and forks with it.

import type { ToolResult } from "@/lib/agent";
import type { ToolSpec } from "@/lib/tauri";

export const TODO_WRITE = "todo_write";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
  /** Present tense, shown while the item is in progress, e.g. "Running the tests". */
  activeForm?: string;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

export const todoTool: ToolSpec = {
  name: TODO_WRITE,
  description:
    "Create or update your to-do list for the current task. Send the whole list every time: it replaces the previous one. " +
    "Call it first, before any other tool, when the user asks for more than one thing or the work takes several steps; " +
    "count the things asked for, not the files (three changes to one file are three items). Skip it only for a question " +
    "or a single small change. Mark an item in_progress before you start it (one at a time) and completed " +
    "as soon as it's done, not in batches later. Add items you discover along the way and remove ones that no longer apply.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What to do, imperative, e.g. 'Run the tests'" },
            activeForm: { type: "string", description: "The same in present tense, shown while it's in progress, e.g. 'Running the tests'" },
            status: { type: "string", enum: STATUSES as unknown as string[] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
};

/** Standing instructions, in the system prompt of every session that offers the tool. */
export const TODO_SECTION =
  "Planning: when a request asks for more than one thing or takes several steps (changes, commands, checks, a " +
  "multi-part task, research with several questions), call todo_write before anything else to break it into a to-do " +
  "list, one item per thing asked for, then work through it item by item, updating the list as each one starts and finishes, until every item is done or you're blocked on the user. " +
  "Don't stop with items still pending unless you need the user; if you do, say what's left. Only mark an item " +
  "completed when it's actually done: if something failed or is partial, keep it in progress and add an item for " +
  "what's needed. Only a question or a single small change needs no list.";

/** The list in a call's input, or null if it isn't one. Tolerates what a model gets slightly wrong. */
export function parseTodos(input: unknown): Todo[] | null {
  const raw = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(raw)) return null;
  const todos: Todo[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const { content, status, activeForm } = t as Record<string, unknown>;
    if (typeof content !== "string" || !content.trim()) return null;
    const s = typeof status === "string" ? status.toLowerCase().replace(/[\s-]/g, "_") : "";
    todos.push({
      content: content.trim(),
      status: STATUSES.includes(s as TodoStatus) ? (s as TodoStatus) : s === "done" ? "completed" : "pending",
      activeForm: typeof activeForm === "string" && activeForm.trim() ? activeForm.trim() : undefined,
    });
  }
  return todos;
}

export function todoProgress(todos: Todo[]) {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
}

export function runTodoWrite(args: Record<string, unknown>): ToolResult {
  const todos = parseTodos(args);
  if (!todos) {
    return { errorText: "todo_write needs `todos`: an array of { content, status } with status pending, in_progress or completed." };
  }
  const active = todos.filter((t) => t.status === "in_progress").length;
  const { done, total } = todoProgress(todos);
  const notes = [`To-do list updated (${done} of ${total} done).`];
  if (active > 1) notes.push("Keep only one item in_progress at a time.");
  if (total > 0 && done < total) {
    notes.push(active === 0 ? "Mark the next item in_progress and carry on." : "Carry on with the item in progress.");
  } else if (total > 0) {
    notes.push("Every item is done: check the result, then tell the user what you did.");
  }
  return { output: notes.join(" ") };
}
