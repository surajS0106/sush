// How the app feature tools (`lib/app-tools.ts`: Automations, Projects, Binders,
// Reports) show in a chat: a read as one line, a write as a card saying exactly
// what will change, to approve or discard.

import type { DynamicToolUIPart } from "ai";
import { FolderIcon, NotebookTextIcon, ShieldIcon, TimerIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ToolResultRow } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { runsWithoutApproval, type ToolResult } from "@/lib/agent";
import { appToolset, isAppRead, type AppPlan } from "@/lib/app-tools";
import { cn } from "@/lib/utils";

const DISCARDED = "The user said no to this. Don't do it; ask what they'd like instead if it isn't clear.";

const ICONS: Record<string, LucideIcon> = { automations: TimerIcon, projects: FolderIcon, binders: NotebookTextIcon, reports: ShieldIcon };

/** [while it runs, once done] for the reads. */
const READ_LABELS: Record<string, [string, string]> = {
  automation_list: ["Looking at your automations", "Looked at your automations"],
  project_list: ["Looking at your projects", "Looked at your projects"],
  binder_list: ["Looking at your binders", "Looked at your binders"],
  binder_search: ["Searching your binder", "Searched your binder"],
  reports_list: ["Looking at your reviews", "Looked at your reviews and wikis"],
  reports_read: ["Reading a report", "Read a report"],
};

export function AppToolPart({
  part,
  threadId,
  canAnswer,
  onResult,
  running,
}: {
  part: DynamicToolUIPart;
  threadId?: string;
  canAnswer: boolean;
  onResult: (result: ToolResult) => void;
  running: boolean;
}) {
  const set = appToolset(part.toolName);
  const Icon = ICONS[set?.id ?? ""] ?? FolderIcon;
  const row = (text: string, error?: boolean, detail?: string) => (
    <ToolResultRow
      error={error}
      detail={detail}
      label={
        <>
          <Icon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );

  if (isAppRead(part.toolName)) {
    const [busy, done] = READ_LABELS[part.toolName] ?? ["Working", "Done"];
    if (part.state === "input-streaming" || part.state === "input-available") return <LoadingState label={busy} />;
    if (part.state === "output-error") return row(`Couldn't do that: ${busy.toLowerCase()}`, true, part.errorText);
    const binder = part.toolName === "binder_search" && (part.input as { binder?: string } | undefined)?.binder;
    return row(binder ? `Searched “${binder}”` : done, false, String(part.output));
  }

  const noun = set?.noun ?? "the app";
  if (part.state === "input-streaming") return <LoadingState label="Drafting a change" />;
  if (part.state === "output-available") return row(`Changed ${noun}`, false, String(part.output));
  if (part.state === "output-error") return row(part.errorText === DISCARDED ? "Change declined" : "Nothing changed", part.errorText !== DISCARDED, part.errorText);
  if (running || runsWithoutApproval(part.toolName)) return <LoadingState label="Making the change" />;
  if (!canAnswer) return <p className="text-sm text-muted-foreground italic">Nothing was changed</p>;
  return <PlanCard part={part} threadId={threadId} icon={Icon} onResult={onResult} />;
}

function PlanCard({ part, threadId, icon: Icon, onResult }: { part: DynamicToolUIPart; threadId?: string; icon: LucideIcon; onResult: (r: ToolResult) => void }) {
  // Planned once: a later change elsewhere shouldn't reshuffle what the user is approving.
  const [plan, setPlan] = useState<AppPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const set = appToolset(part.toolName);
    if (!set) return onResult({ errorText: `Unknown tool ${part.toolName}.` });
    set
      .plan(part.toolName, (part.input ?? {}) as Record<string, unknown>, { threadId })
      .then((p) => ("error" in p ? onResult({ errorText: p.error }) : setPlan(p)))
      .catch((e) => onResult({ errorText: e instanceof Error ? e.message : String(e) }));
  }, [part.toolName, part.input, threadId, onResult]);

  if (!plan) return <LoadingState label="Checking" />;
  return (
    <div className="w-full max-w-xl">
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <div className="flex gap-3 p-3">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", plan.destructive ? "bg-destructive/10 text-destructive" : "bg-brand/12 text-brand")}>
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{plan.title}</p>
            {plan.rows.length > 0 && (
              <dl className="mt-2 grid grid-cols-[96px_1fr] gap-x-2 gap-y-0.5 text-xs">
                {plan.rows.map((r) => (
                  <div key={r.label} className="contents">
                    <dt className="truncate text-muted-foreground">{r.label}</dt>
                    <dd className="min-w-0 wrap-break-word">
                      {r.before !== undefined && (
                        <>
                          <span className="text-muted-foreground line-through decoration-muted-foreground/50">{r.before || "empty"}</span>
                          <span className="text-muted-foreground"> → </span>
                        </>
                      )}
                      {r.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {plan.body && <p className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-muted/60 p-2 text-sm whitespace-pre-wrap">{plan.body}</p>}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 border-t p-2">
          <Button variant="ghost" size="sm" className="rounded-full" disabled={busy} onClick={() => onResult({ errorText: DISCARDED })}>
            {plan.destructive ? "Keep it" : "Don't"}
          </Button>
          <Button
            size="sm"
            variant={plan.destructive ? "destructive" : "default"}
            className="rounded-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onResult(await plan.apply());
              } catch (e) {
                onResult({ errorText: e instanceof Error ? e.message : String(e) });
              }
            }}
          >
            {plan.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
