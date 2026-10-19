// Cowork's pull request card: the session's branch against the branch it
// merges into, drawn as a commit graph, with whether it merges cleanly (the
// conflicting lines on hover), the checks the model ran, and the pull
// request's state. The model shows it with branch_status; the latest call's
// card stays live, reading git again whenever files change, and a chip above
// the composer carries its status.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { DynamicToolUIPart } from "ai";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  MinusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BRANCH_STATUS } from "@/lib/agent";
import { ago, edgePath, layout, laneX, rowY, type GraphGeometry } from "@/lib/commit-graph";
import { sendMessage, useSessionStatus } from "@/lib/sessions";
import type { BranchConflict, BranchStatus, GraphCommit } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";
import { CurrentWorkspace, useBranchStatus } from "@/lib/workspaces";

// --- what the model passes ------------------------------------------------------------

type PrState = "open" | "draft" | "merged" | "closed";
type CheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

interface Check {
  name: string;
  status: CheckStatus;
  summary?: string;
  detail?: string;
}

interface CardInput {
  base?: string;
  title?: string;
  pr?: { number?: number; url?: string; state: PrState };
  checks: Check[];
}

const PR_STATES = new Set<PrState>(["open", "draft", "merged", "closed"]);
const CHECK_STATUSES = new Set<CheckStatus>(["pending", "running", "passed", "failed", "skipped"]);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function parseInput(input: unknown): CardInput {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pr = typeof args.pr === "object" && args.pr !== null ? (args.pr as Record<string, unknown>) : undefined;
  const checks = Array.isArray(args.checks) ? args.checks : [];
  return {
    base: text(args.base),
    title: text(args.title),
    pr:
      pr && PR_STATES.has(pr.state as PrState)
        ? { number: typeof pr.number === "number" ? pr.number : undefined, url: text(pr.url), state: pr.state as PrState }
        : undefined,
    checks: checks.flatMap((c) => {
      const check = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
      const name = text(check.name);
      if (!name || !CHECK_STATUSES.has(check.status as CheckStatus)) return [];
      return [{ name, status: check.status as CheckStatus, summary: text(check.summary), detail: text(check.detail) }];
    }),
  };
}

/** The thread's live card: its latest branch_status call that didn't fail. */
export function latestBranchCall(messages: SushUIMessage[]): { messageId: string; part: DynamicToolUIPart } | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.type === "dynamic-tool" && part.toolName === BRANCH_STATUS && part.state !== "output-error") {
        return { messageId: messages[m].id, part };
      }
    }
  }
  return null;
}

// --- where the branch stands --------------------------------------------------------

type Tone = "neutral" | "progress" | "warn" | "bad" | "good" | "merged";

interface Verdict {
  tone: Tone;
  /** The card's footer, and the composer chip. */
  label: string;
  /** Short, beside "Merge into main". */
  merge: string;
  /** A button that asks the model to take the next step. */
  action?: { label: string; prompt: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function verdict(input: CardInput, s: BranchStatus, checksCurrent: boolean): Verdict {
  const base = s.base;
  if (input.pr?.state === "merged") return { tone: "merged", label: `Merged into ${base}`, merge: "merged" };
  if (input.pr?.state === "closed") return { tone: "neutral", label: "Pull request closed", merge: "closed" };
  if (s.merging) {
    const left = s.merging.unresolved.length;
    return left > 0
      ? { tone: "warn", label: `Resolving conflicts · ${left} ${left === 1 ? "file" : "files"} left`, merge: "resolving" }
      : { tone: "progress", label: "Conflicts resolved", merge: "resolving", action: { label: "Finish merge", prompt: "Finish the merge." } };
  }
  if (s.conflicts && s.conflicts.length > 0) {
    const n = plural(s.conflicts.length, "conflict");
    return {
      tone: "warn",
      label: `${n} with ${base}`,
      merge: n,
      action: { label: "Resolve conflicts", prompt: `Merge ${base} into this branch and resolve the conflicts.` },
    };
  }
  const checks = checksCurrent ? input.checks : [];
  const failed = checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    return {
      tone: "bad",
      label: `${plural(failed.length, "check")} failed`,
      merge: "blocked",
      action: { label: "Fix", prompt: `Fix the failing ${failed.map((c) => c.name).join(", ")}.` },
    };
  }
  const running = checks.filter((c) => c.status === "running" || c.status === "pending");
  if (running.length > 0) {
    return { tone: "progress", label: `Running ${running.map((c) => c.name.toLowerCase()).join(", ")}`, merge: "checking" };
  }
  if (s.uncommitted > 0) {
    return {
      tone: "neutral",
      label: `${plural(s.uncommitted, "uncommitted file")}`,
      merge: "uncommitted",
      action: { label: "Commit", prompt: "Commit the changes." },
    };
  }
  if (s.ahead === 0) return { tone: "neutral", label: `No commits ahead of ${base}`, merge: "nothing yet" };
  return {
    tone: "good",
    label: "Ready to merge",
    merge: "ready",
    action: { label: "Merge", prompt: input.pr ? "Merge the pull request." : `Merge this branch into ${base}.` },
  };
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-500",
  bad: "text-red-600 dark:text-red-500",
  good: "text-green-600 dark:text-green-500",
  merged: "text-violet-600 dark:text-violet-400",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  progress: "bg-muted-foreground/50",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  good: "bg-green-500",
  merged: "bg-violet-500",
};

/** The card's data: the call's input and git's live view of the branch. */
function useCard(workspaceId: string | undefined, part: DynamicToolUIPart) {
  const input = useMemo(() => parseInput(part.input), [part.input]);
  // Read again when the call settles, besides whenever files change.
  const { status, error } = useBranchStatus(workspaceId, input.base, part.state);
  // Checks belong to the commit they ran on; the output starts with `HEAD <sha>`.
  const reportedAt = typeof part.output === "string" ? /^HEAD ([0-9a-f]{7,40})/.exec(part.output)?.[1] : undefined;
  const checksCurrent = !status || !reportedAt || reportedAt === status.head;
  const judged = status ? verdict(input, status, checksCurrent) : null;
  return { input, status, error, checksCurrent, verdict: judged };
}

// --- motion -------------------------------------------------------------------------

const SPRING: Transition = { type: "spring", bounce: 0, duration: 0.4 };
const FADE: Transition = { duration: 0.2, ease: "easeOut" };

/** Crossfades its content whenever `id` changes. */
function Swap({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={id}
        initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
        transition={FADE}
        className={cn("inline-flex min-w-0 items-center gap-2", className)}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}

/** Glides to the height of its content as that changes. */
function AutoHeight({ children }: { children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div initial={false} animate={{ height }} transition={SPRING} className="-mx-1 overflow-hidden px-1">
      <div ref={inner} className="pb-0.5">
        {children}
      </div>
    </motion.div>
  );
}

// --- the card -------------------------------------------------------------------------

export function BranchCard({ part, threadId }: { part: DynamicToolUIPart; threadId: string }) {
  const workspace = useContext(CurrentWorkspace);
  const { input, status, error, checksCurrent, verdict: v } = useCard(workspace?.id, part);
  const session = useSessionStatus(threadId);
  const checking = part.state === "input-streaming" || part.state === "input-available";

  const title = input.title ?? status?.commits.find((c) => !c.onBase)?.subject ?? status?.branch ?? "This branch";
  const merged = input.pr?.state === "merged";

  const action = !checking ? v?.action : undefined;

  return (
    <motion.article
      id={`branch-card-${part.toolCallId}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="w-full rounded-2xl border bg-card p-4 text-sm text-card-foreground shadow-sm"
      aria-label={`Pull request: ${title}`}
    >
      <header className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">
          <Swap id={title} className="inline">
            {title}
          </Swap>
          {input.pr?.number !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">#{input.pr.number}</span>}
        </h3>
        {input.pr ? (
          <Swap id={input.pr.state} className="shrink-0">
            <PrBadge state={input.pr.state} />
          </Swap>
        ) : (
          status?.branch && <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">{status.branch}</span>
        )}
      </header>

      <AutoHeight>
        {!status ? (
          error ? (
            <p className="mt-3 text-muted-foreground">{error}</p>
          ) : (
            <LoadingState label="Reading the branch" className="mt-3" />
          )
        ) : (
          <>
            <Graph status={status} verdict={v!} merged={merged} />
            <Checks checks={input.checks} current={checksCurrent} />
            <footer className="mt-3 flex min-h-8 items-center gap-2">
              {checking ? (
                <Swap id="checking" className="text-muted-foreground">
                  <Spinner className="size-3.5" /> Checking the branch
                </Swap>
              ) : (
                <Status verdict={v!} status={status} busy={session === "working"} />
              )}
              <span className="flex-1" />
              {input.pr?.url && (
                <button
                  type="button"
                  onClick={() => void openUrl(input.pr!.url!)}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-accent"
                >
                  {/github\.com/.test(input.pr.url) ? "GitHub" : "Open"} <ArrowUpRightIcon className="size-3.5" />
                </button>
              )}
              <AnimatePresence mode="popLayout" initial={false}>
                {action && (
                  <motion.button
                    key={action.label}
                    type="button"
                    layout
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={FADE}
                    disabled={session !== null}
                    onClick={() => sendMessage(threadId, action.prompt, [])}
                    className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-brand/10 px-3 text-xs font-medium text-brand transition-colors hover:bg-brand/15 disabled:opacity-60"
                  >
                    {session === "working" ? <Spinner className="size-3.5" /> : action.label === "Merge" && <GitMergeIcon className="size-3.5" />}
                    {action.label}
                  </motion.button>
                )}
              </AnimatePresence>
            </footer>
          </>
        )}
      </AutoHeight>
    </motion.article>
  );
}

function PrBadge({ state }: { state: PrState }) {
  const tone: Record<PrState, [string, string]> = {
    open: ["Open", "text-green-600 dark:text-green-500 before:bg-green-500"],
    draft: ["Draft", "text-muted-foreground before:bg-muted-foreground/60"],
    merged: ["Merged", "text-violet-600 dark:text-violet-400 before:bg-violet-500"],
    closed: ["Closed", "text-red-600 dark:text-red-500 before:bg-red-500"],
  };
  const [label, className] = tone[state];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium before:size-1.5 before:rounded-full", className)}>
      {label}
    </span>
  );
}

/** The footer's status line; conflicts show their lines on hover. */
function Status({ verdict: v, status, busy }: { verdict: Verdict; status: BranchStatus; busy: boolean }) {
  const icon =
    busy && (v.tone === "warn" || v.tone === "progress") ? (
      <Spinner className="size-3.5 text-muted-foreground" />
    ) : v.tone === "merged" ? (
      <GitMergeIcon className={cn("size-3.5", TONE_TEXT.merged)} />
    ) : v.tone === "good" ? (
      <CheckIcon className={cn("size-3.5", TONE_TEXT.good)} />
    ) : v.tone === "warn" ? (
      <TriangleAlertIcon className={cn("size-3.5", TONE_TEXT.warn)} />
    ) : v.tone === "bad" ? (
      <CircleXIcon className={cn("size-3.5", TONE_TEXT.bad)} />
    ) : v.tone === "progress" ? (
      <Spinner className="size-3.5 text-muted-foreground" />
    ) : (
      <MinusIcon className="size-3.5 text-muted-foreground" />
    );
  const conflicts = !status.merging && status.conflicts && status.conflicts.length > 0 ? status.conflicts : null;
  return (
    <Swap id={`${v.tone}:${v.label}:${busy}`}>
      {icon}
      {conflicts ? (
        <span className="truncate">
          <ConflictPopover conflicts={conflicts} base={status.base}>
            <span className={cn("cursor-default underline decoration-dotted underline-offset-4", TONE_TEXT.warn)}>
              {plural(conflicts.length, "conflict")}
            </span>
          </ConflictPopover>{" "}
          with {status.base}
        </span>
      ) : (
        <span className={cn("truncate", v.tone === "good" || v.tone === "merged" ? "text-foreground" : TONE_TEXT[v.tone])}>
          {v.label}
        </span>
      )}
    </Swap>
  );
}

function ConflictPopover({ conflicts, base, children }: { conflicts: BranchConflict[]; base: string; children: React.ReactNode }) {
  const by = conflicts.find((c) => c.by)?.by;
  const theirs = by?.split(/\s+/)[0] ?? base;
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-[min(34rem,90vw)] p-0">
        <p className="border-b px-3.5 py-2.5 text-muted-foreground">
          <span className="font-medium text-foreground">{by ?? base}</span> changed the same lines on {base}
        </p>
        <div className="max-h-80 divide-y overflow-y-auto">
          {conflicts.map((c) =>
            c.hunks.length === 0 ? (
              <p key={c.path} className="px-3.5 py-2.5">
                <span className="font-medium">{c.path}</span> <span className="text-muted-foreground">changed on both sides</span>
              </p>
            ) : (
              c.hunks.map((h, i) => (
                <div key={`${c.path}-${i}`} className="px-3.5 py-2.5">
                  <p>
                    <span className="font-medium">{c.path}</span> <span className="text-muted-foreground">line {h.line}</span>
                  </p>
                  <Side who={theirs} lines={h.theirs} className="border-amber-400" />
                  <Side who="You" lines={h.ours} className="border-sky-400" />
                </div>
              ))
            ),
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function Side({ who, lines, className }: { who: string; lines: string[]; className: string }) {
  return (
    <div className={cn("mt-1.5 flex gap-3 border-l-2 pl-2.5 font-mono text-xs leading-5", className)}>
      <span className="w-10 shrink-0 truncate font-sans text-muted-foreground">{who}</span>
      <pre className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre">
        {lines.length > 0 ? lines.join("\n") : <span className="font-sans text-muted-foreground italic">removed</span>}
      </pre>
    </div>
  );
}

function Checks({ checks, current }: { checks: Check[]; current: boolean }) {
  const icon = (s: CheckStatus) =>
    s === "passed" ? (
      <CheckIcon className="size-3 text-green-600 dark:text-green-500" />
    ) : s === "failed" ? (
      <CircleXIcon className="size-3 text-red-600 dark:text-red-500" />
    ) : s === "running" ? (
      <Spinner className="size-3 text-muted-foreground" />
    ) : s === "skipped" ? (
      <MinusIcon className="size-3 text-muted-foreground" />
    ) : (
      <CircleDashedIcon className="size-3 text-muted-foreground" />
    );
  if (checks.length === 0) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: current ? 1 : 0.6 }}
      transition={FADE}
      className="mt-3 flex flex-wrap gap-1.5"
    >
      <AnimatePresence initial={false}>
        {checks.map((c) => {
          const tip = [c.detail, !current && "From before the latest changes"].filter(Boolean).join(" · ");
          const chip = (
            <motion.span
              key={c.name}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={SPRING}
              className="inline-flex h-6 items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs"
            >
              <Swap id={c.status} className="gap-0">
                {icon(c.status)}
              </Swap>
              <span className="font-medium">{c.name}</span>
              <Swap id={c.summary ?? c.status} className="text-muted-foreground">
                {c.summary ?? c.status}
              </Swap>
            </motion.span>
          );
          return tip ? (
            <Tooltip key={c.name}>
              <TooltipTrigger asChild>{chip}</TooltipTrigger>
              <TooltipContent>{tip}</TooltipContent>
            </Tooltip>
          ) : (
            chip
          );
        })}
      </AnimatePresence>
    </motion.div>
  );
}

// --- the commit graph -------------------------------------------------------------------

const ROW = 28;
const LANE = 12;
const PAD = 7;
/** Commit rows shown before "Show more". */
const FOLDED = 9;

type Kind = "ours" | "base" | "other";

interface Row {
  key: string;
  parents: string[];
  /** The "Merge into main" row and the uncommitted work above the branch's tip. */
  special?: "merge" | "work";
  commit?: GraphCommit;
  kind: Kind;
}

const GEOMETRY: GraphGeometry = { row: ROW, lane: LANE, pad: PAD };
const x = (col: number) => laneX(GEOMETRY, col);
const y = (row: number) => rowY(GEOMETRY, row);

function buildRows(s: BranchStatus): Row[] {
  const shas = new Map(s.commits.map((c) => [c.sha, c]));
  // The branch's own line: HEAD and its first parents.
  const mainline = new Set<string>();
  for (let c = shas.get(s.head); c && !c.onBase; c = shas.get(c.parents[0])) mainline.add(c.sha);
  const rows: Row[] = [{ key: "~merge", parents: [s.uncommitted > 0 ? "~work" : s.head], special: "merge", kind: "ours" }];
  if (s.uncommitted > 0) rows.push({ key: "~work", parents: [s.head], special: "work", kind: "ours" });
  for (const c of s.commits) {
    rows.push({ key: c.sha, parents: c.parents, commit: c, kind: c.onBase ? "base" : mainline.has(c.sha) ? "ours" : "other" });
  }
  return rows;
}

function Graph({ status: s, verdict: v, merged }: { status: BranchStatus; verdict: Verdict; merged: boolean }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => buildRows(s), [s]);
  const { cols, edges: laid, lanes } = useMemo(() => layout(rows), [rows]);
  const edges = laid.map((e) => ({ ...e, kind: rows[e.to].kind, dashed: !!rows[e.from].special }));
  const special = rows.filter((r) => r.special).length;
  const shown = open ? rows.length : Math.min(rows.length, special + FOLDED);
  const hidden = rows.length - shown;
  const width = PAD * 2 + (lanes - 1) * LANE;
  const color: Record<Kind, string> = {
    ours: merged ? "text-violet-500" : "text-brand",
    base: "text-muted-foreground/45",
    other: "text-teal-500",
  };

  // Colours fade between states (blue to violet on merge, amber to green).
  const fade = "transition-[color,fill,stroke] duration-500";

  return (
    <div className="mt-2.5">
      <div className="relative" style={{ paddingLeft: width + 6 }}>
        <motion.svg
          className="pointer-events-none absolute top-0 left-0 overflow-hidden"
          initial={false}
          animate={{ height: shown * ROW, width }}
          transition={SPRING}
          aria-hidden
        >
          <AnimatePresence initial={false}>
            {edges.map((e) => {
              const d = edgePath(GEOMETRY, e, cols);
              const key = `${rows[e.from].key}>${rows[e.to].key}`;
              return (
                <motion.path
                  key={key}
                  initial={e.dashed ? { d, opacity: 0 } : { d, opacity: 0, pathLength: 0 }}
                  animate={e.dashed ? { d, opacity: 1 } : { d, opacity: 1, pathLength: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ ...SPRING, pathLength: { duration: 0.5, ease: "easeOut" } }}
                  fill="none"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  strokeDasharray={e.dashed ? "2 3" : undefined}
                  className={cn(fade, color[e.kind])}
                />
              );
            })}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {rows.slice(0, shown).map((r, i) => {
              const [cx, cy] = [x(cols[i]), y(i)];
              const special = r.special === "merge";
              const hollow = r.special === "work" || (r.commit?.parents.length ?? 0) > 1;
              return (
                <motion.circle
                  key={r.key}
                  initial={{ cx, cy, r: 0 }}
                  animate={{ cx, cy, r: special ? 5 : 3.5 }}
                  exit={{ r: 0, opacity: 0 }}
                  transition={SPRING}
                  strokeWidth={hollow ? 1.5 : 0}
                  stroke="currentColor"
                  className={cn(
                    fade,
                    special ? cn("fill-current", DOT_FILL[v.tone]) : hollow ? cn("fill-card", color[r.kind]) : cn("fill-current", color[r.kind]),
                  )}
                />
              );
            })}
          </AnimatePresence>
          {/* A ring ripples out of the merge node as the branch becomes ready, and again once merged. */}
          <AnimatePresence>
            {(v.tone === "good" || v.tone === "merged") && (
              <motion.circle
                key={v.tone}
                cx={x(cols[0])}
                cy={y(0)}
                initial={{ r: 5, opacity: 0.7 }}
                animate={{ r: 10, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.9, ease: "easeOut" }}
                fill="none"
                strokeWidth={2}
                stroke="currentColor"
                className={DOT_FILL[v.tone]}
              />
            )}
          </AnimatePresence>
        </motion.svg>
        <AnimatePresence initial={false} mode="popLayout">
          {rows.slice(0, shown).map((r) => (
            <motion.div
              key={r.key}
              layout="position"
              initial={{ opacity: 0, y: -ROW / 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={SPRING}
            >
              <GraphRow row={r} status={s} verdict={v} merged={merged} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {(hidden > 0 || s.more) && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          style={{ marginLeft: width + 6 }}
        >
          {open ? "Show fewer" : `Show ${plural(hidden, "more commit")}${s.more ? "+" : ""}`}
        </button>
      )}
    </div>
  );
}

const DOT_FILL: Record<Tone, string> = {
  neutral: "text-muted-foreground/50",
  progress: "text-muted-foreground/50",
  warn: "text-amber-500",
  bad: "text-red-500",
  good: "text-green-500",
  merged: "text-violet-500",
};

function GraphRow({ row, status: s, verdict: v, merged }: { row: Row; status: BranchStatus; verdict: Verdict; merged: boolean }) {
  const kind = row.kind;
  const line = "flex h-7 items-center gap-2";
  if (row.special === "merge") {
    return (
      <div className={line}>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {merged ? "Merged into" : "Merge into"} <span className="font-mono text-xs">{s.base}</span>
        </span>
        <Swap id={v.merge} className={cn("shrink-0 text-xs transition-colors duration-500", TONE_TEXT[v.tone])}>
          {v.merge}
        </Swap>
      </div>
    );
  }
  if (row.special === "work") {
    return (
      <div className={line}>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">Uncommitted changes</span>
        <Swap id={String(s.uncommitted)} className="shrink-0 text-xs text-muted-foreground">
          {plural(s.uncommitted, "file")}
        </Swap>
      </div>
    );
  }
  const c = row.commit!;
  const ref = c.refs.find((r) => r !== s.branch) ?? c.refs[0];
  const chip: Record<Kind, string> = {
    ours: merged ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "bg-brand/10 text-brand",
    base: "bg-muted text-muted-foreground",
    other: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  };
  return (
    <div className={line}>
      <span
        className={cn("min-w-0 truncate transition-colors duration-500", kind === "base" ? "text-muted-foreground" : "text-foreground")}
        title={c.subject}
      >
        {c.subject}
      </span>
      {ref && (
        <span className={cn("shrink-0 truncate rounded px-1.5 py-px font-mono text-[11px] transition-colors duration-500", chip[kind])}>
          {ref}
        </span>
      )}
      <span className="flex-1" />
      <span className="hidden shrink-0 font-mono text-xs text-muted-foreground/70 sm:inline">{c.sha.slice(0, 7)}</span>
      <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
        {s.you && c.author === s.you ? "You" : c.author.split(/\s+/)[0]} · {ago(c.time)}
      </span>
    </div>
  );
}

// --- the chip above the composer -------------------------------------------------------

/** The live card's status above the composer; clicking it scrolls to the card. */
export function BranchChip({ workspaceId, part }: { workspaceId: string; part: DynamicToolUIPart }) {
  const { input, status, verdict: v } = useCard(workspaceId, part);
  if (!status || !v) return null;
  const name = input.pr?.number !== undefined ? `#${input.pr.number}` : (status.branch ?? "branch");
  const total = status.additions + status.deletions;
  const green = total === 0 ? 0 : Math.round((status.additions / total) * 5);
  const Icon = v.tone === "merged" ? GitMergeIcon : input.pr?.state === "closed" ? GitPullRequestClosedIcon : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="mb-2 flex flex-wrap items-center gap-1.5"
    >
      <button
        type="button"
        onClick={() => document.getElementById(`branch-card-${part.toolCallId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-foreground/8 bg-background/70 px-3 text-xs shadow-xs backdrop-blur-sm transition-colors hover:bg-accent dark:border-white/10 dark:bg-card/70"
      >
        {Icon ? (
          <Icon className={cn("size-3.5", TONE_TEXT[v.tone])} />
        ) : v.tone === "good" ? (
          <CircleCheckIcon className={cn("size-3.5", TONE_TEXT.good)} />
        ) : (
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[v.tone])} />
        )}
        <span className="font-medium">{name}</span>
        <Swap id={v.label} className={cn("truncate transition-colors duration-500", TONE_TEXT[v.tone])}>
          {v.tone === "warn" && status.conflicts?.length ? plural(status.conflicts.length, "conflict") : v.label}
        </Swap>
      </button>
      {v.tone !== "merged" && total > 0 && (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-foreground/8 bg-background/70 px-3 text-xs tabular-nums shadow-xs backdrop-blur-sm dark:border-white/10 dark:bg-card/70">
          <span className="text-green-600 dark:text-green-500">+{status.additions}</span>
          <span className="text-red-600 dark:text-red-500">−{status.deletions}</span>
          <span className="flex gap-px" aria-hidden>
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className={cn("size-1.5 rounded-full", i < green ? "bg-green-500/90" : "bg-red-500/80")} />
            ))}
          </span>
        </span>
      )}
    </motion.div>
  );
}
