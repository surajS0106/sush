// The thread's sub-agents, docked on the composer's top edge like the pull
// request tray: how many there are and the latest news on the closed row,
// and when opened a row per agent with where it stands and how long it took.
// It lists the agents started since your last message, plus any older ones
// still working in the background. Clicking a row scrolls to its graph.

import type { DynamicToolUIPart } from "ai";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, SquareIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { agentState, childThreadId, describe, isActive, type AgentState, type ChildStatus } from "@/components/subagents";
import { PixelLoader } from "@/components/ui/loading-state";
import { SPAWN_AGENT, useRunningToolCalls } from "@/lib/agent";
import { threadMessages, useThreadStatuses } from "@/lib/sessions";
import type { SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";

const SPRING: Transition = { type: "spring", bounce: 0, duration: 0.4 };

/** Tools that change a file, and the input field naming it. */
const FILE_EDITS: Record<string, string> = { fs_write: "path", fs_edit: "path", fs_delete: "path", fs_move: "to" };

const STATE_LABEL: Record<AgentState, string> = {
  starting: "Starting",
  working: "Working",
  "needs-input": "Needs your input",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const STATE_TEXT: Record<AgentState, string> = {
  starting: "text-muted-foreground",
  working: "text-muted-foreground",
  "needs-input": "text-amber-600 dark:text-amber-400",
  done: "text-brand",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

function StateIcon({ state, className }: { state: AgentState; className?: string }) {
  const box = cn("flex size-4 shrink-0 items-center justify-center rounded-full", className);
  if (isActive(state) && state !== "needs-input") return <span className={box}><PixelLoader className="text-brand" /></span>;
  if (state === "needs-input") return <span className={cn(box, "bg-amber-500/15 text-amber-600 dark:text-amber-400")}><CircleAlertIcon className="size-3" /></span>;
  if (state === "done") return <span className={cn(box, "bg-brand/15 text-brand")}><CheckIcon className="size-2.5" strokeWidth={3} /></span>;
  if (state === "failed") return <span className={cn(box, "bg-destructive/15 text-destructive")}><XIcon className="size-2.5" strokeWidth={3} /></span>;
  return <span className={cn(box, "bg-muted text-muted-foreground")}><SquareIcon className="size-2 fill-current" /></span>;
}

/** Every `spawn_agent` call in the thread, with whether it came after the user's latest message. */
function spawnCalls(messages: SushUIMessage[]): { part: DynamicToolUIPart; recent: boolean }[] {
  // A background agent's report arrives as a user message, but it isn't the user writing.
  const lastHuman = messages.findLastIndex((m) => m.role === "user" && !m.metadata?.subagentReport && !m.metadata?.compaction);
  return messages.flatMap((m, i) =>
    m.role !== "assistant"
      ? []
      : m.parts.flatMap((p) =>
          p.type === "dynamic-tool" && p.toolName === SPAWN_AGENT ? [{ part: p as DynamicToolUIPart, recent: i > lastHuman }] : [],
        ),
  );
}

/** How long a sub-agent's thread has run, from its first message to its last (or now, while it works). */
function elapsed(threadId: string, active: boolean, now: number): number | undefined {
  const times = threadMessages(threadId)
    .map((m) => m.metadata?.createdAt)
    .filter((t): t is number => typeof t === "number");
  if (times.length === 0) return undefined;
  return Math.max((active ? now : Math.max(...times)) - Math.min(...times), 0);
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Files a sub-agent changed (successful edits, by path). */
function filesChanged(threadId: string): number {
  const paths = new Set<string>();
  for (const m of threadMessages(threadId)) {
    for (const p of m.parts) {
      if (p.type !== "dynamic-tool" || p.state !== "output-available") continue;
      const field = FILE_EDITS[p.toolName];
      const path = field && (p.input as Record<string, unknown> | undefined)?.[field];
      if (typeof path === "string") paths.add(path);
    }
  }
  return paths.size;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function AgentsTray({ threadId, messages }: { threadId: string; messages: SushUIMessage[] }) {
  const calls = useMemo(() => spawnCalls(messages), [messages]);
  const running = useRunningToolCalls();
  const statuses = useThreadStatuses(calls.map((c) => childThreadId(threadId, c.part.toolCallId))).split(",") as ChildStatus[];
  const all = calls.map((c, i) => ({ ...c, state: agentState(c.part, statuses[i] ?? "", running.has(c.part.toolCallId)) }));
  const agents = all.filter((a) => a.recent || isActive(a.state));
  const active = agents.filter((a) => isActive(a.state)).length;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Running times tick while any agent works.
  useEffect(() => {
    if (active === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  if (agents.length === 0) return null;

  // The closed row's news: whoever needs you, else the most recent to finish, else who's working.
  const news =
    agents.find((a) => a.state === "needs-input") ??
    agents.findLast((a) => !isActive(a.state)) ??
    agents.at(-1)!;
  // Up to three icons stacked: the states present, active first.
  const order: AgentState[] = ["needs-input", "working", "starting", "failed", "stopped", "done"];
  const icons = order.filter((s) => agents.some((a) => a.state === s)).slice(0, 3);

  const scrollTo = (callId: string) =>
    document.querySelector(`[data-agent-calls~="${CSS.escape(callId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      aria-label={`${plural(agents.length, "agent")}${active ? `, ${active} working` : ""}`}
      className="relative mx-3 -mb-3 rounded-t-2xl border border-b-0 border-foreground/8 bg-card/85 pb-3 text-xs shadow-xs backdrop-blur-sm dark:border-white/10"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-2 pr-2 pl-3.5 text-left"
      >
        <span className="flex shrink-0 items-center gap-1">
          {icons.map((s) => (
            <StateIcon key={s} state={s} />
          ))}
        </span>
        <span className="shrink-0 font-medium">{plural(agents.length, "agent")}</span>
        <span className={cn("min-w-0 truncate", STATE_TEXT[news.state])}>
          {describe(news.part)}: {STATE_LABEL[news.state].toLowerCase()}
        </span>
        <span className="flex-1" />
        {/* The tray stands on the composer and grows upward, so closed points up and open points down. */}
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
          <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200", !open && "rotate-180")} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="overflow-hidden"
          >
            <ul className="max-h-[40vh] overflow-y-auto border-t px-1.5 pt-1.5">
              {agents.map(({ part, state }) => {
                const child = childThreadId(threadId, part.toolCallId);
                const took = elapsed(child, isActive(state), now);
                const files = state === "done" ? filesChanged(child) : 0;
                return (
                  <li key={part.toolCallId}>
                    <button
                      type="button"
                      onClick={() => scrollTo(part.toolCallId)}
                      className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-accent"
                    >
                      <StateIcon state={state} />
                      <span className="min-w-0 truncate">{describe(part)}</span>
                      {!isActive(state) || state === "needs-input" ? (
                        <span className={cn("shrink-0 text-xs", STATE_TEXT[state])}>
                          {STATE_LABEL[state]}
                          {files > 0 && ` · ${plural(files, "file")} changed`}
                        </span>
                      ) : null}
                      <span className="flex-1" />
                      {took !== undefined && (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(took)}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
