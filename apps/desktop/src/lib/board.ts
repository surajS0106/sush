// The Board: the user's own tasks as cards in columns (by priority or by status).
// Tasks live in localStorage like projects, so every window follows them through the
// `storage` event. A task can be worked on in a session: Sush starts one (Cowork in the
// task's folder, else a chat) prefilled with the task, and remembers it on the task.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

export type Priority = "low" | "medium" | "high";
export type TaskStatus = "todo" | "in-progress" | "blocked" | "review" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: TaskStatus;
  /** A Cowork folder the task's sessions work in. */
  workspaceId?: string;
  /** Sessions started from this task, oldest first. */
  sessionIds: string[];
  /** Position within its column; lower comes first. */
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type GroupBy = "priority" | "status";
export type BoardFilter = "all" | "open" | "done";
export type BoardSort = "manual" | "updated" | "created" | "title";

export interface BoardView {
  groupBy: GroupBy;
  layout: "board" | "list";
  filter: BoardFilter;
  sort: BoardSort;
  /** `undefined` is every folder, `""` tasks without one. */
  folder?: string;
}

export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: "low", label: "Low priority" },
  { id: "medium", label: "Medium priority" },
  { id: "high", label: "High priority" },
];

export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "blocked", label: "Needs attention" },
  { id: "review", label: "Ready for review" },
  { id: "done", label: "Done" },
];

/** A column on the board: a priority (open tasks only, plus "Completed") or a status. */
export type ColumnId = Priority | TaskStatus;

export function columnsFor(groupBy: GroupBy): { id: ColumnId; label: string }[] {
  return groupBy === "status" ? STATUSES : [...PRIORITIES, { id: "done", label: "Completed" }];
}

export const columnOf = (task: Task, groupBy: GroupBy): ColumnId =>
  groupBy === "status" || task.status === "done" ? task.status : task.priority;

const tasks = createStore<Task[]>("sush.board.tasks", []);
const view = createStore<BoardView>("sush.board.view", { groupBy: "priority", layout: "board", filter: "all", sort: "manual" });

export const useTasks = () => useSyncExternalStore(tasks.subscribe, tasks.get);
export const getTask = (id: string) => tasks.get().find((t) => t.id === id);
export const useBoardView = () => useSyncExternalStore(view.subscribe, view.get);
export const setBoardView = (patch: Partial<BoardView>) => view.set((v) => ({ ...v, ...patch }));

export type TaskDraft = Pick<Task, "title" | "description" | "priority" | "status" | "workspaceId">;

/** Adds a task at the end of its column. */
export function createTask(draft: TaskDraft): Task {
  const now = Date.now();
  const all = tasks.get();
  const task: Task = {
    ...draft,
    title: draft.title.trim() || "Untitled task",
    id: crypto.randomUUID(),
    sessionIds: [],
    order: Math.max(0, ...all.map((t) => t.order)) + 1,
    createdAt: now,
    updatedAt: now,
  };
  tasks.set([...all, task]);
  return task;
}

export function updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>) {
  tasks.set((all) =>
    all.map((t) =>
      t.id === id ? { ...t, ...patch, title: patch.title !== undefined ? patch.title.trim() || t.title : t.title, updatedAt: Date.now() } : t,
    ),
  );
}

export const deleteTask = (id: string) => tasks.set((all) => all.filter((t) => t.id !== id));

/**
 * Moves a task into `column` before `beforeId` (or to the end). In the priority view,
 * "Completed" marks it done and a priority column reopens a done task.
 */
export function moveTask(id: string, column: ColumnId, groupBy: GroupBy, beforeId?: string) {
  const all = tasks.get();
  const task = all.find((t) => t.id === id);
  if (!task) return;
  const patch: Partial<Task> = {};
  if (groupBy === "status") patch.status = column as TaskStatus;
  else if (column === "done") patch.status = "done";
  else {
    patch.priority = column as Priority;
    if (task.status === "done") patch.status = "todo";
  }
  const moved = { ...task, ...patch };
  const siblings = all
    .filter((t) => t.id !== id && columnOf(t, groupBy) === columnOf(moved, groupBy))
    .sort((a, b) => a.order - b.order);
  const at = beforeId ? siblings.findIndex((t) => t.id === beforeId) : -1;
  const prev = at === -1 ? siblings.at(-1) : siblings[at - 1];
  const next = at === -1 ? undefined : siblings[at];
  patch.order =
    prev && next ? (prev.order + next.order) / 2 : next ? next.order - 1 : prev ? prev.order + 1 : task.order;
  updateTask(id, patch);
}

/** Records a session started from the task, and moves a to-do task along. */
export function linkSession(id: string, sessionId: string) {
  const task = getTask(id);
  if (!task) return;
  updateTask(id, {
    sessionIds: task.sessionIds.includes(sessionId) ? task.sessionIds : [...task.sessionIds, sessionId],
    status: task.status === "todo" ? "in-progress" : task.status,
  });
}

/** What a session started from a task opens with in its composer. */
export function taskPrompt(task: Task): string {
  const body = task.description.trim();
  return body ? `${task.title}\n\n${body}` : task.title;
}
