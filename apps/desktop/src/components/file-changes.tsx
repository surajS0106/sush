// The files a Cowork turn changed, under its reply: one row per file with
// its added/removed line counts and an Undo, expanding to a unified diff.
// A session watched from another machine has no folder here: no Undo or Open.

import { structuredPatch } from "diff";
import { ChevronRightIcon, FileIcon, FileMinusIcon, FilePlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { errorMessage, type FileDiff } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { openFile, undoTurn, useTurnDiff } from "@/lib/workspaces";

/** Lines of a big diff shown before "Show all". */
const PREVIEW_LINES = 300;

interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface FileStat {
  file: FileDiff;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function diffFile(file: FileDiff): FileStat {
  if (file.binary) return { file, lines: [], added: 0, removed: 0 };
  const patch = structuredPatch(file.path, file.path, file.before ?? "", file.after ?? "", "", "", { context: 3 });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  patch.hunks.forEach((hunk, h) => {
    if (h > 0 || hunk.oldStart > 1) lines.push({ kind: "gap", text: "" });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const raw of hunk.lines) {
      const text = raw.slice(1);
      if (raw.startsWith("+")) {
        lines.push({ kind: "add", text, newNo: newNo++ });
        added++;
      } else if (raw.startsWith("-")) {
        lines.push({ kind: "del", text, oldNo: oldNo++ });
        removed++;
      } else if (raw.startsWith(" ")) {
        lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
      }
      // "\ No newline at end of file" carries no content.
    }
  });
  return { file, lines, added, removed };
}

interface FileChangesProps {
  threadId: string;
  /** None for a session watched from another machine: its diff comes from the host, and nothing here can change it. */
  workspaceId?: string;
  /** The user message that started the turn. */
  turnId: string;
}

export function FileChanges({ threadId, workspaceId, turnId }: FileChangesProps) {
  const diff = useTurnDiff(threadId, turnId);
  const stats = useMemo(() => diff?.map(diffFile) ?? [], [diff]);
  if (stats.length === 0) return null;

  const undo = (path?: string) => {
    if (!workspaceId) return;
    const what = path ?? (stats.length === 1 ? stats[0].file.path : `${stats.length} files`);
    if (!window.confirm(`Put back ${what} as before this turn? Later changes to the same files are undone too.`)) return;
    undoTurn(threadId, workspaceId, turnId, path)
      .then((r) => {
        if (r.failed.length > 0) toast.error(`Couldn’t restore ${r.failed.length} file(s)`, { description: r.failed.join("\n") });
        else toast.success(`Restored ${r.restored.length === 1 ? r.restored[0] : `${r.restored.length} files`}`);
      })
      .catch((e) => toast.error(errorMessage(e)));
  };

  const added = stats.reduce((n, s) => n + s.added, 0);
  const removed = stats.reduce((n, s) => n + s.removed, 0);
  return (
    <div className="overflow-hidden rounded-xl border bg-card text-sm">
      {stats.length > 1 && (
        <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{stats.length} files changed</span>
          <Counts added={added} removed={removed} />
          {workspaceId && <UndoButton className="ml-auto" onClick={() => undo()} label="Undo all" />}
        </div>
      )}
      {stats.map((s) => (
        <FileRow key={s.file.path} stat={s} workspaceId={workspaceId} onUndo={() => undo(s.file.path)} />
      ))}
    </div>
  );
}

function FileRow({ stat, workspaceId, onUndo }: { stat: FileStat; workspaceId?: string; onUndo: () => void }) {
  const [open, setOpen] = useState(false);
  const { file, added, removed } = stat;
  const created = !file.binary && file.before === null;
  const deleted = !file.binary && file.after === null;
  const Icon = created ? FilePlusIcon : deleted ? FileMinusIcon : FileIcon;
  const expandable = stat.lines.length > 0;
  return (
    <div className="border-b last:border-b-0">
      <div className="group/row flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          disabled={!expandable}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate" title={file.path}>
            {file.path}
          </span>
          {(created || deleted || file.binary) && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
              {created ? "new" : deleted ? "deleted" : "binary"}
            </span>
          )}
        </button>
        {!deleted && workspaceId && (
          <button
            type="button"
            onClick={() => openFile(workspaceId, file.path)}
            className="shrink-0 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            Open
          </button>
        )}
        {workspaceId && <UndoButton onClick={onUndo} />}
        {!file.binary && <Counts added={added} removed={removed} />}
        <button
          type="button"
          aria-label={open ? "Hide changes" : "Show changes"}
          disabled={!expandable}
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && <DiffView lines={stat.lines} />}
    </div>
  );
}

function UndoButton({ onClick, label = "Undo", className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", className)}
    >
      {label}
    </button>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-green-700 dark:text-green-400">+{added}</span>
      <span className="text-red-700 dark:text-red-400">−{removed}</span>
    </span>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, PREVIEW_LINES);
  return (
    <div className="max-h-96 overflow-auto border-t bg-background font-mono text-xs leading-5">
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((l, i) =>
            l.kind === "gap" ? (
              <tr key={i} className="bg-muted/40 text-muted-foreground">
                <td colSpan={4} className="px-3 select-none">
                  ⋯
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                className={cn(
                  l.kind === "add" && "bg-green-500/10 text-green-900 dark:text-green-200",
                  l.kind === "del" && "bg-red-500/10 text-red-900 dark:text-red-200",
                )}
              >
                <td className="w-10 px-2 text-right align-top text-muted-foreground/70 select-none">{l.oldNo}</td>
                <td className="w-10 px-2 text-right align-top text-muted-foreground/70 select-none">{l.newNo}</td>
                <td className="w-4 align-top select-none opacity-60">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</td>
                <td className="pr-3 whitespace-pre-wrap break-all">{l.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {!all && lines.length > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t py-1.5 font-sans text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          Show {lines.length - PREVIEW_LINES} more lines
        </button>
      )}
    </div>
  );
}
