// Cowork's pull request card: the session's branch against the branch it
// merges into, drawn as a commit graph, with whether it merges cleanly (the
// conflicting lines on hover), the checks, and the pull request's state. The
// model shows it with branch_status; the latest call's card stays live,
// reading git again whenever files change. Once the branch has a pull request
// on GitHub, its CI checks come from gh as a pipeline (each check's timing,
// and why one failed), besides the checks the model ran. A tray docked on the
// composer carries the same status and pipeline. In a shared session the host
// reads both for its guests.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { DynamicToolUIPart } from "ai";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  MinusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { LoadingState, PixelLoader } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BRANCH_STATUS } from "@/lib/agent";
import { ago, edgePath, layout, laneX, rowY, type GraphGeometry } from "@/lib/commit-graph";
import { sendMessage, useSessionStatus } from "@/lib/sessions";
import { WatchingHost } from "@/lib/share";
import type { BranchConflict, BranchStatus, CheckFailure, GraphCommit } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";
import {
  branchSource,
  CurrentWorkspace,
  openFile,
  useBranchStatus,
  useCheckFailure,
  usePrPipeline,
  type BranchSource,
} from "@/lib/workspaces";

// --- what the model passes ------------------------------------------------------------

type PrState = "open" | "draft" | "merged" | "closed";
type CheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

interface Check {
  name: string;
  status: CheckStatus;
  summary?: string;
  detail?: string;
  /** From CI: Unix milliseconds, null until it starts or ends. */
  startedAt?: number | null;
  completedAt?: number | null;
  link?: string | null;
  /** The Actions job, to read why it failed. */
  job?: number | null;
  /** It ran on an earlier commit than the branch's head. */
  stale?: boolean;
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
  /** The card's footer, and the composer tray. */
  label: string;
  /** Short, beside "Merge into main". */
  merge: string;
  /** A button that asks the model to take the next step, and what the tray says while it does. */
  action?: { label: string; prompt: string; busy: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const settled = (c: Check) => c.status === "passed" || c.status === "failed" || c.status === "skipped";

/** What Fix asks for: the failing checks, and what the first one's log says. */
function fixPrompt(failed: Check[], failure: CheckFailure | null): string {
  const names = failed.map((c) => c.name).join(", ");
  if (!failure) return `Fix the failing ${names}.`;
  const what = [failure.title && `“${failure.title}”`, failure.location && `at ${failure.location}`].filter(Boolean).join(" ");
  const got =
    failure.expected || failure.received
      ? ` It expected ${failure.expected ?? "something else"} but received ${failure.received ?? "something else"}.`
      : failure.tail.length > 0
        ? `\n\nThe log ends:\n\`\`\`\n${failure.tail.join("\n")}\n\`\`\``
        : "";
  return `Fix the failing ${names}.${what ? ` ${failed[0].name} fails ${what}.` : ""}${got}`;
}

function verdict(input: CardInput, s: BranchStatus, checks: Check[], failure: CheckFailure | null, ciPending = false): Verdict {
  const base = s.base;
  if (input.pr?.state === "merged") return { tone: "merged", label: `Merged into ${base}`, merge: "merged" };
  if (input.pr?.state === "closed") return { tone: "neutral", label: "Pull request closed", merge: "closed" };
  if (s.merging) {
    const left = s.merging.unresolved.length;
    return left > 0
      ? { tone: "warn", label: `Resolving conflicts · ${left} ${left === 1 ? "file" : "files"} left`, merge: "resolving" }
      : {
          tone: "progress",
          label: "Conflicts resolved",
          merge: "resolving",
          action: { label: "Finish merge", prompt: "Finish the merge.", busy: "Finishing the merge" },
        };
  }
  if (s.conflicts && s.conflicts.length > 0) {
    const n = plural(s.conflicts.length, "conflict");
    return {
      tone: "warn",
      label: `${n} with ${base}`,
      merge: n,
      action: { label: "Resolve conflicts", prompt: `Merge ${base} into this branch and resolve the conflicts.`, busy: "Resolving conflicts" },
    };
  }
  const failed = checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    const label = failed.length === 1 ? `${failed[0].name} failed` : `${plural(failed.length, "check")} failed`;
    return {
      tone: "bad",
      label,
      merge: "blocked",
      action: { label: "Fix", prompt: fixPrompt(failed, failure), busy: `Fixing ${failed.map((c) => c.name).join(", ")}` },
    };
  }
  const running = checks.filter((c) => c.status === "running" || c.status === "pending");
  if (running.length > 0) {
    return { tone: "progress", label: `Checks ${checks.filter(settled).length}/${checks.length}`, merge: "checking" };
  }
  if (s.uncommitted > 0) {
    return {
      tone: "neutral",
      label: `${plural(s.uncommitted, "uncommitted file")}`,
      merge: "uncommitted",
      action: { label: "Commit", prompt: "Commit the changes.", busy: "Committing" },
    };
  }
  if (s.ahead === 0) return { tone: "neutral", label: `No commits ahead of ${base}`, merge: "nothing yet" };
  // GitHub hasn't answered yet: its checks may well be red, so no Merge until they're known.
  if (ciPending) return { tone: "progress", label: "Reading checks", merge: "checking" };
  return {
    tone: "good",
    label: checks.some((c) => c.status === "passed") ? "All checks passed" : "Ready to merge",
    merge: "ready",
    action: {
      label: "Merge",
      prompt: input.pr ? "Merge the pull request." : `Merge this branch into ${base}.`,
      busy: "Merging",
    },
  };
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-500",
  bad: "text-coral",
  good: "text-brand",
  merged: "text-violet-600 dark:text-violet-400",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  progress: "bg-muted-foreground/50",
  warn: "bg-amber-500",
  bad: "bg-coral",
  good: "bg-brand",
  merged: "bg-violet-500",
};

/** One commit, however much of its sha each side has. */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * The card's data: the call's input, git's live view of the branch, and the
 * pull request's CI checks when GitHub has them. Checks CI reports win over
 * the model's of the same name.
 */
function useCard(source: BranchSource | null, part: DynamicToolUIPart) {
  const input = useMemo(() => parseInput(part.input), [part.input]);
  // Read again when the call settles, besides whenever files change.
  const { status, error } = useBranchStatus(source, input.base, part.state);
  const pipeline = usePrPipeline(status ? source : null, input.pr?.number, status?.head, part.state);
  const live = pipeline?.kind === "live" ? pipeline : null;
  // The model's checks belong to the commit they ran on; the output starts with `HEAD <sha>`.
  const reportedAt = typeof part.output === "string" ? /^HEAD ([0-9a-f]{7,40})/.exec(part.output)?.[1] : undefined;
  const modelCurrent = !status || !reportedAt || reportedAt === status.head;
  // CI's run on the pushed commit: a local commit not pushed yet makes them stale.
  const ciCurrent = !status || !live || sameCommit(live.pr.head, status.head);
  const checks = useMemo<Check[]>(() => {
    // gh lists checks in no fixed order: by when each started (queued ones last), then by name, so rows stay put.
    const ci = [...(live?.checks ?? [])].sort(
      (a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.name.localeCompare(b.name),
    );
    const names = new Set(ci.map((c) => c.name.toLowerCase()));
    return [
      ...ci.map((c) => ({ ...c, stale: !ciCurrent })),
      ...input.checks.filter((c) => !names.has(c.name.toLowerCase())).map((c) => ({ ...c, stale: !modelCurrent })),
    ];
  }, [live, input.checks, ciCurrent, modelCurrent]);
  const pr = live ? { number: live.pr.number, url: live.pr.url, state: live.pr.state } : input.pr;
  const current = checks.filter((c) => !c.stale);
  const failedJob = current.find((c) => c.status === "failed" && c.job != null)?.job ?? undefined;
  const { failure, error: failureError } = useCheckFailure(source, failedJob);
  // A null pipeline is gh not having answered yet.
  const judged = status ? verdict({ ...input, pr }, status, current, failure, pipeline === null) : null;
  return { input, pr, status, error, checks, failure, failureError, failedJob, verdict: judged };
}

/** A step the user asked for from a card or the tray, while the run takes it. */
const acting = new Map<string, { busy: string; at: number }>();
const actingListeners = new Set<() => void>();
const subscribeActing = (f: () => void) => (actingListeners.add(f), () => void actingListeners.delete(f));
function startAction(threadId: string, action: NonNullable<Verdict["action"]>) {
  acting.set(threadId, { busy: action.busy, at: Date.now() });
  actingListeners.forEach((f) => f());
  sendMessage(threadId, action.prompt, []);
}

/** What the asked-for step is doing, if the run is still on it; a moment's grace before the run starts. */
function useActing(threadId: string): string | null {
  const session = useSessionStatus(threadId);
  const entry = useSyncExternalStore(subscribeActing, () => acting.get(threadId));
  if (!entry) return null;
  return session !== null || Date.now() - entry.at < 1500 ? entry.busy : null;
}

/** Whether this window may press the card's buttons: the owner, or a guest whose messages reach the run. */
function useCanAct() {
  const watching = useContext(WatchingHost);
  return !watching || watching.canSend;
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
      {/* flow-root keeps the first child's top margin inside, where offsetHeight counts it. */}
      <div ref={inner} className="flow-root pb-0.5">
        {children}
      </div>
    </motion.div>
  );
}

// --- the card -------------------------------------------------------------------------

export function BranchCard({ part, threadId }: { part: DynamicToolUIPart; threadId: string }) {
  const workspace = useContext(CurrentWorkspace);
  const source = useMemo(() => branchSource(workspace?.id, threadId), [workspace?.id, threadId]);
  const { input, pr, status, error, checks, failure, failureError, failedJob, verdict: v } = useCard(source, part);
  const session = useSessionStatus(threadId);
  const doing = useActing(threadId);
  const canAct = useCanAct();
  const checking = part.state === "input-streaming" || part.state === "input-available";

  const title = input.title ?? status?.commits.find((c) => !c.onBase)?.subject ?? status?.branch ?? "This branch";
  const merged = pr?.state === "merged";

  const action = !checking && canAct ? v?.action : undefined;

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
          {pr?.number !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">#{pr.number}</span>}
        </h3>
        {pr ? (
          <Swap id={pr.state} className="shrink-0">
            <PrBadge state={pr.state} />
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
            {checks.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <Pipeline
                  checks={checks}
                  status={status}
                  failure={failure}
                  failedJob={failedJob}
                  failureError={failureError}
                  workspaceId={workspace?.id}
                />
              </div>
            )}
            <footer className="mt-3 flex min-h-8 items-center gap-2">
              {checking ? (
                <Swap id="checking" className="text-muted-foreground">
                  <Spinner className="size-3.5" /> Checking the branch
                </Swap>
              ) : (
                <Status verdict={v!} status={status} busy={session === "working"} doing={doing} />
              )}
              <span className="flex-1" />
              {pr?.url && (
                <button
                  type="button"
                  onClick={() => void openUrl(pr.url!)}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-accent"
                >
                  {/github\.com/.test(pr.url) ? "GitHub" : "Open"} <ArrowUpRightIcon className="size-3.5" />
                </button>
              )}
              <ActionButton action={action} threadId={threadId} doing={doing} disabled={session !== null} />
            </footer>
          </>
        )}
      </AutoHeight>
    </motion.article>
  );
}

/** The next step as a button; while the run takes it, a spinner and what it's doing. */
function ActionButton({
  action,
  threadId,
  doing,
  disabled,
}: {
  action: Verdict["action"];
  threadId: string;
  doing: string | null;
  disabled: boolean;
}) {
  const shown = doing ?? action?.label;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {shown && (doing || action) && (
        <motion.button
          key={shown}
          type="button"
          layout
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={FADE}
          disabled={disabled || !!doing || !action}
          onClick={() => action && startAction(threadId, action)}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors disabled:cursor-default",
            action?.label === "Fix" && !doing
              ? "bg-coral/10 text-coral hover:bg-coral/15"
              : "bg-brand/10 text-brand hover:bg-brand/15 disabled:hover:bg-brand/10",
            disabled && !doing && "opacity-60",
          )}
        >
          {doing ? <Spinner className="size-3.5" /> : action?.label === "Merge" && <GitMergeIcon className="size-3.5" />}
          {doing ?? action?.label}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function PrBadge({ state }: { state: PrState }) {
  const tone: Record<PrState, [string, string]> = {
    open: ["Open", "text-brand before:bg-brand"],
    draft: ["Draft", "text-muted-foreground before:bg-muted-foreground/60"],
    merged: ["Merged", "text-violet-600 dark:text-violet-400 before:bg-violet-500"],
    closed: ["Closed", "text-coral before:bg-coral"],
  };
  const [label, className] = tone[state];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium before:size-1.5 before:rounded-full", className)}>
      {label}
    </span>
  );
}

/** The footer's status line; conflicts show their lines on hover. */
function Status({ verdict: given, status, busy, doing }: { verdict: Verdict; status: BranchStatus; busy: boolean; doing: string | null }) {
  const v: Verdict = doing ? { ...given, tone: "progress", label: doing } : given;
  const icon =
    busy && (v.tone === "warn" || v.tone === "progress") ? (
      <PixelLoader className="text-brand" />
    ) : v.tone === "merged" ? (
      <GitMergeIcon className={cn("size-3.5", TONE_TEXT.merged)} />
    ) : v.tone === "good" ? (
      <CircleCheckIcon className={cn("size-3.5", TONE_TEXT.good)} />
    ) : v.tone === "warn" ? (
      <TriangleAlertIcon className={cn("size-3.5", TONE_TEXT.warn)} />
    ) : v.tone === "bad" ? (
      <CircleXIcon className={cn("size-3.5", TONE_TEXT.bad)} />
    ) : v.tone === "progress" ? (
      <PixelLoader className="text-brand" />
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

// --- the checks, as a pipeline ------------------------------------------------------------

/** `11s`, `1m 16s`. */
function duration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** A round length ahead of `elapsed`, for the timeline while checks run: 30s, 1m, 90s, 2m, 3m, 5m… */
const CEILINGS = [30, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 3600].map((s) => s * 1000);
const timelineCeiling = (elapsed: number) => CEILINGS.find((c) => c >= elapsed * 1.15) ?? elapsed * 1.15;

/** The time, every second while `ticking`. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

const BAR: Record<CheckStatus, string> = {
  running: "bg-brand",
  passed: "bg-brand/55",
  failed: "bg-coral",
  skipped: "bg-muted-foreground/25",
  pending: "bg-transparent",
};

function CheckGlyph({ status }: { status: CheckStatus }) {
  return (
    <Swap id={status} className="size-4 justify-center gap-0">
      {status === "passed" ? (
        <CheckIcon className="size-3.5 text-brand" />
      ) : status === "failed" ? (
        <CircleXIcon className="size-3.5 text-coral" />
      ) : status === "running" ? (
        <PixelLoader className="text-brand" />
      ) : status === "skipped" ? (
        <MinusIcon className="size-3.5 text-muted-foreground" />
      ) : (
        <CircleDashedIcon className="size-3.5 text-muted-foreground" />
      )}
    </Swap>
  );
}

/**
 * Each check as a row: its status, name, a bar placed by when it started and
 * as long as it ran (CI's checks; the model's have no timing), and how long.
 * A failed check opens to what its log says.
 */
function Pipeline({
  checks,
  status,
  failure,
  failureError,
  failedJob,
  workspaceId,
}: {
  checks: Check[];
  status: BranchStatus;
  failure: CheckFailure | null;
  failureError: string | null;
  failedJob: number | undefined;
  workspaceId: string | undefined;
}) {
  const running = checks.some((c) => c.status === "running" && !c.stale);
  const now = useNow(running);
  const timed = checks.filter((c) => c.startedAt != null);
  const start = timed.length > 0 ? Math.min(...timed.map((c) => c.startedAt!)) : 0;
  const end = timed.length > 0 ? Math.max(...timed.map((c) => c.completedAt ?? now)) : 0;
  const elapsed = Math.max(end - start, 1000);
  // While checks run, the timeline reaches past them so their bars visibly grow; once they settle, it's the run's length.
  const span = running ? timelineCeiling(elapsed) : elapsed;
  const stale = checks.length > 0 && checks.every((c) => c.stale);
  const headCommit = status.commits.find((c) => sameCommit(c.sha, status.head));

  // The first failure opens by itself; others when clicked.
  const firstFailed = checks.find((c) => c.status === "failed" && !c.stale)?.name;
  const [open, setOpen] = useState<string | null>(firstFailed ?? null);
  useEffect(() => {
    if (firstFailed) setOpen(firstFailed);
  }, [firstFailed]);

  // Once, across every bar, when the last check passes.
  const allPassed = checks.length > 0 && checks.every((c) => !c.stale && (c.status === "passed" || c.status === "skipped"));
  const wasRunning = useRef(false);
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (allPassed && wasRunning.current) {
      wasRunning.current = false;
      setSweep((n) => n + 1);
    }
  }, [running, allPassed]);

  return (
    <motion.div initial={false} animate={{ opacity: stale ? 0.6 : 1 }} transition={FADE} className="text-xs">
      {timed.length > 0 && (
        <p className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
          <span className="shrink-0">Checks on</span>
          <code className="shrink-0 rounded bg-muted px-1 font-mono text-[11px]">{status.head.slice(0, 7)}</code>
          {headCommit && <span className="min-w-0 truncate text-foreground/80">{headCommit.subject}</span>}
          <span className="flex-1" />
          <span className="shrink-0 tabular-nums">{duration(elapsed)}</span>
        </p>
      )}
      <div className="relative">
        <AnimatePresence initial={false}>
          {checks.map((c) => (
            <motion.div
              key={c.name}
              layout="position"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={SPRING}
            >
              <CheckRow
                check={c}
                start={start}
                span={span}
                now={now}
                open={open === c.name}
                onToggle={() => setOpen((o) => (o === c.name ? null : c.name))}
              />
              {c.status === "failed" && open === c.name && (
                <FailureDetail
                  check={c}
                  failure={c.job === failedJob ? failure : null}
                  error={c.job === failedJob ? failureError : null}
                  workspaceId={workspaceId}
                />
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {sweep > 0 && (
          <span key={sweep} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
            <span
              data-ci-sweep
              className="absolute inset-0 bg-linear-to-r from-transparent via-brand/15 to-transparent"
              style={{ animation: "ci-sweep 900ms ease-out forwards" }}
            />
          </span>
        )}
      </div>
    </motion.div>
  );
}

function CheckRow({
  check: c,
  start,
  span,
  now,
  open,
  onToggle,
}: {
  check: Check;
  start: number;
  span: number;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const failed = c.status === "failed" && !c.stale;
  const end = c.completedAt ?? (c.status === "running" ? now : c.startedAt);
  const left = c.startedAt != null ? ((c.startedAt - start) / span) * 100 : 0;
  const width = c.startedAt != null && end != null ? Math.max(((end - c.startedAt) / span) * 100, 1.5) : 0;
  const took = c.startedAt != null && end != null && c.status !== "pending" ? duration(end - c.startedAt) : null;
  const tip = [c.detail, c.stale && "From before the latest changes"].filter(Boolean).join(" · ");
  const name = (
    <span className={cn("min-w-0 truncate", c.stale && "text-muted-foreground")}>
      {c.link ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(c.link!);
          }}
          className="truncate underline-offset-4 hover:underline"
        >
          {c.name}
        </button>
      ) : (
        c.name
      )}
    </span>
  );
  const row = (
    <div
      role={failed ? "button" : undefined}
      tabIndex={failed ? 0 : undefined}
      aria-expanded={failed ? open : undefined}
      onClick={failed ? onToggle : undefined}
      onKeyDown={failed ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle()) : undefined}
      className={cn(
        "grid h-7 grid-cols-[1rem_minmax(4.5rem,8.5rem)_1fr_3.25rem] items-center gap-x-3 rounded-md",
        failed && "-mx-1.5 cursor-pointer px-1.5 transition-colors hover:bg-coral/5 focus-visible:outline-2 focus-visible:outline-coral/40",
      )}
    >
      <CheckGlyph status={c.status} />
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>{name}</TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      ) : (
        name
      )}
      <span className="relative h-1.5 min-w-0 rounded-full bg-foreground/[0.04]">
        {c.startedAt != null ? (
          <motion.span
            data-ci-bar
            initial={false}
            animate={{ left: `${left}%`, width: `${width}%` }}
            transition={SPRING}
            className={cn("absolute inset-y-0 rounded-full transition-colors duration-500", BAR[c.status])}
            style={
              c.status === "running"
                ? {
                    backgroundImage: "linear-gradient(90deg, transparent, oklch(1 0 0 / 0.45), transparent)",
                    backgroundSize: "50% 100%",
                    backgroundRepeat: "no-repeat",
                    animation: "ci-run 1.6s linear infinite",
                  }
                : undefined
            }
          />
        ) : (
          c.summary && (
            <span className="absolute inset-y-0 left-0 flex max-w-full items-center truncate text-muted-foreground">{c.summary}</span>
          )
        )}
      </span>
      <span className={cn("text-right tabular-nums", failed ? "text-coral" : "text-muted-foreground")}>
        {took ?? (c.status === "pending" ? "Queued" : "")}
      </span>
    </div>
  );
  return row;
}

/** Why a check failed: where, which test, and what it expected against what it got. */
function FailureDetail({
  check,
  failure,
  error,
  workspaceId,
}: {
  check: Check;
  failure: CheckFailure | null;
  error: string | null;
  workspaceId: string | undefined;
}) {
  const loading = check.job != null && !failure && !error;
  const at = failure?.location?.match(/^(.*):(\d+)$/);
  return (
    <AutoHeight>
      <div className="mb-1.5 ml-7 space-y-1.5 pt-0.5">
        {loading ? (
          <LoadingState label="Reading the log" variant="Dots" />
        ) : error && !failure ? (
          <p className="text-muted-foreground">
            Couldn’t read the log: {error}
            {check.link && (
              <>
                {" "}
                <button type="button" onClick={() => void openUrl(check.link!)} className="text-foreground underline underline-offset-4">
                  Open it on GitHub
                </button>
              </>
            )}
          </p>
        ) : failure ? (
          <>
            {failure.location && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {workspaceId && at ? (
                  <button
                    type="button"
                    onClick={() => openFile(workspaceId, at[1], Number(at[2]))}
                    className="underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {failure.location}
                  </button>
                ) : (
                  failure.location
                )}
              </p>
            )}
            {failure.title && <p className="text-[13px] text-foreground">{failure.title}</p>}
            {(failure.expected || failure.received) && (
              <div className="overflow-hidden rounded-md font-mono text-[11px] leading-6">
                {failure.expected && (
                  <p className="truncate bg-brand/10 px-2.5">
                    <span className="text-muted-foreground">Expected:</span> {failure.expected}
                  </p>
                )}
                {failure.received && (
                  <p className="truncate bg-coral/10 px-2.5">
                    <span className="text-muted-foreground">Received:</span> {failure.received}
                  </p>
                )}
              </div>
            )}
            {failure.tail.length > 0 && (
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-muted-foreground">
                {failure.tail.join("\n")}
              </pre>
            )}
          </>
        ) : (
          check.detail && <p className="text-muted-foreground">{check.detail}</p>
        )}
      </div>
    </AutoHeight>
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
  // On first show the graph grows from the base up to the merge node: each dot, then the line above it.
  // After that, delays stay 0 so later changes move at once.
  // The OS setting, or Sush's own (Settings → Appearance, on <html>).
  const reduceMotion = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const [entering, setEntering] = useState(!reduceMotion);
  useEffect(() => {
    if (!entering) return;
    const id = setTimeout(() => setEntering(false), 1200);
    return () => clearTimeout(id);
  }, [entering]);
  const delay = (row: number) => (entering ? Math.max(0, shown - 1 - row) * 0.09 : 0);

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
          <AnimatePresence initial={entering}>
            {edges.map((e) => {
              const d = edgePath(GEOMETRY, e, cols);
              const key = `${rows[e.from].key}>${rows[e.to].key}`;
              return (
                <motion.path
                  key={key}
                  initial={e.dashed ? { d, opacity: 0 } : { d, opacity: 0, pathLength: 0 }}
                  animate={e.dashed ? { d, opacity: 1 } : { d, opacity: 1, pathLength: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    ...SPRING,
                    delay: delay(e.to) + 0.05,
                    pathLength: { duration: 0.4, ease: "easeOut", delay: delay(e.to) + 0.05 },
                  }}
                  fill="none"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  strokeDasharray={e.dashed ? "2 3" : undefined}
                  // While checks run, the dashes into the merge node flow up toward it.
                  data-ci-flow={e.dashed && v.tone === "progress" ? "" : undefined}
                  className={cn(fade, color[e.kind])}
                />
              );
            })}
          </AnimatePresence>
          <AnimatePresence initial={entering}>
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
                  transition={{ ...SPRING, delay: delay(i) }}
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
          {/* A ring ripples out of the merge node whenever the verdict lands: ready, merged, blocked or conflicted. */}
          <AnimatePresence>
            {!entering && (v.tone === "good" || v.tone === "merged" || v.tone === "bad" || v.tone === "warn") && (
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
        <AnimatePresence initial={entering} mode="popLayout">
          {rows.slice(0, shown).map((r, i) => (
            <motion.div
              key={r.key}
              layout="position"
              initial={entering ? { opacity: 0, x: -6 } : { opacity: 0, y: -ROW / 2 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ ...SPRING, delay: delay(i) }}
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
  bad: "text-coral",
  good: "text-brand",
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

// --- the tray on the composer -------------------------------------------------------------

/** Whether the element with `id` is on screen, at least partly; it may mount after this does. */
function useInView(id: string) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    let observer: IntersectionObserver | undefined;
    let frame = 0;
    let tries = 0;
    const attach = () => {
      const el = document.getElementById(id);
      // A couple of seconds of frames; past that, it isn't coming.
      if (!el) return void (++tries < 120 && (frame = requestAnimationFrame(attach)));
      observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
      observer.observe(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [id]);
  return inView;
}

/** How far the tray reaches above the composer's top edge. */
const TRAY_OVERLAP = 12;

/**
 * Tells the mascot, which stands on the composer's top edge, how tall the tray
 * above it is (`--tray-lift` on their shared parent), so it stands on the tray.
 */
function useTrayLift(shown: boolean) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const observer = new ResizeObserver(() => parent.style.setProperty("--tray-lift", `${Math.max(el.offsetHeight - TRAY_OVERLAP, 0)}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      parent.style.removeProperty("--tray-lift");
    };
  }, [shown]);
  return ref;
}

/**
 * The live card's status, docked on the composer's top edge: the pull request,
 * where it stands, the next step, and the pipeline when opened. It opens by
 * itself when a check fails and folds away once merged. Clicking the number
 * scrolls to the card.
 */
export function BranchTray({ workspaceId, threadId, part }: { workspaceId: string | undefined; threadId: string; part: DynamicToolUIPart }) {
  const source = useMemo(() => branchSource(workspaceId, threadId), [workspaceId, threadId]);
  const { pr, status, checks, failure, failureError, failedJob, verdict: given } = useCard(source, part);
  const session = useSessionStatus(threadId);
  const doing = useActing(threadId);
  const canAct = useCanAct();
  const failedKey = checks.filter((c) => c.status === "failed" && !c.stale).map((c) => c.name).join();
  const merged = given?.tone === "merged";
  const [open, setOpen] = useState(false);
  // Before the early return below; the tray shows once the branch is read.
  const tray = useTrayLift(!!status && !!given);
  // The card shows the same pipeline: a failure opens the tray only when the card is out of view.
  const cardInView = useInView(`branch-card-${part.toolCallId}`);
  const cardSeen = useRef(cardInView);
  cardSeen.current = cardInView;
  useEffect(() => {
    if (failedKey && !cardSeen.current) setOpen(true);
  }, [failedKey]);
  useEffect(() => {
    if (merged) setOpen(false);
  }, [merged]);
  // An approval the run waits on sits just above the composer: the tray mustn't cover it.
  const waiting = session === "needs-input";
  useEffect(() => {
    if (waiting) setOpen(false);
  }, [waiting]);
  if (!status || !given) return null;

  const v: Verdict = doing ? { ...given, tone: "progress", label: doing } : given;
  const name = pr?.number !== undefined ? `#${pr.number}` : (status.branch ?? "branch");
  const total = status.additions + status.deletions;
  const share = total === 0 ? 0 : Math.round((status.additions / total) * 5);
  const Icon = v.tone === "merged" ? GitMergeIcon : pr?.state === "closed" ? GitPullRequestClosedIcon : null;
  const canOpen = checks.length > 0;

  return (
    <motion.section
      ref={tray}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      aria-label={`Pull request ${name}: ${v.label}`}
      className="relative mx-3 -mb-3 rounded-t-2xl border border-b-0 border-foreground/8 bg-card/85 pb-3 text-xs shadow-xs backdrop-blur-sm dark:border-white/10"
    >
      <div className="flex h-10 items-center gap-2 pr-2 pl-3.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {Icon ? (
            <Icon className={cn("size-3.5", TONE_TEXT[v.tone])} />
          ) : v.tone === "progress" ? (
            <PixelLoader className="text-brand" />
          ) : v.tone === "good" ? (
            <CircleCheckIcon className={cn("size-3.5", TONE_TEXT.good)} />
          ) : v.tone === "bad" ? (
            <CircleXIcon className={cn("size-3.5", TONE_TEXT.bad)} />
          ) : v.tone === "warn" ? (
            <TriangleAlertIcon className={cn("size-3.5", TONE_TEXT.warn)} />
          ) : (
            <span className={cn("size-1.5 rounded-full", TONE_DOT[v.tone])} />
          )}
        </span>
        <button
          type="button"
          onClick={() => document.getElementById(`branch-card-${part.toolCallId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
          className="shrink-0 font-medium underline-offset-4 hover:underline"
        >
          {name}
        </button>
        <Swap id={v.label} className={cn("min-w-0 truncate transition-colors duration-500", v.tone === "progress" ? "text-muted-foreground" : TONE_TEXT[v.tone])}>
          {v.tone === "warn" && status.conflicts?.length ? plural(status.conflicts.length, "conflict") : v.label}
        </Swap>
        <span className="flex-1" />
        {!merged && total > 0 && (
          <span className="hidden shrink-0 items-center gap-1.5 tabular-nums sm:inline-flex">
            <span className="text-brand">+{status.additions}</span>
            <span className="text-coral">−{status.deletions}</span>
            <span className="flex gap-px" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} className={cn("size-1.5 rounded-full", i < share ? "bg-brand/80" : "bg-coral/70")} />
              ))}
            </span>
          </span>
        )}
        {canOpen && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? "Hide checks" : "Show checks"}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
          </button>
        )}
        <ActionButton action={canAct ? given.action : undefined} threadId={threadId} doing={doing} disabled={session !== null} />
      </div>
      <AnimatePresence initial={false}>
        {open && canOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="overflow-hidden"
          >
            <div className="max-h-[40vh] overflow-y-auto border-t px-3.5 pt-2.5 pb-1">
              <Pipeline
                checks={checks}
                status={status}
                failure={failure}
                failureError={failureError}
                failedJob={failedJob}
                workspaceId={workspaceId}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
