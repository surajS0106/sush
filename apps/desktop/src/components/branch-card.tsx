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
  ClockIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  MinusIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { LoadingState, PixelLoader } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BRANCH_STATUS, useRunningToolCalls } from "@/lib/agent";
import { ago, edgePath, layout, laneX, rowY, type GraphGeometry } from "@/lib/commit-graph";
import { sendMessage, useSessionStatus, useThread } from "@/lib/sessions";
import { WatchingHost } from "@/lib/share";
import { createStore } from "@/lib/store";
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
  /**
   * A button that asks the model to take the next step, and what the tray says while it does. `say` is
   * the short line the transcript shows, `prompt` then goes to the model alone; `approves` are the exact
   * commands pressing it already approved.
   */
  action?: Action & { methods?: MergeOption[] };
}

interface Action {
  label: string;
  prompt: string;
  busy: string;
  say?: string;
  approves?: string[];
}

type MergeMethod = "merge" | "squash" | "rebase";

/** One way the Merge button can land the branch, picked from its menu. */
interface MergeOption extends Action {
  method: MergeMethod;
  detail: string;
}

const GH_FLAG: Record<MergeMethod, string> = { merge: "--merge", squash: "--squash", rebase: "--rebase" };

/**
 * The Merge menu. Each choice asks for exactly one call (gh's merge for a pull
 * request, else git_merge with its method), so the model has nothing to work out.
 */
function mergeOptions(pr: CardInput["pr"], s: BranchStatus): MergeOption[] {
  const base = s.base;
  const n = plural(s.ahead, "commit");
  const command = (method: MergeMethod) => `gh pr merge${pr?.number !== undefined ? ` ${pr.number}` : ""} ${GH_FLAG[method]}`;
  const ask = (method: MergeMethod, label: string): Pick<Action, "say" | "prompt" | "approves"> =>
    pr
      ? {
          say: `${label}${pr.number !== undefined ? ` #${pr.number}` : ""}`,
          prompt: `Run \`${command(method)}\` with shell_run (network and unsandboxed), then call branch_status with pr.state merged.`,
          approves: [command(method)],
        }
      : {
          say: `${label} into ${base}`,
          prompt: `Call git_merge with branch "${base}", into: true and method "${method}", then call branch_status.`,
        };
  return [
    { method: "merge", label: "Create a merge commit", detail: `Adds the ${n} to ${base}, joined by a merge commit.`, busy: "Merging", ...ask("merge", "Merge") },
    { method: "squash", label: "Squash and merge", detail: `Combines the ${n} into a single commit on ${base}.`, busy: "Squashing", ...ask("squash", "Squash and merge") },
    {
      method: "rebase",
      label: "Rebase and merge",
      detail: s.behind === 0 ? `Moves ${base} up to this branch, with no merge commit.` : `Replays the ${n} on top of ${base}, with no merge commit.`,
      busy: "Rebasing",
      ...ask("rebase", "Rebase and merge"),
    },
  ];
}

/** The method picked last, ticked in the menu next time. */
const lastMethod = createStore<MergeMethod>("sush.merge-method", "merge");

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

/**
 * Merged. Like `gh pr merge --delete-branch`, the branch can go now: a button
 * deletes its copy on the remote (if there still is one) and the local one,
 * moving the checkout onto the base first. The card then reads the base, and
 * says the branch is gone.
 */
function mergedVerdict(s: BranchStatus, pr: CardInput["pr"]): Verdict {
  const done: Verdict = { tone: "merged", label: `Merged into ${s.base}`, merge: "merged" };
  if (!s.branch || s.branch === s.base) return pr ? { ...done, label: `${done.label} · branch deleted` } : done;
  const branch = s.branch;
  // `origin/feat` while the remote still has it; null once it was deleted there (here or on the host's site).
  const [remote, ...rest] = s.upstream?.split("/") ?? [];
  const command = [remote && `git push ${remote} --delete ${rest.join("/")}`, `git switch ${s.base}`, `git branch -D ${branch}`]
    .filter(Boolean)
    .join(" && ");
  const prArg = pr ? ` with pr (number ${pr.number ?? "as before"}, state merged)` : "";
  return {
    ...done,
    action: {
      label: "Delete branch",
      say: `Delete ${branch}`,
      prompt: `Run \`${command}\` as one shell_run (network and unsandboxed). Then call branch_status${prArg}.`,
      busy: "Deleting the branch",
      approves: [command],
    },
  };
}

function verdict(input: CardInput, s: BranchStatus, checks: Check[], failure: CheckFailure | null, ciPending = false): Verdict {
  const base = s.base;
  if (input.pr?.state === "merged") return mergedVerdict(s, input.pr);
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
      action: {
        label: "Fix",
        say: `Fix the failing ${failed.map((c) => c.name).join(", ")} ${failed.length === 1 ? "check" : "checks"}`,
        prompt: fixPrompt(failed, failure),
        busy: `Fixing ${failed.map((c) => c.name).join(", ")}`,
      },
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
      methods: mergeOptions(input.pr, s),
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
function startAction(threadId: string, action: Action) {
  acting.set(threadId, { busy: action.busy, at: Date.now() });
  actingListeners.forEach((f) => f());
  if (action.say) sendMessage(threadId, action.say, [], { text: action.prompt, approves: action.approves });
  else sendMessage(threadId, action.prompt, []);
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
  const { input, pr: reported, status, error, checks, failure, failureError, failedJob, verdict: judged } = useCard(source, part);
  const session = useSessionStatus(threadId);
  const doing = useActing(threadId);
  const canAct = useCanAct();
  const checking = part.state === "input-streaming" || part.state === "input-available";
  const { steps, phase, pr, merged, verdict: v } = useLanded(threadId, input.base, status, reported, judged);

  const title = input.title ?? status?.commits.find((c) => !c.onBase && c.sha === status.head)?.subject ?? status?.branch ?? "This branch";

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
            <Graph status={status} verdict={v!} merged={merged} phase={phase} />
            {steps.length > 0 && <GitSteps steps={steps} />}
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

/** The next step as a button; while the run takes it, a spinner and what it's doing. Merge opens its methods first. */
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
  const last = useSyncExternalStore(lastMethod.subscribe, lastMethod.get);
  const methods = !doing ? action?.methods : undefined;
  const button = (
    <motion.button
      key={shown}
      type="button"
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={FADE}
      disabled={disabled || !!doing || !action}
      onClick={methods ? undefined : () => action && startAction(threadId, action)}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors disabled:cursor-default",
        action?.label === "Fix" && !doing
          ? "bg-coral/10 text-coral hover:bg-coral/15"
          : action?.label === "Delete branch" && !doing
            ? "border text-foreground hover:bg-accent"
            : "bg-brand/10 text-brand hover:bg-brand/15 disabled:hover:bg-brand/10 data-[state=open]:bg-brand/15",
        disabled && !doing && "opacity-60",
      )}
    >
      {doing ? <Spinner className="size-3.5" /> : action?.label === "Merge" && <GitMergeIcon className="size-3.5" />}
      {doing ?? action?.label}
      {methods && <ChevronDownIcon className="-mr-1 size-3.5 opacity-70" />}
    </motion.button>
  );
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {shown &&
        (doing || action) &&
        (methods ? (
          <DropdownMenu key={shown}>
            <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              {methods.map((m) => (
                <DropdownMenuItem
                  key={m.method}
                  onSelect={() => {
                    lastMethod.set(m.method);
                    startAction(threadId, m);
                  }}
                  className="items-start gap-2 py-2"
                >
                  <CheckIcon className={cn("mt-0.5 size-4", m.method !== last && "invisible")} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{m.label}</span>
                    <span className="text-xs text-muted-foreground">{m.detail}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          button
        ))}
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
  // Jobs that start together reach their runners a few seconds apart; lined up, a real stagger (one waiting on another) still shows.
  const begin = (t: number) => (t - start < PICKUP_JITTER ? start : t);
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
                begin={begin}
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

/** How far apart jobs queued together can start on their runners, in ms. */
const PICKUP_JITTER = 5000;

function CheckRow({
  check: c,
  start,
  begin,
  span,
  now,
  open,
  onToggle,
}: {
  check: Check;
  start: number;
  /** Where a bar starting at this time is drawn from. */
  begin: (t: number) => number;
  span: number;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const failed = c.status === "failed" && !c.stale;
  const end = c.completedAt ?? (c.status === "running" ? now : c.startedAt);
  const from = c.startedAt != null ? begin(c.startedAt) : null;
  const left = from != null ? ((from - start) / span) * 100 : 0;
  const width = from != null && end != null ? Math.max(((end - from) / span) * 100, 1.5) : 0;
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

// --- the git steps of this turn ------------------------------------------------------------

type StepKind = "commit" | "push" | "pr" | "merge-pr" | "land" | "merge" | "sync" | "git";
type StepState = "waiting" | "running" | "done" | "failed";

interface GitStep {
  id: string;
  kind: StepKind;
  label: string;
  /** The command as run, or the one the tool call stands for. */
  command: string;
  state: StepState;
  /** The output's last line, once it ends. */
  note?: string;
}

/** Commands that only read, which say nothing about where the branch is going. */
const READ_ONLY =
  /^(?:git\s+(?:-\S+\s+)*(?:log|status|diff|show|rev-parse|rev-list|ls-files|blame|config|remote|branch\s*$|branch\s+(?:-a|-r|-v|--list))|gh\s+(?:pr\s+(?:view|checks|list|status|diff)|run|api|auth|repo\s+view))\b/;

/** What one `git`/`gh` command in a shell line does, or null for anything else. */
function commandStep(cmd: string, base: string): Pick<GitStep, "kind" | "label"> | null {
  if (!/^(git|gh)\s/.test(cmd) || READ_ONLY.test(cmd)) return null;
  if (/^gh\s+pr\s+merge\b/.test(cmd)) return { kind: "merge-pr", label: `Merge the pull request into ${base}` };
  if (/^gh\s+pr\s+create\b/.test(cmd)) return { kind: "pr", label: "Open the pull request" };
  if (/^gh\s/.test(cmd)) return { kind: "git", label: "GitHub" };
  const words = cmd.split(/\s+/).slice(1);
  const sub = words.find((w) => !w.startsWith("-"));
  const arg = words.slice(words.indexOf(sub!) + 1).find((w) => !w.startsWith("-"));
  // `git push origin --delete feat` (or `origin :feat`) removes the remote branch rather than pushing to it.
  if (sub === "push" && (words.includes("--delete") || words.includes("-d") || words.some((w) => w.startsWith(":")))) {
    const [remote, branch] = words.slice(words.indexOf(sub) + 1).filter((w) => !w.startsWith("-"));
    return { kind: "git", label: `Delete ${branch?.replace(/^:/, "") ?? "the branch"} from ${remote ?? "origin"}` };
  }
  switch (sub) {
    case "push":
      return { kind: "push", label: `Push to ${arg ?? "origin"}` };
    case "fetch":
    case "pull":
      return { kind: "sync", label: `Sync with ${arg ?? "origin"}` };
    case "merge":
      return { kind: "merge", label: arg ? `Merge ${arg}` : "Merge" };
    case "commit":
      return { kind: "commit", label: "Commit" };
    case "branch":
      return words.some((w) => w === "-D" || w === "-d" || w === "--delete")
        ? { kind: "git", label: arg ? `Delete ${arg} here` : "Delete the branch here" }
        : { kind: "git", label: "git branch" };
    case "switch":
    case "checkout":
      return { kind: "git", label: arg ? `Switch to ${arg}` : "Switch branch" };
    default:
      return { kind: "git", label: `git ${sub ?? ""}`.trim() };
  }
}

/** The last line worth showing from a call's output: shell output is `Exit code: N` then tagged stdout and stderr. */
function lastLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^<\/?(stdout|stderr)>$/.test(l) && !/^Exit code: \d+$/.test(l))
    .at(-1);
}

/** What git_merge's land does by method, as the command a person would run. */
const LAND_COMMAND: Record<string, (base: string) => string> = {
  merge: (base) => `git merge --no-ff  (on ${base})`,
  squash: (base) => `git merge --squash  (on ${base})`,
  rebase: (base) => `git rebase ${base}  (then fast-forward ${base})`,
};

/** When each step was first seen running and when it ended, for its duration. */
const stepTimes = new Map<string, { start: number; end?: number }>();

/**
 * The turn's git work as steps: each `git_commit` and `git_merge`, and every
 * `git`/`gh` command in a `shell_run` that changes something (a line of
 * `git push && gh pr merge` is two steps). Since the last user message, so the
 * steps follow the turn from card to card.
 */
function useGitSteps(threadId: string, base: string): GitStep[] {
  const { messages } = useThread(threadId);
  const running = useRunningToolCalls();
  return useMemo(() => {
    const from = messages.findLastIndex((m) => m.role === "user") + 1;
    const steps: GitStep[] = [];
    for (const m of messages.slice(from)) {
      for (const part of m.parts) {
        if (part.type !== "dynamic-tool") continue;
        const input = (part.input ?? {}) as { command?: string; message?: string; branch?: string; into?: boolean; abort?: boolean; method?: string };
        const output = part.state === "output-available" ? String(part.output ?? "") : "";
        const exit = /^Exit code: (\d+)/.exec(output)?.[1];
        const state: StepState =
          part.state === "output-error" || (exit !== undefined && exit !== "0") || output.startsWith("Timed out")
            ? "failed"
            : part.state === "output-available"
              ? "done"
              : part.state === "input-streaming" || running.has(part.toolCallId)
                ? "running"
                : "waiting";
        const note = part.state === "output-error" ? part.errorText : output ? lastLine(output) : undefined;
        const found: Pick<GitStep, "kind" | "label" | "command">[] = [];
        if (part.toolName === "git_commit") {
          found.push({ kind: "commit", label: "Commit", command: `git commit -m "${input.message?.split("\n")[0] ?? ""}"` });
        } else if (part.toolName === "git_merge") {
          const branch = input.branch ?? base;
          found.push(
            input.abort
              ? { kind: "merge", label: "Undo the merge", command: "git merge --abort" }
              : input.into
                ? { kind: "land", label: `Land on ${branch}`, command: LAND_COMMAND[input.method ?? ""]?.(branch) ?? `git merge --ff-only  (on ${branch})` }
                : { kind: "merge", label: `Merge ${branch} in`, command: `git merge ${branch}` },
          );
        } else if (part.toolName === "shell_run" && input.command) {
          for (const cmd of input.command.split(/&&|\|\||;|\n/).map((c) => c.trim())) {
            const step = commandStep(cmd, base);
            if (step) found.push({ ...step, command: cmd });
          }
        }
        found.forEach((f, i) => {
          const id = `${part.toolCallId}:${i}`;
          // A chained command's steps share one call, so they share its state; the output goes under the last.
          const times = stepTimes.get(id);
          if (state === "running" && !times) stepTimes.set(id, { start: Date.now() });
          if ((state === "done" || state === "failed") && times && !times.end) times.end = Date.now();
          steps.push({ id, ...f, state, note: i === found.length - 1 ? note : undefined });
        });
      }
    }
    return steps;
  }, [messages, running, base]);
}

/** Where the turn's git work has the branch: being pushed, being merged, or merged. */
type MergePhase = "push" | "merge" | "merged" | null;

function mergePhase(steps: GitStep[]): MergePhase {
  if (steps.some((s) => (s.kind === "merge-pr" || s.kind === "land") && s.state === "done")) return "merged";
  const now = steps.find((s) => s.state === "running");
  if (now?.kind === "push" || now?.kind === "pr") return "push";
  if (now?.kind === "merge-pr" || now?.kind === "land") return "merge";
  return null;
}

type Card = ReturnType<typeof useCard>;

/**
 * Once the turn's merge command succeeds the branch counts as merged, without
 * waiting for GitHub's next poll. A squash or rebase leaves the branch's own
 * commits off the base, so the read status alone would still say "ready".
 * The card and the tray both go through this so they agree.
 */
function useLanded(
  threadId: string,
  base: string | undefined,
  status: Card["status"],
  reported: Card["pr"],
  judged: Card["verdict"],
) {
  const steps = useGitSteps(threadId, status?.base ?? base ?? "main");
  const phase = mergePhase(steps);
  const pr = reported && phase === "merged" ? { ...reported, state: "merged" as const } : reported;
  const merged = pr?.state === "merged" || phase === "merged";
  const verdict: Verdict | null =
    judged && status && phase === "merged" && judged.tone !== "merged" ? mergedVerdict(status, pr) : (judged ?? null);
  return { steps, phase, pr, merged, verdict };
}

function StepGlyph({ state }: { state: StepState }) {
  return (
    <Swap id={state} className="relative z-10 size-4 shrink-0 justify-center gap-0 bg-card">
      {state === "done" ? (
        <CheckIcon className="size-3.5 text-brand" />
      ) : state === "failed" ? (
        <CircleXIcon className="size-3.5 text-coral" />
      ) : state === "running" ? (
        <PixelLoader className="text-brand" />
      ) : (
        <ClockIcon className="size-3.5 text-amber-500" />
      )}
    </Swap>
  );
}

/** The turn's git commands as a rail: what each does, the command, how long it took, and its last line of output. */
function GitSteps({ steps }: { steps: GitStep[] }) {
  const ticking = steps.some((s) => s.state === "running");
  const now = useNow(ticking);
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <div className="mt-3 border-t pt-3 text-xs">
      <p className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        <TerminalIcon className="size-3.5 shrink-0" />
        <span>Git</span>
        <span className="flex-1" />
        <span className="tabular-nums" aria-live="polite">
          {done}/{steps.length}
        </span>
      </p>
      <ol aria-label="Git steps">
        <AnimatePresence initial={false}>
          {steps.map((s, i) => {
            const t = stepTimes.get(s.id);
            const took = t ? (t.end ?? (s.state === "running" ? now : undefined)) : undefined;
            return (
              <motion.li
                key={s.id}
                layout="position"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={SPRING}
                className="relative flex gap-2 py-1"
              >
                {/* The rail to the next step, filled once this one is done. */}
                {i < steps.length - 1 && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-5 -bottom-1 left-[7.5px] w-px transition-colors duration-500",
                      s.state === "done" ? "bg-brand/50" : "bg-border",
                    )}
                  />
                )}
                <StepGlyph state={s.state} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate", s.state === "failed" ? "text-coral" : "text-foreground")}>{s.label}</span>
                    <span className="flex-1" />
                    {s.state === "waiting" ? (
                      <span className="shrink-0 text-amber-600 dark:text-amber-500">Waiting for you</span>
                    ) : (
                      t &&
                      took !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">{duration(took - t.start)}</span>
                    )}
                  </div>
                  <code className="block truncate font-mono text-[11px] text-muted-foreground" title={s.command}>
                    <span className="text-muted-foreground/60 select-none">$ </span>
                    {s.command}
                  </code>
                  {s.state === "running" && (
                    <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-foreground/[0.04]">
                      <span
                        data-ci-bar
                        className="block h-full w-full rounded-full bg-brand/60"
                        style={{
                          backgroundImage: "linear-gradient(90deg, transparent, oklch(1 0 0 / 0.6), transparent)",
                          backgroundSize: "50% 100%",
                          backgroundRepeat: "no-repeat",
                          animation: "ci-run 1.2s linear infinite",
                        }}
                      />
                    </span>
                  )}
                  {s.note && (
                    <p className={cn("truncate font-mono text-[11px]", s.state === "failed" ? "text-coral/80" : "text-muted-foreground/70")} title={s.note}>
                      {s.note}
                    </p>
                  )}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
}

// --- the commit graph -------------------------------------------------------------------

const ROW = 28;
const LANE = 12;
const PAD = 7;
/** Commit rows shown before "Show more". */
const FOLDED = 12;

/** Other branches' lines and chips, a colour per lane like the graph panel's. Never the brand teal or the merged violet. */
const OTHER: [line: string, chip: string][] = [
  ["text-amber-500", "bg-amber-500/10 text-amber-700 dark:text-amber-400"],
  ["text-sky-500", "bg-sky-500/10 text-sky-700 dark:text-sky-400"],
  ["text-rose-500", "bg-rose-500/10 text-rose-700 dark:text-rose-400"],
  ["text-green-600 dark:text-green-500", "bg-green-500/10 text-green-700 dark:text-green-400"],
  ["text-orange-500", "bg-orange-500/10 text-orange-700 dark:text-orange-400"],
  ["text-fuchsia-500", "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400"],
];
const other = (lane: number) => OTHER[lane % OTHER.length];

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
  // The merge node has both parents, like the merge commit it stands for: the branch's tip and the base's.
  const parents = [s.uncommitted > 0 ? "~work" : s.head];
  if (s.baseHead !== s.head && shas.has(s.baseHead)) parents.push(s.baseHead);
  const rows: Row[] = [{ key: "~merge", parents, special: "merge", kind: "ours" }];
  if (s.uncommitted > 0) rows.push({ key: "~work", parents: [s.head], special: "work", kind: "ours" });
  for (const c of s.commits) {
    rows.push({ key: c.sha, parents: c.parents, commit: c, kind: c.onBase ? "base" : mainline.has(c.sha) ? "ours" : "other" });
  }
  return rows;
}

function Graph({
  status: s,
  verdict: v,
  merged,
  phase,
}: {
  status: BranchStatus;
  verdict: Verdict;
  merged: boolean;
  phase: MergePhase;
}) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => buildRows(s), [s]);
  const { cols, edges: laid, lanes } = useMemo(() => layout(rows), [rows]);
  const edges = laid.map((e) => {
    const fromMerge = rows[e.from].special === "merge";
    const kind = rows[e.from].kind === "other" ? "other" : rows[e.to].kind;
    // Into the merge node: dashed while it's still to come, solid once merged.
    return { ...e, kind, fromMerge, dashed: !!rows[e.from].special && !(fromMerge && merged) };
  });
  const special = rows.filter((r) => r.special).length;
  const shown = open ? rows.length : Math.min(rows.length, special + FOLDED);
  const hidden = rows.length - shown;
  const width = PAD * 2 + (lanes - 1) * LANE;
  const color = (kind: Kind, lane: number) =>
    kind === "ours" ? (merged ? "text-violet-500" : "text-brand") : kind === "base" ? "text-muted-foreground/45" : other(lane)[0];

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

  // While the branch is pushed, its commits travel up its line to the merge node; while it merges, the base's line joins them.
  const flowing =
    reduceMotion || !phase || phase === "merged"
      ? []
      : edges.filter((e) => e.to < shown && (e.kind === "ours" || (phase === "merge" && e.fromMerge)));

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
              // A merge edge turning solid is a new path, so it draws itself in.
              const key = `${rows[e.from].key}>${rows[e.to].key}${e.fromMerge && !e.dashed ? ":merged" : ""}`;
              return (
                <motion.path
                  key={key}
                  initial={e.dashed ? { d, opacity: 0 } : { d, opacity: 0, pathLength: 0 }}
                  animate={e.dashed ? { d, opacity: 1 } : { d, opacity: 1, pathLength: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    ...SPRING,
                    delay: delay(e.to) + 0.05,
                    pathLength: { duration: e.fromMerge ? 0.7 : 0.4, ease: "easeOut", delay: delay(e.to) + 0.05 },
                  }}
                  fill="none"
                  strokeWidth={e.fromMerge && merged ? 2 : 1.5}
                  stroke="currentColor"
                  strokeDasharray={e.dashed ? "2 3" : undefined}
                  // While checks run or the branch merges, the dashes into the merge node flow up toward it.
                  data-ci-flow={e.dashed && (v.tone === "progress" || phase === "merge") ? "" : undefined}
                  className={cn(fade, e.fromMerge && merged ? "text-violet-500" : color(e.kind, e.lane))}
                />
              );
            })}
          </AnimatePresence>
          {/* Pulses riding the lines up into the merge node. Each path runs child to parent, so they ride it backwards. */}
          <g>
            {flowing.map((e) => {
              const d = edgePath(GEOMETRY, e, cols);
              const dur = 0.45 * Math.max(1, e.to - e.from);
              return [0, 0.5].map((at) => (
                <circle
                  key={`${rows[e.from].key}>${rows[e.to].key}:${phase}:${at}`}
                  r={2}
                  fill="currentColor"
                  className={phase === "merge" ? "text-violet-500" : e.kind === "ours" ? "text-brand" : "text-muted-foreground"}
                >
                  <animateMotion dur={`${dur}s`} begin={`${at * dur}s`} repeatCount="indefinite" path={d} keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
                  <animate attributeName="opacity" dur={`${dur}s`} begin={`${at * dur}s`} repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.15;0.8;1" />
                </circle>
              ));
            })}
          </g>
          <AnimatePresence initial={entering}>
            {rows.slice(0, shown).map((r, i) => {
              const [cx, cy] = [x(cols[i]), y(i)];
              const special = r.special === "merge";
              const hollow = r.special === "work" || (r.commit?.parents.length ?? 0) > 1;
              const tone = phase === "merge" ? "merged" : v.tone;
              return (
                <motion.circle
                  key={r.key}
                  initial={{ cx, cy, r: 0 }}
                  animate={{ cx, cy, r: special ? (merged ? 6 : 5) : 3.5 }}
                  exit={{ r: 0, opacity: 0 }}
                  transition={{ ...SPRING, delay: delay(i) }}
                  strokeWidth={hollow ? 1.5 : 0}
                  stroke="currentColor"
                  className={cn(
                    fade,
                    special
                      ? cn("fill-current", DOT_FILL[tone])
                      : hollow
                        ? cn("fill-card", color(r.kind, cols[i]))
                        : cn("fill-current", color(r.kind, cols[i])),
                  )}
                />
              );
            })}
          </AnimatePresence>
          {/* While the branch is pushed or merged, the merge node breathes where the work arrives. */}
          {!reduceMotion && (phase === "push" || phase === "merge") && (
            <motion.circle
              key={phase}
              cx={x(cols[0])}
              cy={y(0)}
              initial={{ r: 5, opacity: 0.6 }}
              animate={{ r: 9, opacity: 0 }}
              transition={{ duration: 1.1, ease: "easeOut", repeat: Infinity }}
              fill="none"
              strokeWidth={1.5}
              stroke="currentColor"
              className={phase === "merge" ? "text-violet-500" : "text-brand"}
            />
          )}
          {/* A ring ripples out of the merge node whenever the verdict lands: ready, merged, blocked or conflicted. */}
          <AnimatePresence>
            {!entering && (v.tone === "good" || v.tone === "merged" || v.tone === "bad" || v.tone === "warn") && (
              <motion.circle
                key={v.tone}
                cx={x(cols[0])}
                cy={y(0)}
                initial={{ r: 5, opacity: 0.7 }}
                animate={{ r: v.tone === "merged" ? 14 : 10, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: v.tone === "merged" ? 1.2 : 0.9, ease: "easeOut" }}
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
              <GraphRow row={r} lane={cols[i]} status={s} verdict={v} merged={merged} phase={phase} />
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

function GraphRow({
  row,
  lane,
  status: s,
  verdict: v,
  merged,
  phase,
}: {
  row: Row;
  lane: number;
  status: BranchStatus;
  verdict: Verdict;
  merged: boolean;
  phase: MergePhase;
}) {
  const kind = row.kind;
  const line = "flex h-7 items-center gap-2";
  if (row.special === "merge") {
    const doing = merged ? "Merged into" : phase === "push" ? "Pushing, then merging into" : phase === "merge" ? "Merging into" : "Merge into";
    return (
      <div className={line}>
        <Swap id={doing} className={cn("min-w-0 flex-1 truncate", phase === "merge" || merged ? "text-foreground" : "text-muted-foreground")}>
          <span className="truncate">
            {doing} <span className="font-mono text-xs">{s.base}</span>
          </span>
        </Swap>
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
    other: other(lane)[1],
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
  const { input, pr: reported, status, checks, failure, failureError, failedJob, verdict: judged } = useCard(source, part);
  const { pr, verdict: given } = useLanded(threadId, input.base, status, reported, judged);
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
