// The Board page: tasks as cards in columns, by priority (with "Completed") or by status,
// or as a list. Cards are dragged with pointer events, since the webview's native drag and
// drop is taken by Tauri on Windows. A task opens in a dialog to edit it or start a session on it.

import {
  ArrowUpDownIcon,
  CheckIcon,
  CircleCheckIcon,
  FolderIcon,
  KanbanIcon,
  ListFilterIcon,
  ListIcon,
  MessagesSquareIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  columnOf,
  columnsFor,
  createTask,
  deleteTask,
  moveTask,
  PRIORITIES,
  setBoardView,
  STATUSES,
  updateTask,
  useBoardView,
  useTasks,
  type BoardSort,
  type ColumnId,
  type GroupBy,
  type Priority,
  type Task,
  type TaskDraft,
  type TaskStatus,
} from "@/lib/board";
import { useConversations, type Conversation } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";
import type { Workspace } from "@/lib/tauri";

/** What the dialog is open on: an existing task, or a new one. */
type Editing = { task: Task } | { draft: TaskDraft };

const SORTS: { id: BoardSort; label: string }[] = [
  { id: "manual", label: "Manual" },
  { id: "updated", label: "Recently updated" },
  { id: "created", label: "Recently created" },
  { id: "title", label: "Title" },
];

const NO_FOLDER = "none";

export function BoardPage({
  onStartTask,
  onOpenSession,
}: {
  /** Starts a session on the task (saved first) and opens it. */
  onStartTask: (task: Task) => void;
  onOpenSession: (id: string) => void;
}) {
  const all = useTasks();
  const view = useBoardView();
  const workspaces = useWorkspaces();
  const conversations = useConversations();
  const [query, setQuery] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const liveSessions = (t: Task) => t.sessionIds.filter((id) => conversations.some((c) => c.id === id && c.messages.length > 0));
  const folderName = (id: string | undefined) => (id ? workspaces.find((w) => w.id === id)?.name : undefined);

  const q = query?.trim().toLowerCase() ?? "";
  const scoped = all.filter(
    (t) =>
      (view.folder === undefined || (t.workspaceId ?? "") === view.folder) &&
      (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
  );
  const open = scoped.filter((t) => t.status !== "done");
  const done = scoped.filter((t) => t.status === "done");
  const shown = view.filter === "open" ? open : view.filter === "done" ? done : scoped;
  const sorted = [...shown].sort((a, b) => {
    if (view.sort === "updated") return b.updatedAt - a.updatedAt;
    if (view.sort === "created") return b.createdAt - a.createdAt;
    if (view.sort === "title") return a.title.localeCompare(b.title);
    return a.order - b.order;
  });
  const columns = columnsFor(view.groupBy).filter(
    (c) => view.filter === "all" || (view.filter === "done" ? c.id === "done" : c.id !== "done"),
  );
  const tasksIn = (column: ColumnId) => sorted.filter((t) => columnOf(t, view.groupBy) === column);

  const newTask = (column?: ColumnId) => {
    const draft: TaskDraft = {
      title: "",
      description: "",
      priority: "medium",
      status: "todo",
      workspaceId: view.folder || undefined,
    };
    if (column) {
      if (view.groupBy === "status") draft.status = column as TaskStatus;
      else if (column === "done") draft.status = "done";
      else draft.priority = column as Priority;
    }
    setEditing({ draft });
  };

  const usedFolders = workspaces.filter((w) => all.some((t) => t.workspaceId === w.id));
  const folderLabel = view.folder === undefined ? "All folders" : view.folder === "" ? "No folder" : (folderName(view.folder) ?? "Removed folder");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 px-6 pt-6 pb-3">
        <div className="mr-2 flex items-center gap-2">
          <KanbanIcon className="size-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Board</h1>
        </div>
        <FilterChips
          value={view.filter}
          onChange={(filter) => setBoardView({ filter })}
          counts={{ all: scoped.length, open: open.length, done: done.length }}
        />
        <span className="flex-1" />
        {query === null ? (
          <Button variant="ghost" size="icon" aria-label="Search tasks" onClick={() => setQuery("")}>
            <SearchIcon />
          </Button>
        ) : (
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
              placeholder="Search tasks"
              aria-label="Search tasks"
              className="h-8 w-48 pr-8 pl-8"
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={() => setQuery(null)}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <ListFilterIcon />
              {view.folder === undefined ? "Filter" : folderLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Folder</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={view.folder === undefined ? "*" : view.folder || NO_FOLDER}
              onValueChange={(v) => setBoardView({ folder: v === "*" ? undefined : v === NO_FOLDER ? "" : v })}
            >
              <DropdownMenuRadioItem value="*">All folders</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value={NO_FOLDER}>No folder</DropdownMenuRadioItem>
              {usedFolders.map((w) => (
                <DropdownMenuRadioItem key={w.id} value={w.id}>
                  {w.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <ArrowUpDownIcon />
              Sort
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Group by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view.groupBy} onValueChange={(v) => setBoardView({ groupBy: v as GroupBy })}>
              <DropdownMenuRadioItem value="priority">Priority</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="status">Status</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view.sort} onValueChange={(v) => setBoardView({ sort: v as BoardSort })}>
              {SORTS.map((s) => (
                <DropdownMenuRadioItem key={s.id} value={s.id}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex rounded-md bg-muted p-0.5" role="radiogroup" aria-label="Layout">
          {(["board", "list"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={view.layout === l}
              onClick={() => setBoardView({ layout: l })}
              className={cn(
                "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors",
                view.layout === l && "bg-background text-foreground shadow-sm",
              )}
            >
              {l === "board" ? <KanbanIcon className="size-3.5" /> : <ListIcon className="size-3.5" />}
              {l === "board" ? "Board" : "List"}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => newTask()}>
          <PlusIcon />
          New task
        </Button>
      </header>

      {view.layout === "board" ? (
        <BoardColumns
          columns={columns}
          tasksIn={tasksIn}
          groupBy={view.groupBy}
          folderName={folderName}
          sessionCount={(t) => liveSessions(t).length}
          onOpen={(task) => setEditing({ task })}
          onAdd={newTask}
        />
      ) : (
        <TaskList
          columns={columns}
          tasksIn={tasksIn}
          folderName={folderName}
          sessionCount={(t) => liveSessions(t).length}
          onOpen={(task) => setEditing({ task })}
          empty={all.length === 0}
          onAdd={() => newTask()}
        />
      )}

      <TaskDialog
        editing={editing}
        onClose={() => setEditing(null)}
        workspaces={workspaces}
        conversations={conversations}
        onStart={(task) => {
          setEditing(null);
          onStartTask(task);
        }}
        onOpenSession={(id) => {
          setEditing(null);
          onOpenSession(id);
        }}
      />
    </div>
  );
}

function FilterChips({
  value,
  onChange,
  counts,
}: {
  value: "all" | "open" | "done";
  onChange: (v: "all" | "open" | "done") => void;
  counts: Record<"all" | "open" | "done", number>;
}) {
  const chips = [
    { id: "all", label: "All tasks" },
    { id: "open", label: "Open" },
    { id: "done", label: "Completed" },
  ] as const;
  return (
    <div className="flex items-center gap-1">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            value === c.id ? "border-transparent bg-muted text-foreground" : "border-border",
          )}
        >
          {c.label}
          <span className="text-muted-foreground tabular-nums">{counts[c.id]}</span>
        </button>
      ))}
    </div>
  );
}

// --- board -----------------------------------------------------------------------

interface Drag {
  task: Task;
  /** Pointer position, and where on the card it was grabbed. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  over?: { column: ColumnId; beforeId?: string };
}

function BoardColumns({
  columns,
  tasksIn,
  groupBy,
  folderName,
  sessionCount,
  onOpen,
  onAdd,
}: {
  columns: { id: ColumnId; label: string }[];
  tasksIn: (column: ColumnId) => Task[];
  groupBy: GroupBy;
  folderName: (id: string | undefined) => string | undefined;
  sessionCount: (t: Task) => number;
  onOpen: (t: Task) => void;
  onAdd: (column: ColumnId) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag ends in a click on the card it started on; that click shouldn't open it.
  const dragged = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const target = (x: number, y: number, id: string): Drag["over"] => {
    const column = document.elementsFromPoint(x, y).find((el) => el instanceof HTMLElement && el.dataset.boardColumn) as
      | HTMLElement
      | undefined;
    if (!column) return undefined;
    const cards = [...column.querySelectorAll<HTMLElement>("[data-task-id]")].filter((el) => el.dataset.taskId !== id);
    const before = cards.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return { column: column.dataset.boardColumn as ColumnId, beforeId: before?.dataset.taskId };
  };

  const startDrag = (task: Task, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const card = e.currentTarget.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      active = true;
      dragged.current = true;
      setDrag({
        task,
        x: ev.clientX,
        y: ev.clientY,
        dx: start.x - card.left,
        dy: start.y - card.top,
        width: card.width,
        over: target(ev.clientX, ev.clientY, task.id),
      });
    };
    const end = (ev: PointerEvent) => {
      stop();
      if (!active) return;
      const over = ev.type === "pointerup" ? target(ev.clientX, ev.clientY, task.id) : undefined;
      if (over) moveTask(task.id, over.column, groupBy, over.beforeId);
      setDrag(null);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      stop();
      setDrag(null);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key);
      document.body.style.removeProperty("user-select");
      cleanup.current = null;
    };
    cleanup.current?.();
    cleanup.current = stop;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key);
  };

  return (
    <div className={cn("flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6", drag && "cursor-grabbing")}>
      {columns.map((col) => {
        const tasks = tasksIn(col.id);
        const over = drag?.over?.column === col.id ? drag.over : undefined;
        return (
          <section
            key={col.id}
            data-board-column={col.id}
            aria-label={col.label}
            className={cn(
              "group/column flex min-w-64 flex-1 basis-0 flex-col rounded-xl border transition-colors",
              over && "border-foreground/30",
            )}
          >
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <ColumnIcon id={col.id} />
              <h2 className="flex-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{col.label}</h2>
              <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{tasks.length}</span>
              <button
                type="button"
                aria-label={`Add a task to ${col.label}`}
                onClick={() => onAdd(col.id)}
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/column:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </div>
            <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {tasks.map((t) => (
                <div key={t.id} className="flex flex-col gap-2">
                  {over && over.beforeId === t.id && <DropLine />}
                  <TaskCard
                    task={t}
                    folder={folderName(t.workspaceId)}
                    sessions={sessionCount(t)}
                    lifted={drag?.task.id === t.id}
                    onPointerDown={(e) => startDrag(t, e)}
                    onOpen={() => {
                      if (dragged.current) dragged.current = false;
                      else onOpen(t);
                    }}
                  />
                </div>
              ))}
              {over && !over.beforeId && <DropLine />}
              {tasks.length === 0 && !over && (
                <button
                  type="button"
                  onClick={() => onAdd(col.id)}
                  className="flex h-16 items-center justify-center gap-1.5 rounded-lg border border-dashed text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <PlusIcon className="size-3.5" />
                  Add task
                </button>
              )}
            </div>
          </section>
        );
      })}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 rotate-2"
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width } as CSSProperties}
        >
          <TaskCard
            task={drag.task}
            folder={folderName(drag.task.workspaceId)}
            sessions={sessionCount(drag.task)}
            className="shadow-lg"
          />
        </div>
      )}
    </div>
  );
}

const DropLine = () => <div className="h-0.5 rounded-full bg-primary" />;

function TaskCard({
  task,
  folder,
  sessions,
  lifted,
  className,
  onPointerDown,
  onOpen,
}: {
  task: Task;
  folder?: string;
  sessions: number;
  lifted?: boolean;
  className?: string;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onOpen?: () => void;
}) {
  const done = task.status === "done";
  return (
    <div
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.();
        }
      }}
      className={cn(
        "cursor-pointer rounded-lg border bg-card p-3 text-left shadow-xs transition-[opacity,box-shadow] outline-none select-none hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring",
        lifted && "opacity-40",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {done ? <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <PriorityBars priority={task.priority} className="mt-0.5" />}
        <p className={cn("min-w-0 flex-1 text-sm leading-snug font-medium break-words", done && "text-muted-foreground")}>{task.title}</p>
      </div>
      {task.description.trim() && (
        <p className="mt-1.5 line-clamp-2 pl-5.5 text-xs leading-relaxed text-muted-foreground">{task.description}</p>
      )}
      <div className="mt-2.5 flex items-center gap-3 pl-5.5 text-xs text-muted-foreground">
        <StatusLabel status={task.status} />
        <span className="flex-1" />
        {folder && (
          <span className="flex min-w-0 items-center gap-1" title={folder}>
            <FolderIcon className="size-3 shrink-0" />
            <span className="max-w-24 truncate">{folder}</span>
          </span>
        )}
        {sessions > 0 && (
          <span className="flex items-center gap-1" title={`${sessions} session${sessions === 1 ? "" : "s"}`}>
            <MessagesSquareIcon className="size-3" />
            {sessions}
          </span>
        )}
      </div>
    </div>
  );
}

// --- list ------------------------------------------------------------------------

function TaskList({
  columns,
  tasksIn,
  folderName,
  sessionCount,
  onOpen,
  empty,
  onAdd,
}: {
  columns: { id: ColumnId; label: string }[];
  tasksIn: (column: ColumnId) => Task[];
  folderName: (id: string | undefined) => string | undefined;
  sessionCount: (t: Task) => number;
  onOpen: (t: Task) => void;
  empty: boolean;
  onAdd: () => void;
}) {
  if (empty)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <KanbanIcon className="size-8" />
        <p>No tasks yet.</p>
        <Button size="sm" variant="outline" onClick={onAdd}>
          <PlusIcon />
          New task
        </Button>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      {columns.map((col) => {
        const tasks = tasksIn(col.id);
        if (tasks.length === 0) return null;
        return (
          <section key={col.id} className="mb-5">
            <div className="flex items-center gap-2 border-b px-2 py-2">
              <ColumnIcon id={col.id} />
              <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{col.label}</h2>
              <span className="text-[11px] text-muted-foreground tabular-nums">{tasks.length}</span>
            </div>
            <ul>
              {tasks.map((t) => {
                const folder = folderName(t.workspaceId);
                const sessions = sessionCount(t);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(t)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60"
                    >
                      {t.status === "done" ? (
                        <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <PriorityBars priority={t.priority} />
                      )}
                      <span className={cn("min-w-0 flex-1 truncate", t.status === "done" && "text-muted-foreground")}>{t.title}</span>
                      {folder && (
                        <span className="hidden max-w-32 items-center gap-1 truncate text-xs text-muted-foreground sm:flex">
                          <FolderIcon className="size-3 shrink-0" />
                          {folder}
                        </span>
                      )}
                      {sessions > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <MessagesSquareIcon className="size-3" />
                          {sessions}
                        </span>
                      )}
                      <span className="w-36 shrink-0 text-xs text-muted-foreground">
                        <StatusLabel status={t.status} />
                      </span>
                      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{relative(t.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function relative(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- icons -----------------------------------------------------------------------

const PRIORITY_COLOR: Record<Priority, string> = {
  low: "text-muted-foreground",
  medium: "text-amber-500",
  high: "text-red-500",
};

/** Signal bars: one, two or three lit. */
function PriorityBars({ priority, className }: { priority: Priority; className?: string }) {
  const lit = priority === "low" ? 1 : priority === "medium" ? 2 : 3;
  return (
    <svg viewBox="0 0 14 14" className={cn("size-3.5 shrink-0", PRIORITY_COLOR[priority], className)} aria-label={`${priority} priority`}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 4}
          y={10 - i * 3.5}
          width={2.5}
          height={2 + i * 3.5}
          rx={0.75}
          fill="currentColor"
          opacity={i < lit ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/** A ring filled as far as the status has come. */
function ProgressCircle({ fraction, className }: { fraction: number; className?: string }) {
  const r = 2.25;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className={cn("size-3.5 shrink-0", className)} aria-hidden>
      <circle cx={7} cy={7} r={5.5} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={fraction === 0 ? "2 2" : undefined} />
      {fraction > 0 && (
        <circle
          cx={7}
          cy={7}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={2 * r}
          strokeDasharray={`${fraction * c} ${c}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  switch (status) {
    case "todo":
      return <ProgressCircle fraction={0} className={cn("text-muted-foreground", className)} />;
    case "in-progress":
      return <ProgressCircle fraction={0.25} className={cn("text-violet-500", className)} />;
    case "review":
      return <ProgressCircle fraction={0.5} className={cn("text-blue-500", className)} />;
    case "blocked":
      return <TriangleAlertIcon className={cn("size-3.5 shrink-0 text-amber-500", className)} />;
    case "done":
      return <CircleCheckIcon className={cn("size-3.5 shrink-0 text-emerald-500", className)} />;
  }
}

function StatusLabel({ status }: { status: TaskStatus }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <StatusIcon status={status} />
      {STATUSES.find((s) => s.id === status)?.label}
    </span>
  );
}

function ColumnIcon({ id }: { id: ColumnId }) {
  if (id === "low" || id === "medium" || id === "high") return <PriorityBars priority={id} />;
  if (id === "done") return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />;
  return <StatusIcon status={id} />;
}

// --- dialog ----------------------------------------------------------------------

function TaskDialog({
  editing,
  onClose,
  workspaces,
  conversations,
  onStart,
  onOpenSession,
}: {
  editing: Editing | null;
  onClose: () => void;
  workspaces: Workspace[];
  conversations: Conversation[];
  onStart: (task: Task) => void;
  onOpenSession: (id: string) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const existing = editing && "task" in editing ? editing.task : null;
  useEffect(() => {
    if (!editing) return setDraft(null);
    const { title, description, priority, status, workspaceId } = "task" in editing ? editing.task : editing.draft;
    setDraft({ title, description, priority, status, workspaceId });
  }, [editing]);

  const sessions = existing
    ? existing.sessionIds
        .map((id) => conversations.find((c) => c.id === id))
        .filter((c): c is Conversation => !!c && c.messages.length > 0)
    : [];

  /** Saves the draft and returns the task as it now stands. */
  const save = (): Task | null => {
    if (!draft) return null;
    const workspaceId = draft.workspaceId && workspaces.some((w) => w.id === draft.workspaceId) ? draft.workspaceId : undefined;
    if (existing) {
      updateTask(existing.id, { ...draft, workspaceId });
      return { ...existing, ...draft, workspaceId, title: draft.title.trim() || existing.title };
    }
    return createTask({ ...draft, workspaceId });
  };
  const canSave = !!draft?.title.trim();

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            {existing ? "Change the task, or start a session to work on it." : "Add a task to the board."}
          </DialogDescription>
        </DialogHeader>
        {draft && (
          <form
            id="task-form"
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSave) return;
              save();
              onClose();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Checkout fails on Safari"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-description">Description</Label>
              <Textarea
                id="task-description"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What's wrong, what done looks like, anything a session should know."
                className="min-h-24"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Priority</Label>
                <Select value={draft.priority} onValueChange={(v) => setDraft({ ...draft, priority: v as Priority })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <PriorityBars priority={p.id} />
                        {p.label.replace(" priority", "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Status</Label>
                <Select value={draft.status} onValueChange={(v) => setDraft({ ...draft, status: v as TaskStatus })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <StatusIcon status={s.id} />
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Folder</Label>
                <Select
                  value={draft.workspaceId ?? NO_FOLDER}
                  onValueChange={(v) => setDraft({ ...draft, workspaceId: v === NO_FOLDER ? undefined : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FOLDER}>None (chat)</SelectItem>
                    {workspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {sessions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>Sessions</Label>
                <ul className="flex flex-col gap-0.5">
                  {sessions.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onOpenSession(c.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{c.title}</span>
                        <span className="text-xs text-muted-foreground">{relative(c.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </form>
        )}
        <DialogFooter className="sm:justify-between">
          {existing ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                deleteTask(existing.id);
                onClose();
              }}
            >
              <Trash2Icon />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!canSave}
              onClick={() => {
                const task = save();
                if (task) onStart(task);
              }}
            >
              <PlayIcon />
              {sessions.length > 0 ? "New session" : "Start session"}
            </Button>
            <Button type="submit" form="task-form" disabled={!canSave}>
              {existing ? "Save" : "Add task"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
