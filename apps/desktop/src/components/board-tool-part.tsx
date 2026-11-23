// How the Board tools (`lib/board-tools.ts`) show in a chat: a search as one line,
// a write as a card listing each task change to approve or discard.

import type { DynamicToolUIPart } from "ai";
import { KanbanIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ToolResultRow } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { runsWithoutApproval, type ToolResult } from "@/lib/agent";
import { focusTask, getTasks, useTasks, type Task } from "@/lib/board";
import {
  applyBoardWrite,
  BOARD_SEARCH,
  planBoardWrite,
  TASK_FIELD_LABELS,
  taskFieldText,
  writtenTaskIds,
  type PlannedTaskChange,
} from "@/lib/board-tools";
import { openBoard } from "@/lib/library";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";

const DISCARDED = "The user discarded these changes. Don't make them; ask what they'd like instead if it isn't clear.";

export function BoardToolPart({
  part,
  canAnswer,
  onResult,
  running,
}: {
  part: DynamicToolUIPart;
  canAnswer: boolean;
  onResult: (result: ToolResult) => void;
  running: boolean;
}) {
  const row = (text: string, error?: boolean, detail?: string) => (
    <ToolResultRow
      error={error}
      detail={detail}
      label={
        <>
          <KanbanIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );

  if (part.toolName === BOARD_SEARCH) {
    if (part.state === "input-streaming" || part.state === "input-available") return <LoadingState label="Looking at your Board" />;
    if (part.state === "output-error") return row("Couldn't look at your Board", true, part.errorText);
    let summary = "Looked at your Board";
    try {
      const out = JSON.parse(String(part.output));
      if (typeof out.matched === "number") summary = `Looked at your Board · ${out.matched} ${out.matched === 1 ? "task" : "tasks"}`;
    } catch {
      // A summary without the count.
    }
    return row(summary, false, String(part.output));
  }

  if (part.state === "input-streaming") return <LoadingState label="Drafting Board changes" />;
  if (part.state === "output-available") return <UpdatedRow input={part.input} output={part.output} />;
  if (part.state === "output-error") return row(part.errorText === DISCARDED ? "Board changes discarded" : "Board not changed", part.errorText !== DISCARDED, part.errorText);
  if (running || runsWithoutApproval(part.toolName)) return <LoadingState label="Updating your Board" />;
  if (!canAnswer) return <p className="text-sm text-muted-foreground italic">Board wasn't changed</p>;
  return <WriteCard input={part.input} onResult={onResult} />;
}

/** "Updated your Board", with a link to the task it touched (still on the Board), or to the Board for several. */
function UpdatedRow({ input, output }: { input: unknown; output: unknown }) {
  const tasks = useTasks();
  const ids = useMemo(() => writtenTaskIds(input, output), [input, output]);
  const live = ids.filter((id) => tasks.some((t) => t.id === id));
  const one = live.length === 1 ? live[0] : null;
  return (
    <ToolResultRow
      detail={String(output)}
      label={
        <>
          <KanbanIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">Updated your Board</span>
        </>
      }
      action={
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            if (one) focusTask(one);
            openBoard();
          }}
        >
          {one ? "Open task" : "Open Board"}
        </button>
      }
    />
  );
}

function WriteCard({ input, onResult }: { input: unknown; onResult: (r: ToolResult) => void }) {
  const folders = useWorkspaces();
  // Planned once and kept: a later edit on the Board shouldn't reshuffle the card.
  const plan = useMemo(() => planBoardWrite(input, getTasks(), folders), [input]);
  const sent = useRef(false);
  useEffect(() => {
    if (!plan.ok && !sent.current) {
      sent.current = true;
      onResult({ errorText: plan.error });
    }
  }, [plan, onResult]);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!plan.ok) return null;
  const kept = plan.changes.filter((_, i) => !skipped.has(i));
  const only = plan.changes.length === 1 ? plan.changes[0] : null;
  const title = only
    ? only.action === "add"
      ? "Add this task to your Board?"
      : only.action === "delete"
        ? "Delete this task?"
        : "Change this task?"
    : `Make these ${plan.changes.length} changes to your Board?`;

  const apply = () => {
    setBusy(true);
    const result = applyBoardWrite(kept);
    const dropped = plan.changes.filter((_, i) => skipped.has(i));
    if ("output" in result && dropped.length) {
      result.output = `${result.output} The user left out ${dropped.length} of the proposed changes: ${dropped.map((c) => `"${c.after.title}"`).join(", ")}.`;
    }
    onResult(result);
  };

  return (
    <div className="w-full max-w-xl">
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <div className="flex gap-3 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
            <KanbanIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{title}</div>
            <ul className="mt-2 flex max-h-80 flex-col divide-y overflow-y-auto">
              {plan.changes.map((c, i) => (
                <ChangeRow
                  key={i}
                  change={c}
                  on={!skipped.has(i)}
                  canToggle={plan.changes.length > 1}
                  onToggle={() =>
                    setSkipped((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 border-t p-2">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => onResult({ errorText: DISCARDED })} disabled={busy}>
            Discard
          </Button>
          <Button
            size="sm"
            variant={only?.action === "delete" ? "destructive" : "default"}
            className="rounded-full"
            onClick={apply}
            disabled={busy || kept.length === 0}
          >
            {only?.action === "delete" ? "Delete" : kept.length === plan.changes.length ? "Apply" : `Apply ${kept.length}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChangeRow({ change, on, canToggle, onToggle }: { change: PlannedTaskChange; on: boolean; canToggle: boolean; onToggle: () => void }) {
  const folders = useWorkspaces();
  const fields: (keyof Task)[] =
    change.action === "add"
      ? (["priority", "status", "workspaceId", "description"] as (keyof Task)[]).filter((f) => !!taskFieldText(change.after, f, folders))
      : change.action === "update"
        ? change.changed.filter((f) => f !== "title" || change.before?.title !== change.after.title)
        : [];
  const verb = change.action === "add" ? "New task" : change.action === "delete" ? "Delete" : "Update";
  return (
    <li className={cn("flex gap-3 py-2", !on && "opacity-50")}>
      {canToggle && <input type="checkbox" checked={on} onChange={onToggle} aria-label={`Include ${change.after.title}`} className="mt-1 size-4 accent-brand" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className={cn("text-muted-foreground", change.action === "delete" && "text-destructive")}>{verb} </span>
          <span className={cn("font-medium", change.action === "delete" && "line-through")}>{change.after.title}</span>
        </p>
        {fields.length > 0 && (
          <dl className="mt-1 grid grid-cols-[96px_1fr] gap-x-2 gap-y-0.5 text-xs">
            {fields.map((f) => {
              const before = change.before ? taskFieldText(change.before, f, folders) : "";
              const after = taskFieldText(change.after, f, folders);
              return (
                <div key={f} className="contents">
                  <dt className="truncate text-muted-foreground">{TASK_FIELD_LABELS[f] ?? f}</dt>
                  <dd className={cn("min-w-0 wrap-break-word", f === "description" && "line-clamp-3 whitespace-pre-wrap")}>
                    {change.action === "update" && (
                      <>
                        <span className="text-muted-foreground line-through decoration-muted-foreground/50">{before || "empty"}</span>
                        <span className="text-muted-foreground"> → </span>
                      </>
                    )}
                    <span className={cn(!after && "text-muted-foreground")}>{after || "cleared"}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
    </li>
  );
}
