// How the CRM tools (`lib/crm-tools.ts`) show in a chat: reads as one line,
// writes as a card listing each change (before → after) to approve or discard,
// and a proposed view as a card that opens it on the CRM page.

import type { DynamicToolUIPart } from "ai";
import { ContactIcon, ListFilterIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { RecordMark } from "@/components/crm-fields";
import { ToolResultRow } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { runsWithoutApproval, type ToolResult } from "@/lib/agent";
import { loadCrm, openCrmDraft, useCrm } from "@/lib/crm";
import {
  applyCrmLog,
  applyCrmWrite,
  changeLabel,
  changeValue,
  CRM_READ,
  CRM_SEARCH,
  CRM_VIEW,
  CRM_WRITE,
  planCrmLog,
  planCrmView,
  planCrmWrite,
  type PlannedChange,
} from "@/lib/crm-tools";
import { cn } from "@/lib/utils";

const DISCARDED = "The user discarded these changes. Don't make them; ask what they'd like instead if it isn't clear.";

export function CrmToolPart({
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
  const name = part.toolName;
  const row = (text: string, error?: boolean, detail?: string) => (
    <ToolResultRow
      error={error}
      detail={detail}
      label={
        <>
          <ContactIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );

  if (name === CRM_SEARCH || name === CRM_READ) {
    if (part.state === "input-streaming" || part.state === "input-available") return <LoadingState label="Looking in your CRM" />;
    if (part.state === "output-error") return row("Couldn't look in your CRM", true, part.errorText);
    let summary = name === CRM_READ ? "Read a CRM record" : "Searched your CRM";
    try {
      const out = JSON.parse(String(part.output));
      if (name === CRM_READ && out.name) summary = `Read “${out.name}”`;
      if (name === CRM_SEARCH && typeof out.matched === "number") summary = `Searched your CRM · ${out.matched} ${out.matched === 1 ? "record" : "records"}`;
    } catch {
      // A summary without the count.
    }
    return row(summary, false, String(part.output));
  }

  if (name === CRM_VIEW) return <ViewPart part={part} />;

  // crm_write and crm_log: a card while it waits, a line once answered.
  if (part.state === "input-streaming") return <LoadingState label={name === CRM_WRITE ? "Drafting CRM changes" : "Drafting a log entry"} />;
  if (part.state === "output-available") return row(name === CRM_WRITE ? "Updated your CRM" : "Logged it in your CRM", false, String(part.output));
  if (part.state === "output-error") return row(part.errorText === DISCARDED ? "CRM changes discarded" : "CRM not changed", part.errorText !== DISCARDED, part.errorText);
  if (running || runsWithoutApproval(name)) return <LoadingState label="Updating your CRM" />;
  if (!canAnswer) return <p className="text-sm text-muted-foreground italic">CRM wasn't changed</p>;
  return name === CRM_WRITE ? <WriteCard input={part.input} onResult={onResult} /> : <LogCard input={part.input} onResult={onResult} />;
}

function useLoaded() {
  const crm = useCrm();
  useEffect(() => {
    void loadCrm();
  }, []);
  return crm;
}

/** Tell the model once if its call can't be made. */
function useInvalid(error: string | null, onResult: (r: ToolResult) => void) {
  const sent = useRef(false);
  useEffect(() => {
    if (error && !sent.current) {
      sent.current = true;
      onResult({ errorText: error });
    }
  }, [error, onResult]);
}

function WriteCard({ input, onResult }: { input: unknown; onResult: (r: ToolResult) => void }) {
  const crm = useLoaded();
  // Planned once the CRM is loaded, and kept: a later change to the records shouldn't reshuffle the card.
  const plan = useMemo(() => (crm.loaded ? planCrmWrite(input, crm) : null), [crm.loaded, input]);
  useInvalid(plan && !plan.ok ? plan.error : null, onResult);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!plan) return <LoadingState label="Opening your CRM" />;
  if (!plan.ok) return null;
  const kept = plan.changes.filter((_, i) => !skipped.has(i));

  const apply = async () => {
    setBusy(true);
    const result = await applyCrmWrite(kept);
    const dropped = plan.changes.length - kept.length;
    if ("output" in result && dropped) {
      result.output = `${result.output} The user left out ${dropped} of the proposed changes: ${plan.changes
        .filter((_, i) => skipped.has(i))
        .map((c) => `"${c.after.name}"`)
        .join(", ")}.`;
    }
    onResult(result);
  };

  return (
    <Card
      title={plan.changes.length === 1 ? (plan.changes[0].action === "add" ? `Add this ${plan.changes[0].after.kind}?` : "Make this change?") : `Make these ${plan.changes.length} changes?`}
      busy={busy}
      confirm={kept.length === plan.changes.length ? "Apply" : `Apply ${kept.length}`}
      canConfirm={kept.length > 0}
      onDiscard={() => onResult({ errorText: DISCARDED })}
      onConfirm={() => void apply()}
    >
      <ul className="flex flex-col divide-y">
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
    </Card>
  );
}

function ChangeRow({ change, on, canToggle, onToggle }: { change: PlannedChange; on: boolean; canToggle: boolean; onToggle: () => void }) {
  const crm = useCrm();
  const fields =
    change.action === "add"
      ? ["companyId", "contactId", "stage", "value", "probability", "closeDate", "renewalDate", "owner", "email", "title", "domain", "category", "notes", "fields"].filter(
          (f) => f === "companyId" ? change.after.companyId || change.newCompany : !!changeValue(change.after, f, crm),
        )
      : change.changed;
  return (
    <li className={cn("flex gap-3 py-2", !on && "opacity-50")}>
      {canToggle && (
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={`Include ${change.after.name}`} className="mt-1 size-4 accent-brand" />
      )}
      <RecordMark record={change.after} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="text-muted-foreground">{change.action === "add" ? `New ${change.after.kind}` : "Update"} </span>
          <span className="font-medium">{change.after.name}</span>
          {change.before && change.before.name !== change.after.name && <span className="text-muted-foreground"> (was {change.before.name})</span>}
        </p>
        <dl className="mt-1 grid grid-cols-[96px_1fr] gap-x-2 gap-y-0.5 text-xs">
          {fields
            .filter((f) => f !== "name")
            .map((f) => {
              const before = change.before ? changeValue(change.before, f, crm) : "";
              const after = f === "companyId" && change.newCompany ? `${change.newCompany} (new company)` : changeValue(change.after, f, crm);
              return (
                <div key={f} className="contents">
                  <dt className="truncate text-muted-foreground">{changeLabel(f)}</dt>
                  <dd className="min-w-0 break-words">
                    {change.action === "update" && (
                      <span className="text-muted-foreground line-through decoration-muted-foreground/50">{before || "empty"}</span>
                    )}
                    {change.action === "update" && <span className="text-muted-foreground"> → </span>}
                    <span className={cn(!after && "text-muted-foreground")}>{after || "cleared"}</span>
                  </dd>
                </div>
              );
            })}
        </dl>
      </div>
    </li>
  );
}

function LogCard({ input, onResult }: { input: unknown; onResult: (r: ToolResult) => void }) {
  const crm = useLoaded();
  const plan = useMemo(() => (crm.loaded ? planCrmLog(input, crm) : null), [crm.loaded, input]);
  useInvalid(plan && !plan.ok ? plan.error : null, onResult);
  const [busy, setBusy] = useState(false);
  if (!plan) return <LoadingState label="Opening your CRM" />;
  if (!plan.ok) return null;
  const { log } = plan;
  return (
    <Card
      title={`Log this on “${log.record.name}”?`}
      busy={busy}
      confirm="Log it"
      canConfirm
      onDiscard={() => onResult({ errorText: DISCARDED })}
      onConfirm={async () => {
        setBusy(true);
        onResult(await applyCrmLog(log));
      }}
    >
      <p className="rounded-lg bg-muted/60 p-2 text-sm whitespace-pre-wrap">{log.body}</p>
    </Card>
  );
}

function Card({
  title,
  children,
  busy,
  confirm,
  canConfirm,
  onDiscard,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  confirm: string;
  canConfirm: boolean;
  onDiscard: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="w-full max-w-xl">
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <div className="flex gap-3 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
            <ContactIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-2 max-h-80 overflow-y-auto">{children}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 border-t p-2">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
          <Button size="sm" className="rounded-full" onClick={onConfirm} disabled={busy || !canConfirm}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ViewPart({ part }: { part: DynamicToolUIPart }) {
  const crm = useLoaded();
  if (part.state === "input-streaming" || part.state === "input-available") return <LoadingState label="Making a view" />;
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <ListFilterIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't make that view</span>
          </>
        }
      />
    );
  }
  if (!crm.loaded) return null;
  const plan = planCrmView(part.input, crm);
  if (!plan.ok) return null;
  return (
    <div className="flex w-full max-w-xl items-center gap-3 rounded-xl border bg-card p-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
        <ListFilterIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{plan.view.name}</p>
        <p className="text-xs text-muted-foreground">
          {plan.count} {plan.count === 1 ? "record" : "records"} now · {plan.view.filters.length} {plan.view.filters.length === 1 ? "filter" : "filters"}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => openCrmDraft(plan.view)}>
        Open view
      </Button>
    </div>
  );
}
