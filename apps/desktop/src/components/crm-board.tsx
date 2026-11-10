// The CRM's pipeline: a column per stage (and one for records with none),
// cards dragged between them with pointer events, since the webview's own
// drag and drop is taken by Tauri on Windows. Dropping a card moves its stage,
// which Rust logs as an activity. Arrow keys move a focused card too.

import { CalendarIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { RecordMark, StagePill } from "@/components/crm-fields";
import { daysUntil, formatDate, formatMoney, recordById, stagesFor, updateRecord } from "@/lib/crm";
import type { CrmKind, CrmRecord, CrmSettings, CrmStage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const NO_STAGE = "__none";

interface Drag {
  record: CrmRecord;
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  over?: string;
}

export function CrmBoard({
  kind,
  rows,
  settings,
  onOpen,
}: {
  kind: CrmKind;
  rows: CrmRecord[];
  settings: CrmSettings;
  onOpen: (record: CrmRecord) => void;
}) {
  const stages = stagesFor(settings, kind);
  const columns: { id: string; stage?: CrmStage }[] = [
    ...stages.map((s) => ({ id: s.id, stage: s })),
    ...(rows.some((r) => !r.stage || !stages.some((s) => s.id === r.stage)) ? [{ id: NO_STAGE }] : []),
  ];
  const columnOf = (r: CrmRecord) => (r.stage && stages.some((s) => s.id === r.stage) ? r.stage : NO_STAGE);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragged = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const move = (r: CrmRecord, column: string) => {
    if (column === columnOf(r)) return;
    void updateRecord(r.id, { stage: column === NO_STAGE ? undefined : column });
  };

  const columnAt = (x: number, y: number) =>
    (document.elementsFromPoint(x, y).find((el) => el instanceof HTMLElement && el.dataset.crmColumn) as HTMLElement | undefined)?.dataset
      .crmColumn;

  const startDrag = (record: CrmRecord, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const card = e.currentTarget.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    dragged.current = false;
    const onMove = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      active = true;
      dragged.current = true;
      setDrag({
        record,
        x: ev.clientX,
        y: ev.clientY,
        dx: start.x - card.left,
        dy: start.y - card.top,
        width: card.width,
        over: columnAt(ev.clientX, ev.clientY),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      stop();
      if (!active) return;
      const over = ev.type === "pointerup" ? columnAt(ev.clientX, ev.clientY) : undefined;
      if (over) move(record, over);
      setDrag(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      stop();
      setDrag(null);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("keydown", onKey);
      document.body.style.removeProperty("user-select");
      cleanup.current = null;
    };
    cleanup.current?.();
    cleanup.current = stop;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("keydown", onKey);
  };

  return (
    <div className={cn("flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6", drag && "cursor-grabbing")}>
      {columns.map((col, ci) => {
        const cards = rows.filter((r) => columnOf(r) === col.id);
        const total = cards.reduce((s, r) => s + (r.value ?? 0), 0);
        const over = drag?.over === col.id && columnOf(drag.record) !== col.id;
        return (
          <section
            key={col.id}
            data-crm-column={col.id}
            aria-label={col.stage?.name ?? "No stage"}
            className={cn("flex w-64 shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors", over && "border-brand bg-brand/6")}
          >
            <header className="flex items-center gap-2 px-3 pt-3 pb-2">
              {col.stage ? <StagePill stage={col.stage} /> : <span className="text-xs font-medium text-muted-foreground">No stage</span>}
              <span className="text-xs text-muted-foreground tabular-nums">{cards.length}</span>
              <span className="flex-1" />
              {total > 0 && <span className="text-xs text-muted-foreground tabular-nums">{formatMoney(total, settings.currency, true)}</span>}
            </header>
            <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {cards.map((r) => (
                <Card
                  key={r.id}
                  record={r}
                  settings={settings}
                  lifted={drag?.record.id === r.id}
                  onPointerDown={(e) => startDrag(r, e)}
                  onOpen={() => {
                    if (dragged.current) dragged.current = false;
                    else onOpen(r);
                  }}
                  onArrow={(dir) => {
                    const next = columns[ci + dir];
                    if (next) move(r, next.id);
                  }}
                />
              ))}
              {cards.length === 0 && (
                <div className="flex h-16 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                  Drop here
                </div>
              )}
            </div>
          </section>
        );
      })}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 rotate-2"
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width } as CSSProperties}
        >
          <Card record={drag.record} settings={settings} className="shadow-lg" />
        </div>
      )}
    </div>
  );
}

function Card({
  record,
  settings,
  lifted,
  className,
  onPointerDown,
  onOpen,
  onArrow,
}: {
  record: CrmRecord;
  settings: CrmSettings;
  lifted?: boolean;
  className?: string;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onOpen?: () => void;
  onArrow?: (dir: -1 | 1) => void;
}) {
  const company = record.kind === "deal" ? recordById(record.companyId) : undefined;
  const date = record.closeDate;
  const days = date ? daysUntil(date) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${record.name}. Left and right arrows move it between stages.`}
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onArrow?.(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}
      className={cn(
        "flex cursor-grab flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs transition-[opacity,box-shadow] hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring",
        lifted && "opacity-40",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RecordMark record={record} />
        <span className="truncate font-medium">{record.name}</span>
      </div>
      {company && <span className="truncate text-xs text-muted-foreground">{company.name}</span>}
      {(record.value != null || date) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {record.value != null && <span className="font-medium text-foreground tabular-nums">{formatMoney(record.value, settings.currency)}</span>}
          <span className="flex-1" />
          {date && (
            <span
              className={cn("flex items-center gap-1 tabular-nums", days != null && days < 0 && record.stage && !isClosed(settings, record) && "text-coral")}
              title={days != null && days < 0 ? "Past its close date" : undefined}
            >
              <CalendarIcon className="size-3" />
              {formatDate(date)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const isClosed = (settings: CrmSettings, r: CrmRecord) => stagesFor(settings, r.kind).find((s) => s.id === r.stage)?.tone !== "open";
