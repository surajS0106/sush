// The Security and Review pages: run a security review or a code review of a
// Cowork folder, read its findings, open each in the file viewer or hand it
// to a Cowork session to fix, and reopen past ones (`lib/reports.ts`).
// Also the folder picker and empty state the Wiki page shares.

import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleStopIcon,
  FileCodeIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HandIcon,
  MessageSquareTextIcon,
  MoreHorizontalIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatWhen } from "@/lib/automations";
import {
  deleteReport,
  fixFinding,
  githubConnected,
  KIND_LABEL,
  startReport,
  stopReport,
  useReportActivity,
  useReports,
  useReportState,
  viewFile,
  type ReportState,
} from "@/lib/reports";
import { useConnectorStatus } from "@/lib/library";
import { createStore } from "@/lib/store";
import { errorMessage, type Finding, type Report, type ReportScope, type Severity, type Workspace } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { addWorkspace, useGitInfo, useWorkspaces } from "@/lib/workspaces";

type Kind = "security" | "review";

const PAGE: Record<Kind, { title: string; description: string }> = {
  security: { title: "Security", description: "Find vulnerabilities in a folder's code, then fix them in a Cowork session." },
  review: { title: "Review", description: "Review your changes, a branch or a pull request before it ships." },
};

export function ReportsPage({ kind, onOpenSession }: { kind: Kind; onOpenSession: (id: string) => void }) {
  const [workspace, choose] = useReportWorkspace();
  const all = useReports();
  const list = workspace ? all.filter((r) => r.kind === kind && r.workspaceId === workspace.id) : [];
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.find((r) => r.id === openId);
  const page = PAGE[kind];

  return (
    <ReportsLayout
      title={page.title}
      description={page.description}
      workspace={workspace}
      onChoose={(id) => {
        choose(id);
        setOpenId(null);
      }}
    >
      {!workspace ? null : open ? (
        <ReportView report={open} onBack={() => setOpenId(null)} onOpen={setOpenId} onOpenSession={onOpenSession} />
      ) : (
        <>
          <NewReport kind={kind} workspace={workspace} onStarted={(r) => setOpenId(r.id)} />
          <section aria-labelledby="past-reports" className="mt-10">
            <h2 id="past-reports" className="text-sm font-medium text-muted-foreground">
              Past reviews
            </h2>
            {list.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No reviews of {workspace.name} yet.</p>
            ) : (
              <ul className="mt-2 divide-y rounded-xl border">
                {list.map((r) => (
                  <ReportRow key={r.id} report={r} onOpen={() => setOpenId(r.id)} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </ReportsLayout>
  );
}

// --- shared with the Wiki page ------------------------------------------------------------

/** The folder the Security, Review and Wiki pages show; remembered. */
const chosen = createStore<string | null>("sush.reports.workspace", null);

/** The chosen folder, or the first one if it's gone; null with no folders at all. */
export function useReportWorkspace(): [Workspace | null, (id: string) => void] {
  const all = useWorkspaces();
  const id = useSyncExternalStore(chosen.subscribe, chosen.get);
  return [all.find((w) => w.id === id) ?? all[0] ?? null, (next) => chosen.set(next)];
}

async function pickFolder(): Promise<Workspace | null> {
  try {
    return await addWorkspace();
  } catch (e) {
    toast.error(errorMessage(e));
    return null;
  }
}

/** A page's frame: its heading with the folder picker, then the page, or a prompt to choose a folder. */
export function ReportsLayout({
  title,
  description,
  workspace,
  onChoose,
  wide,
  children,
}: {
  title: string;
  description: string;
  workspace: Workspace | null;
  onChoose: (id: string) => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto w-full px-8 pt-12 pb-16", wide ? "max-w-6xl" : "max-w-4xl")}>
        <header className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-2 text-muted-foreground">{description}</p>
          </div>
          {workspace && <WorkspaceSelect workspace={workspace} onChoose={onChoose} />}
        </header>
        {workspace ? <div className="mt-8">{children}</div> : <NoWorkspace onChoose={onChoose} />}
      </div>
    </div>
  );
}

const ADD = "__add";

function WorkspaceSelect({ workspace, onChoose }: { workspace: Workspace; onChoose: (id: string) => void }) {
  const workspaces = useWorkspaces();
  return (
    <Select
      value={workspace.id}
      onValueChange={async (v) => {
        if (v !== ADD) return onChoose(v);
        const added = await pickFolder();
        if (added) onChoose(added.id);
      }}
    >
      <SelectTrigger className="w-56" aria-label="Folder">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((w) => (
          <SelectItem key={w.id} value={w.id} title={w.root}>
            <FolderIcon /> <span className="truncate">{w.name}</span>
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={ADD}>
          <FolderPlusIcon /> Add a folder…
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function NoWorkspace({ onChoose }: { onChoose: (id: string) => void }) {
  return (
    <div className="mt-10 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl border bg-card">
        <FolderOpenIcon className="size-5 text-muted-foreground" />
      </span>
      <div>
        <p className="font-medium">Choose a folder to work on</p>
        <p className="mt-1 text-sm text-muted-foreground">Sush reads it to review or document it, without changing anything.</p>
      </div>
      <Button
        className="mt-1"
        onClick={async () => {
          const added = await pickFolder();
          if (added) onChoose(added.id);
        }}
      >
        <FolderPlusIcon /> Choose a folder…
      </Button>
    </div>
  );
}

/** Inline code naming a file, e.g. `src/app.ts:42`, as markdown renders it. */
const FILE_REF = /^((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]+)(?::(\d+)(?:[-–]\d+)?)?$/;

/**
 * Click handler for rendered markdown: inline code that names a file opens it
 * in the folder's file viewer. Pair with `CODE_LINKS` for the cursor.
 */
export function openCodeLinks(workspaceId: string, onOpenSession: (id: string) => void) {
  return (e: React.MouseEvent) => {
    const code = (e.target as HTMLElement).closest("code");
    if (!code || code.closest("pre")) return;
    const m = (code.textContent ?? "").trim().match(FILE_REF);
    if (!m) return;
    e.preventDefault();
    onOpenSession(viewFile(workspaceId, m[1], m[2] ? Number(m[2]) : undefined));
  };
}

export const CODE_LINKS = "[&_:not(pre)>code]:cursor-pointer [&_:not(pre)>code:hover]:underline";

/** A report's state as a small label. */
export function StateLabel({ state, className }: { state: ReportState; className?: string }) {
  const [Icon, text, tone] = {
    running: [Spinner, "Running", "text-muted-foreground"],
    "needs-input": [HandIcon, "Waiting for you", "text-brand"],
    done: [CircleCheckIcon, "Done", "text-emerald-700 dark:text-emerald-400"],
    stopped: [CircleStopIcon, "Stopped", "text-muted-foreground"],
    failed: [CircleAlertIcon, "Failed", "text-destructive"],
  }[state] as [typeof Spinner, string, string];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", tone, className)}>
      <Icon className="size-3.5" /> {text}
    </span>
  );
}

/** What the run is doing, while it runs; or that it waits on the user. */
export function RunProgress({ report, state, onOpenSession }: { report: Report; state: ReportState; onOpenSession: (id: string) => void }) {
  const { now, read } = useReportActivity(report.threadId);
  if (state === "needs-input") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand/40 bg-brand/5 p-4">
        <HandIcon className="size-4 text-brand" />
        <p className="min-w-0 flex-1 text-sm">It wants to read a file that may hold secrets, and is waiting for your approval.</p>
        <Button size="sm" variant="outline" onClick={() => onOpenSession(report.threadId)}>
          Review the request
        </Button>
      </div>
    );
  }
  if (state !== "running") return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4" role="status" aria-live="polite">
      <Spinner className="text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-sm">{now}</p>
      {read > 0 && <span className="shrink-0 text-xs text-muted-foreground">{read === 1 ? "1 file read" : `${read} files read`}</span>}
    </div>
  );
}

// --- starting one ---------------------------------------------------------------------

type ScopeType = ReportScope["type"];

const SCOPES: Record<Kind, { type: ScopeType; label: string; hint: string; icon: typeof ShieldIcon }[]> = {
  security: [
    { type: "project", label: "Whole project", hint: "Everything in the folder", icon: FolderIcon },
    { type: "uncommitted", label: "Uncommitted changes", hint: "What you haven't committed yet", icon: FileCodeIcon },
    { type: "branch", label: "This branch", hint: "Commits since it left another branch", icon: GitBranchIcon },
  ],
  review: [
    { type: "uncommitted", label: "Uncommitted changes", hint: "What you haven't committed yet", icon: FileCodeIcon },
    { type: "branch", label: "This branch", hint: "Commits since it left another branch", icon: GitBranchIcon },
    { type: "pull-request", label: "Pull request", hint: "On GitHub, through its connector", icon: GitPullRequestIcon },
  ],
};

/** `owner/repo#12` or a pull request's GitHub URL. */
function parsePullRequest(text: string): { repo: string; number: number } | null {
  const t = text.trim();
  const m = t.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) ?? t.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

function NewReport({ kind, workspace, onStarted }: { kind: Kind; workspace: Workspace; onStarted: (r: Report) => void }) {
  const git = useGitInfo(workspace.id);
  useConnectorStatus(); // re-render as connectors come and go
  const github = githubConnected();
  const [type, setType] = useState<ScopeType>(SCOPES[kind][0].type);
  const others = git?.branches.filter((b) => b !== git.branch) ?? [];
  const [base, setBase] = useState<string | null>(null);
  const baseBranch = base && others.includes(base) ? base : (others.find((b) => b === "main" || b === "master") ?? others[0]);
  const [pr, setPr] = useState("");
  const [starting, setStarting] = useState(false);

  const unavailable = (t: ScopeType): string | null => {
    if ((t === "uncommitted" || t === "branch") && !git) return "The folder isn't a git repository.";
    if (t === "branch" && others.length === 0) return "There's no other branch to compare with.";
    if (t === "pull-request" && !github) return "Connect GitHub in Settings → Connectors first.";
    return null;
  };
  const pullRequest = parsePullRequest(pr);
  const scope: ReportScope | null =
    type === "project"
      ? { type: "project" }
      : type === "uncommitted"
        ? { type: "uncommitted" }
        : type === "branch"
          ? baseBranch
            ? { type: "branch", base: baseBranch }
            : null
          : pullRequest && { type: "pull-request", ...pullRequest };
  const blocked = unavailable(type);

  const run = async () => {
    if (!scope || blocked) return;
    setStarting(true);
    const report = await startReport(kind, workspace.id, scope);
    setStarting(false);
    if (report) onStarted(report);
  };

  return (
    <section aria-labelledby="new-report" className="rounded-xl border bg-card p-5">
      <h2 id="new-report" className="font-medium">
        New {KIND_LABEL[kind].toLowerCase()}
      </h2>
      <div role="radiogroup" aria-label="What to review" className="mt-4 grid gap-2 sm:grid-cols-3">
        {SCOPES[kind].map((s) => (
          <button
            key={s.type}
            type="button"
            role="radio"
            aria-checked={type === s.type}
            onClick={() => setType(s.type)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
              type === s.type && "border-foreground/40 bg-muted/60",
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <s.icon className="size-4 text-muted-foreground" /> {s.label}
            </span>
            <span className="text-xs text-muted-foreground">{s.hint}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {type === "branch" && !blocked && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{git?.branch ?? "HEAD"}</span> compared with
            </span>
            <Select value={baseBranch} onValueChange={setBase}>
              <SelectTrigger size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        {type === "pull-request" && !blocked && (
          <Input
            value={pr}
            onChange={(e) => setPr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
            placeholder="owner/repo#123 or the pull request's URL"
            aria-label="Pull request"
            className="h-8 w-80"
          />
        )}
        {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
        <Button className="ml-auto" disabled={!scope || !!blocked || starting} onClick={() => void run()}>
          {starting ? <Spinner /> : <PlayIcon />} Run {KIND_LABEL[kind].toLowerCase()}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Sush only reads the code for this. Fixes happen in a Cowork session, where you can undo them.</p>
    </section>
  );
}

// --- past reports -----------------------------------------------------------------------

const SEVERITIES: { value: Severity; label: string; className: string }[] = [
  { value: "critical", label: "Critical", className: "bg-red-600 text-white dark:bg-red-500" },
  { value: "high", label: "High", className: "bg-red-500/15 text-red-700 dark:text-red-400" },
  { value: "medium", label: "Medium", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  { value: "low", label: "Low", className: "bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  { value: "info", label: "Info", className: "bg-muted text-muted-foreground" },
];
const rank = (s: Severity) => SEVERITIES.findIndex((x) => x.value === s);
const bySeverity = (a: Finding, b: Finding) => rank(a.severity) - rank(b.severity);

function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITIES.find((x) => x.value === severity)!;
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs font-medium", s.className)}>{s.label}</span>;
}

/** "2 high · 1 medium". */
function countLine(findings: Finding[]): string {
  if (findings.length === 0) return "No issues found";
  return SEVERITIES.map((s) => [s.label.toLowerCase(), findings.filter((f) => f.severity === s.value).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`)
    .join(" · ");
}

function ReportRow({ report, onOpen }: { report: Report; onOpen: () => void }) {
  const state = useReportState(report);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{report.title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{formatWhen(new Date(report.createdAt))}</span>
        </span>
        {state === "done" && <span className="text-xs text-muted-foreground">{countLine(report.findings)}</span>}
        <StateLabel state={state} className={cn(state === "done" && "sr-only")} />
      </button>
    </li>
  );
}

function ReportView({
  report,
  onBack,
  onOpen,
  onOpenSession,
}: {
  report: Report;
  onBack: () => void;
  onOpen: (id: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const state = useReportState(report);
  const kind = report.kind as Kind;
  const busy = state === "running" || state === "needs-input";
  const links = openCodeLinks(report.workspaceId, onOpenSession);
  const findings = [...report.findings].sort(bySeverity);
  // A review reads by file; a security review by how bad each one is.
  const groups: [string | null, Finding[]][] = [[null, findings]];
  if (kind === "review") {
    const byFile = new Map<string | null, Finding[]>();
    for (const f of findings) byFile.set(f.file ?? null, [...(byFile.get(f.file ?? null) ?? []), f]);
    groups.splice(0, 1, ...[...byFile].sort(([a], [b]) => (a ?? "￿").localeCompare(b ?? "￿")));
  }

  return (
    <div>
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
        <ArrowLeftIcon /> All reviews
      </Button>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{report.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatWhen(new Date(report.createdAt))}</span>
            {report.commit && <span className="font-mono">{report.commit.slice(0, 7)}</span>}
            <StateLabel state={state} />
          </p>
        </div>
        {busy ? (
          <Button variant="outline" onClick={() => stopReport(report)}>
            <CircleStopIcon /> Stop
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={async () => {
              const again = await startReport(kind, report.workspaceId, report.scope);
              if (again) onOpen(again.id);
            }}
          >
            <RotateCcwIcon /> Run again
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Review options">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => onOpenSession(report.threadId)}>
              <MessageSquareTextIcon /> View transcript
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                onBack();
                void deleteReport(report);
              }}
            >
              <Trash2Icon /> Delete review
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-6 grid gap-4">
        <RunProgress report={report} state={state} onOpenSession={onOpenSession} />
        {state === "failed" && (
          <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" /> {report.error ?? "The review stopped with an error."}
          </p>
        )}
        {report.summary && (
          <div className={cn("rounded-xl border bg-card p-4 text-sm", CODE_LINKS)} onClick={links}>
            <MessageResponse>{report.summary}</MessageResponse>
          </div>
        )}
        {!busy && report.findings.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {state === "done"
              ? "No issues found."
              : "This review ended before it recorded any findings. Run it again, or open its transcript to see how far it got."}
          </p>
        )}
        {report.findings.length > 0 && <p className="text-sm text-muted-foreground">{countLine(report.findings)}</p>}
        {groups.map(([file, items]) => (
          <section key={file ?? ""} aria-label={file ?? "Findings"} className="grid gap-3">
            {kind === "review" && <h3 className="mt-2 font-mono text-sm">{file ?? "General"}</h3>}
            {items.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                kind={kind}
                onView={() => f.file && onOpenSession(viewFile(report.workspaceId, f.file, f.line))}
                onFix={() => {
                  const id = fixFinding(report, f);
                  if (id) onOpenSession(id);
                }}
                onLinks={links}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function FindingCard({
  finding: f,
  kind,
  onView,
  onFix,
  onLinks,
}: {
  finding: Finding;
  kind: Kind;
  onView: () => void;
  onFix: () => void;
  onLinks: (e: React.MouseEvent) => void;
}) {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null;
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <SeverityBadge severity={f.severity} />
        <h4 className="min-w-0 flex-1 font-medium">{f.title}</h4>
      </div>
      {where && (
        <button type="button" onClick={onView} className="mt-1.5 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
          {where}
        </button>
      )}
      <div className={cn("mt-3 text-sm", CODE_LINKS)} onClick={onLinks}>
        <MessageResponse>{f.description}</MessageResponse>
      </div>
      {f.suggestion && (
        <div className={cn("mt-3 rounded-lg bg-muted/50 p-3 text-sm", CODE_LINKS)} onClick={onLinks}>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Suggested fix</p>
          <MessageResponse>{f.suggestion}</MessageResponse>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onFix}>
          <WrenchIcon /> {kind === "security" ? "Fix" : "Apply fix"}
        </Button>
        {f.file && (
          <Button size="sm" variant="outline" onClick={onView}>
            <FileCodeIcon /> Open file
          </Button>
        )}
      </div>
    </article>
  );
}
