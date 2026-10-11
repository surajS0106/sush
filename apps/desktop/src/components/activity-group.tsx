// Finished tool calls, and the thinking between them, collapse into one line
// ("Read 3 files and ran 2 commands") that expands to the individual steps.
// Calls still running or waiting for the user stay visible on their own.

import type { DynamicToolUIPart } from "ai";
import { ChevronRightIcon, ListTreeIcon } from "lucide-react";
import { useState } from "react";

import { toolKind } from "@/lib/agent";
import { ARTIFACT_WRITE } from "@/lib/artifacts";
import type { SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";

type Part = SushUIMessage["parts"][number];

/** Settled calls whose results are a line, not a card the user acts on. */
function groupableTool(p: Part): p is DynamicToolUIPart {
  if (p.type !== "dynamic-tool" || p.toolName === ARTIFACT_WRITE) return false;
  const kind = toolKind(p.toolName);
  return kind !== "ask-user" && kind !== "skill-save" && (p.state === "output-available" || p.state === "output-error");
}

function groupable(p: Part) {
  return p.type === "step-start" || (p.type === "reasoning" && p.state !== "streaming") || groupableTool(p);
}

/**
 * Part indices to render, with runs of finished activity as arrays. A run
 * becomes a group when it holds a tool call and at least two visible steps.
 */
export function groupParts(parts: Part[]): (number | number[])[] {
  const out: (number | number[])[] = [];
  let run: number[] = [];
  const flush = () => {
    const tools = run.filter((i) => parts[i].type === "dynamic-tool").length;
    const visible = run.filter((i) => {
      const p = parts[i];
      return p.type === "dynamic-tool" || (p.type === "reasoning" && !!p.text);
    }).length;
    if (tools > 0 && visible >= 2) out.push(run);
    else out.push(...run);
    run = [];
  };
  parts.forEach((p, i) => {
    if (groupable(p)) run.push(i);
    else {
      flush();
      out.push(i);
    }
  });
  flush();
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** "Read 3 files, searched twice and ran a command". */
export function activitySummary(parts: Part[]): { text: string; failed: number } {
  const count = { read: 0, search: 0, edit: 0, command: 0, memory: 0, chats: 0, skill: 0, other: 0 };
  let failed = 0;
  for (const p of parts) {
    if (p.type !== "dynamic-tool") continue;
    if (p.state === "output-error") failed++;
    const name = p.toolName;
    if (name === "fs_read") count.read++;
    else if (name === "fs_list" || name === "fs_glob" || name === "fs_search") count.search++;
    else if (name === "fs_write" || name === "fs_edit" || name === "fs_move" || name === "fs_delete") count.edit++;
    else if (name === "shell_run") count.command++;
    else {
      const kind = toolKind(name);
      if (kind === "memory") count.memory++;
      else if (kind === "chats") count.chats++;
      else if (kind === "skill") count.skill++;
      else count.other++;
    }
  }
  const phrases = [
    count.read && `read ${plural(count.read, "a file", "files")}`,
    count.search && `searched ${count.search === 1 ? "the folder" : `${count.search} times`}`,
    count.edit && `edited ${plural(count.edit, "a file", "files")}`,
    count.command && `ran ${plural(count.command, "a command", "commands")}`,
    count.memory && "updated memory",
    count.chats && "looked through past chats",
    count.skill && `used ${plural(count.skill, "a skill", "skills")}`,
    count.other && `used ${plural(count.other, "a tool", "tools")}`,
  ].filter((s): s is string => !!s);
  const joined = phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}` : (phrases[0] ?? "worked");
  return { text: joined[0].toUpperCase() + joined.slice(1), failed };
}

export function ActivityGroup({ parts, children }: { parts: Part[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { text, failed } = activitySummary(parts);
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ListTreeIcon className="size-4 shrink-0" />
        <span className="text-left">{text}</span>
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="mt-2 ml-2 flex flex-col gap-3 border-l pl-4">{children}</div>}
    </div>
  );
}
