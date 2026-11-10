// The CRM's table: one row per record, columns from the view, every cell
// editable in place (click it, or focus it and press Enter). The name opens
// the record. Sorting is the view's, so a header click changes the view.

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { FieldDisplay, FieldEditor, RecordMark } from "@/components/crm-fields";
import { formatMoney, type FieldDef } from "@/lib/crm";
import type { CrmRecord, CrmSettings, CrmView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const WIDTHS: Record<string, string> = {
  name: "minmax(220px, 1.6fr)",
  stage: "150px",
  value: "130px",
  probability: "110px",
  health: "130px",
  closeDate: "120px",
  renewalDate: "120px",
  updatedAt: "110px",
  owner: "130px",
};
const widthOf = (f: FieldDef) => WIDTHS[f.id] ?? "minmax(140px, 1fr)";

export function CrmTable({
  rows,
  fields,
  settings,
  sort,
  onSort,
  selected,
  onSelectedChange,
  onOpen,
}: {
  rows: CrmRecord[];
  fields: FieldDef[];
  settings: CrmSettings;
  sort: CrmView["sort"];
  onSort: (sort: CrmView["sort"]) => void;
  selected: Set<string>;
  onSelectedChange: (ids: Set<string>) => void;
  onOpen: (record: CrmRecord) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; field: string } | null>(null);
  const template = ["40px", ...fields.map(widthOf)].join(" ");
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someChecked = rows.some((r) => selected.has(r.id));
  const showTotal = fields.some((f) => f.id === "value");
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const cycleSort = (field: string) => {
    if (sort?.field !== field) onSort({ field, desc: false });
    else if (!sort.desc) onSort({ field, desc: true });
    else onSort(null);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
      <div role="table" aria-rowcount={rows.length} className="min-w-fit rounded-xl border bg-card">
        <div
          role="row"
          style={{ gridTemplateColumns: template }}
          className="sticky top-0 z-10 grid items-center rounded-t-xl border-b bg-card/95 backdrop-blur-sm"
        >
          <div role="columnheader" className="flex justify-center py-2">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked && !allChecked;
              }}
              onChange={() => onSelectedChange(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
              className="size-4 cursor-pointer accent-brand"
            />
          </div>
          {fields.map((f) => {
            const active = sort?.field === f.id;
            const right = f.type === "money" || f.type === "percent";
            return (
              <div
                key={f.id}
                role="columnheader"
                aria-sort={active ? (sort!.desc ? "descending" : "ascending") : "none"}
                className={cn("px-3 py-2", right && "text-right")}
              >
                <button
                  type="button"
                  onClick={() => cycleSort(f.id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                    active && "text-foreground",
                  )}
                >
                  {f.label}
                  {active && (sort!.desc ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
                </button>
              </div>
            );
          })}
        </div>

        <div role="rowgroup" className="divide-y">
          {rows.map((r) => {
            const isSel = selected.has(r.id);
            return (
              <div
                key={r.id}
                role="row"
                style={{ gridTemplateColumns: template }}
                className={cn("group grid min-h-10 items-center text-sm transition-colors", isSel ? "bg-brand/8" : "hover:bg-muted/50")}
              >
                <div role="cell" className="flex justify-center">
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.name}`}
                    checked={isSel}
                    onChange={() => toggle(r.id)}
                    className="size-4 cursor-pointer accent-brand"
                  />
                </div>
                {fields.map((f) => {
                  const isEditing = editing?.id === r.id && editing.field === f.id;
                  const right = f.type === "money" || f.type === "percent";
                  if (f.id === "name") {
                    return (
                      <div role="cell" key={f.id} className="flex min-w-0 items-center gap-2 px-3 py-1">
                        <RecordMark record={r} />
                        {isEditing ? (
                          <FieldEditor record={r} field={f} onDone={() => setEditing(null)} />
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpen(r)}
                            onKeyDown={(e) => {
                              if (e.key === "F2") setEditing({ id: r.id, field: f.id });
                            }}
                            title="Open"
                            className="min-w-0 truncate rounded text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            {r.name}
                          </button>
                        )}
                      </div>
                    );
                  }
                  if (isEditing) {
                    return (
                      <div role="cell" key={f.id} className="min-w-0 px-2 py-1">
                        <FieldEditor record={r} field={f} onDone={() => setEditing(null)} />
                      </div>
                    );
                  }
                  const readOnly = f.id === "updatedAt" || f.type === "health";
                  return (
                    <div role="cell" key={f.id} className="min-w-0 px-1 py-1">
                      <button
                        type="button"
                        disabled={readOnly}
                        aria-label={`${f.label}: edit`}
                        onClick={() => setEditing({ id: r.id, field: f.id })}
                        className={cn(
                          "flex h-8 w-full min-w-0 items-center rounded-md px-2 text-left text-foreground/90 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                          !readOnly && "hover:bg-muted",
                          readOnly && "text-muted-foreground",
                          right && "justify-end",
                        )}
                      >
                        <FieldDisplay record={r} field={f} settings={settings} />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {rows.length > 0 && (
          <div
            style={{ gridTemplateColumns: template }}
            className="grid items-center rounded-b-xl border-t bg-muted/30 text-xs text-muted-foreground"
          >
            <span />
            {fields.map((f, i) => (
              <span key={f.id} className={cn("px-3 py-2", f.type === "money" && "text-right tabular-nums")}>
                {i === 0 && `${rows.length} ${rows.length === 1 ? "record" : "records"}`}
                {f.id === "value" && showTotal && <span className="font-medium text-foreground">{formatMoney(total, settings.currency)}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
