// The model's current to-do list (`todo_write`, `lib/todos.ts`), docked on the
// composer's top edge like the agents and pull request trays, so the plan stays
// in view while the transcript scrolls on. The closed row shows progress and the
// step in progress; opened, the whole checklist. It shows the latest list since
// your last message while the run works or items are left, and goes once the
// run ends with everything done (the card in the transcript keeps the record).

import type { DynamicToolUIPart } from "ai";
import { ChevronDownIcon, CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { PixelLoader } from "@/components/ui/loading-state";
import type { RunStatus } from "@/lib/tauri";
import { parseTodos, TODO_WRITE, todoProgress, type Todo } from "@/lib/todos";
import type { SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";

const SPRING: Transition = { type: "spring", bounce: 0, duration: 0.4 };

/** The latest settled `todo_write` call since the user's last message, with its list. */
export function latestPlan(messages: SushUIMessage[]): { part: DynamicToolUIPart; todos: Todo[] } | null {
  // A background agent's report, Resume's note and the plan check arrive as user messages, but they aren't the user writing.
  const lastHuman = messages.findLastIndex((m) => m.role === "user" && !m.metadata?.subagentReport && !m.metadata?.resumed && !m.metadata?.compaction && !m.metadata?.planCheck);
  for (let i = messages.length - 1; i > lastHuman; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.type !== "dynamic-tool" || p.toolName !== TODO_WRITE || p.state !== "output-available") continue;
      const todos = parseTodos(p.input);
      if (todos && todos.length > 0) return { part: p as DynamicToolUIPart, todos };
    }
  }
  return null;
}

/** A ring filling with the share of items done. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-muted-foreground/25" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - (total ? done / total : 0))}
        className="stroke-brand transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

function ItemIcon({ todo, working }: { todo: Todo; working: boolean }) {
  if (todo.status === "completed") return <CircleCheckIcon className="size-4 shrink-0 text-brand" />;
  if (todo.status === "in_progress") {
    return working ? (
      <span className="flex size-4 shrink-0 items-center justify-center">
        <PixelLoader className="text-brand" />
      </span>
    ) : (
      <CircleDotIcon className="size-4 shrink-0" />
    );
  }
  return <CircleIcon className="size-4 shrink-0 text-muted-foreground/60" />;
}

export function PlanTray({ messages, status }: { messages: SushUIMessage[]; status: RunStatus }) {
  const plan = useMemo(() => latestPlan(messages), [messages]);
  const [open, setOpen] = useState(false);
  const working = status === "submitted" || status === "streaming";
  // An approval the run waits on sits just above the composer: the tray mustn't cover it.
  const waiting = status === "awaiting";
  useEffect(() => {
    if (waiting) setOpen(false);
  }, [waiting]);

  if (!plan) return null;
  const { todos } = plan;
  const { done, total } = todoProgress(todos);
  if (done === total && !working) return null;

  const index = todos.findIndex((t) => t.status === "in_progress");
  const current = index >= 0 ? todos[index] : undefined;
  const next = todos.find((t) => t.status === "pending");
  const label = current
    ? `Step ${index + 1} of ${total}: ${current.activeForm ?? current.content}`
    : done === total
      ? "Wrapping up"
      : `${done} of ${total} done${next && !working ? ` · next: ${next.content}` : ""}`;

  const scrollToCard = () =>
    document.querySelector(`[data-todo-call="${CSS.escape(plan.part.toolCallId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      aria-label={`Plan: ${done} of ${total} done`}
      className="relative mx-3 -mb-3 rounded-t-2xl border border-b-0 border-foreground/8 bg-card/85 pb-3 text-xs shadow-xs backdrop-blur-sm dark:border-white/10"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-2 pr-2 pl-3.5 text-left"
      >
        <ProgressRing done={done} total={total} />
        <span className="shrink-0 font-medium">Plan</span>
        <span className={cn("min-w-0 truncate", current ? "text-foreground/80" : "text-muted-foreground")}>{label}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {done}/{total}
        </span>
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
              {todos.map((t, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={scrollToCard}
                    className="flex min-h-8 w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent"
                  >
                    <span className="mt-px">
                      <ItemIcon todo={t} working={working} />
                    </span>
                    <span
                      className={cn(
                        t.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40",
                        t.status === "in_progress" && "font-medium",
                      )}
                    >
                      {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
