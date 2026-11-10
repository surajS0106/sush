// Pieces the CRM's table, board and record drawer share: a record's initial,
// its stage as a pill, and an editor for one field that saves on Enter or blur.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { MoneyInput } from "@/components/money-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dealHealth, fieldText, formatDate, formatMoney, recordById, stageOf, stagesFor, updateRecord, useCrm, type FieldDef } from "@/lib/crm";
import type { CrmRecord, CrmSettings, CrmStage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Radix's Select can't hold an empty value. */
export const NONE = "__none";

/** A record's first letter on a tile tinted with the accent (companies square, people round). */
export function RecordMark({ record, className }: { record: Pick<CrmRecord, "name" | "kind">; className?: string }) {
  const letter = record.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center bg-brand/12 text-[11px] font-semibold text-brand",
        record.kind === "contact" ? "rounded-full" : "rounded-md",
        className,
      )}
    >
      {letter}
    </span>
  );
}

/**
 * Open stages are neutral, won ones the accent, lost ones coral, each with a
 * dot in its colour. No check mark: menus use that for "selected".
 */
export function StagePill({ stage, className }: { stage: CrmStage | undefined; className?: string }) {
  if (!stage) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium",
        stage.tone === "won" && "bg-brand/12 text-brand",
        stage.tone === "lost" && "bg-coral/12 text-coral",
        stage.tone === "open" && "bg-muted text-foreground/80",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", stage.tone === "open" ? "bg-muted-foreground/60" : "bg-current")} />
      <span className="truncate">{stage.name}</span>
    </span>
  );
}

/** How a field reads when it isn't being edited. */
export function FieldDisplay({ record, field, settings }: { record: CrmRecord; field: FieldDef; settings: CrmSettings }) {
  switch (field.type) {
    case "stage":
      return <StagePill stage={stageOf(settings, record)} />;
    case "money":
      return <span className="tabular-nums">{formatMoney(record.value, settings.currency)}</span>;
    case "health": {
      const h = dealHealth(record, settings);
      if (!h) return null;
      return (
        <span className="flex w-full items-center gap-2" title={h.reasons.join(" · ")}>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className={cn("block h-full rounded-full", h.score < 35 ? "bg-coral" : "bg-brand")} style={{ width: `${h.score}%` }} />
          </span>
          <span className={cn("w-7 text-right text-xs tabular-nums", h.score < 35 && "text-coral")}>{h.score}</span>
        </span>
      );
    }
    case "percent":
      return record.probability == null ? null : <span className="tabular-nums">{record.probability}%</span>;
    case "date":
      return (
        <span className="tabular-nums">
          {field.id === "updatedAt" ? formatDate(fieldText(record, field.id, settings)) : formatDate((record as unknown as Record<string, string>)[field.id])}
        </span>
      );
    case "link": {
      const linked = recordById(field.id === "company" ? record.companyId : record.contactId);
      if (!linked) return null;
      return (
        <span className="flex min-w-0 items-center gap-2">
          <RecordMark record={linked} className="size-5 text-[10px]" />
          <span className="truncate">{linked.name}</span>
        </span>
      );
    }
    default: {
      const text = fieldText(record, field.id, settings);
      return <span className="truncate">{text}</span>;
    }
  }
}

/** The patch that sets `field` to `raw` (as typed), or an error. */
function patchFor(field: FieldDef, raw: string): Partial<CrmRecord> | string {
  const v = raw.trim();
  if (field.id.startsWith("fields.")) return { fields: { [field.id.slice(7)]: v } };
  switch (field.type) {
    case "money":
    case "number":
    case "percent": {
      if (!v) return { [field.type === "percent" ? "probability" : field.id]: undefined } as Partial<CrmRecord>;
      const n = Number(v.replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(n)) return "Enter a number.";
      if (field.type === "percent") return { probability: Math.round(Math.min(100, Math.max(0, n))) };
      return { [field.id]: n } as Partial<CrmRecord>;
    }
    default:
      if (field.id === "name" && !v) return "Give it a name.";
      return { [field.id]: v || undefined } as Partial<CrmRecord>;
  }
}

/**
 * One field in edit mode. Text, numbers and dates are typed (Enter or leaving
 * saves, Escape cancels); stages and links are picked and save at once.
 */
export function FieldEditor({
  record,
  field,
  onDone,
  className,
}: {
  record: CrmRecord;
  field: FieldDef;
  onDone: () => void;
  className?: string;
}) {
  const { records, settings } = useCrm();
  const initial =
    field.type === "date"
      ? ((record as unknown as Record<string, string>)[field.id] ?? "")
      : field.type === "percent"
        ? (record.probability?.toString() ?? "")
        : field.type === "money"
          ? (record.value?.toString() ?? "")
          : fieldText(record, field.id, settings);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const amount = useRef<number | null>(record.value ?? null);

  const commit = (raw: string) => {
    if (done.current) return;
    if (raw === initial) {
      done.current = true;
      onDone();
      return;
    }
    const patch = patchFor(field, raw);
    if (typeof patch === "string") {
      setError(patch);
      return;
    }
    done.current = true;
    if (patch.fields) patch.fields = { ...record.fields, ...patch.fields };
    void updateRecord(record.id, patch);
    onDone();
  };
  const cancel = () => {
    done.current = true;
    onDone();
  };

  if (field.type === "money") {
    const save = () => {
      if (done.current) return;
      done.current = true;
      if (amount.current !== (record.value ?? null)) void updateRecord(record.id, { value: amount.current ?? undefined });
      onDone();
    };
    return (
      <MoneyInput
        autoFocus
        compact
        aria-label={field.label}
        value={record.value}
        currency={settings.currency}
        onValueChange={(n) => (amount.current = n)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // The field fills out shorthand on Enter first; save after it has.
            queueMicrotask(save);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        className={className}
      />
    );
  }

  if (field.type === "stage" || field.type === "link") {
    const options: { id: string; label: ReactNode }[] =
      field.type === "stage"
        ? stagesFor(settings, record.kind).map((s) => ({ id: s.id, label: <StagePill stage={s} /> }))
        : records
            .filter((r) => r.kind === (field.id === "company" ? "company" : "contact"))
            // A deal's contact comes from its company when it has one.
            .filter((r) => field.id !== "contact" || record.kind !== "deal" || !record.companyId || r.companyId === record.companyId)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => ({ id: r.id, label: r.name }));
    const current = field.type === "stage" ? record.stage : field.id === "company" ? record.companyId : record.contactId;
    const key = field.type === "stage" ? "stage" : field.id === "company" ? "companyId" : "contactId";
    return (
      <Select
        defaultOpen
        value={current ?? NONE}
        onOpenChange={(open) => !open && onDone()}
        onValueChange={(v) => {
          void updateRecord(record.id, { [key]: v === NONE ? undefined : v } as Partial<CrmRecord>);
          onDone();
        }}
      >
        <SelectTrigger size="sm" className={cn("w-full", className)} aria-label={field.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            <span className="text-muted-foreground">No {field.label.toLowerCase()}</span>
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <TextEditor
      value={value}
      type={field.type === "date" ? "date" : field.type === "text" ? "text" : "number"}
      label={field.label}
      error={error}
      onChange={(v) => {
        setValue(v);
        setError(null);
      }}
      onCommit={commit}
      onCancel={cancel}
      className={className}
    />
  );
}

function TextEditor({
  value,
  type,
  label,
  error,
  onChange,
  onCommit,
  onCancel,
  className,
}: {
  value: string;
  type: "text" | "number" | "date";
  label: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (type !== "date") ref.current?.select();
  }, [type]);
  return (
    <input
      ref={ref}
      type={type}
      inputMode={type === "number" ? "decimal" : undefined}
      value={value}
      aria-label={label}
      aria-invalid={!!error}
      title={error ?? undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className={cn(
        "h-7 w-full min-w-0 rounded-md border border-ring bg-background px-2 text-sm outline-none ring-3 ring-ring/30",
        error && "border-coral ring-coral/20",
        type === "number" && "tabular-nums",
        className,
      )}
    />
  );
}
