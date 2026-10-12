// GitHub-style activity heatmap for Cowork's start screen: one cell per day
// over the past year, shaded by how many replies Sush gave that day. The cells
// are hexagons, circles or squares, picked in the header and remembered.

import { useMemo, useRef, useSyncExternalStore } from "react";
import { Circle, Hexagon, Square, type LucideIcon } from "lucide-react";

import { HeatMap, type HeatMapShape, type HeatMapValue } from "@/components/ui/HeatMap";
import { createStore, useConversations } from "@/lib/store";
import { dailyReplies, dayKey } from "@/lib/usage";
import { cn } from "@/lib/utils";

const WEEKS = 53;
// HeatMap's cell pitch and the viewBox padding around the grid, used to line
// the month labels up with their columns. In the hex layout odd rows shift
// right by half a cell, which makes the grid half a cell wider.
const CELL = 24;
const PAD = 4;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SHAPES: { shape: HeatMapShape; label: string; icon: LucideIcon }[] = [
  { shape: "hex", label: "Hexagons", icon: Hexagon },
  { shape: "dot", label: "Circles", icon: Circle },
  { shape: "square", label: "Squares", icon: Square },
];

const cellShape = createStore<HeatMapShape>("sush.heatmap-shape", "hex");
if (!SHAPES.some((s) => s.shape === cellShape.get())) cellShape.set("hex");
const useCellShape = () => useSyncExternalStore(cellShape.subscribe, cellShape.get);

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const replies = (n: number) => plural(n, "reply", "replies");

export function UsageHeatmap({ className }: { className?: string }) {
  const conversations = useConversations();
  const shape = useCellShape();

  const { data, weekLabels, months, total, max, streak } = useMemo(() => {
    const counts = dailyReplies(conversations);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Columns are weeks starting on Sunday; the last one holds today.
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);

    // Rows are weekdays, columns weeks. Days with no replies (and days still to
    // come) are null, so they draw as empty outlines rather than the coldest colour.
    const data: HeatMapValue[][] = Array.from({ length: 7 }, () => []);
    const weekLabels: string[] = [];
    const months: { col: number; label: string }[] = [];
    let total = 0;
    let max = 0;
    for (let w = 0; w < WEEKS; w++) {
      const sunday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7);
      weekLabels.push(`week of ${weekFmt.format(sunday)}`);
      let firstOfMonth: Date | undefined;
      for (let d = 0; d < 7; d++) {
        const date = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + d);
        if (date.getDate() === 1) firstOfMonth = date;
        const count = date > today ? 0 : (counts.get(dayKey(date.getTime())) ?? 0);
        total += count;
        max = Math.max(max, count);
        data[d].push(count > 0 ? count : null);
      }
      // Label a column when a new month starts in it, unless it would crowd the last label.
      const label = w === 0 ? sunday : firstOfMonth;
      if (label && (months.length === 0 || w - months[months.length - 1].col >= 3)) {
        months.push({ col: w, label: monthFmt.format(label) });
      }
    }

    // Days in a row with replies, ending today (or yesterday, if today has none yet).
    let streak = 0;
    const day = new Date(today);
    if (!counts.get(dayKey(day.getTime()))) day.setDate(day.getDate() - 1);
    while (counts.get(dayKey(day.getTime()))) {
      streak++;
      day.setDate(day.getDate() - 1);
    }

    return { data, weekLabels, months, total, max, streak };
  }, [conversations]);

  const summary = `${replies(total)} in the past year`;
  const span = WEEKS * CELL + (shape === "hex" ? CELL / 2 : 0) + PAD * 2;

  return (
    <div className={className}>
      <div className="mb-2.5 flex items-center justify-between gap-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500">Activity</p>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>
          <ShapePicker value={shape} onChange={cellShape.set} />
        </div>
      </div>

      <div aria-hidden className="relative mb-1 h-3">
        {months.map((m) => (
          <span
            key={m.col}
            className="absolute text-[10px] leading-none whitespace-nowrap text-muted-foreground"
            style={{ left: `${((m.col * CELL + PAD) / span) * 100}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>

      <HeatMap
        // Keyed by shape so a switch replays the reveal in the new shape.
        key={shape}
        data={data}
        shape={shape}
        label={`Activity heatmap: ${summary}`}
        // The app's accent, mixed up from --muted, so the map follows the
        // accent picker and light/dark mode like the rest of the UI.
        color="var(--brand)"
        // From zero, not the quietest active day, so one day with few replies
        // is not shaded like the busiest.
        domain={[0, Math.max(1, max)]}
        // Start a quarter of the way in so a one-reply day stands off --muted.
        floor={0.25}
        size={CELL}
        gap={5}
        xLabels={weekLabels}
        yLabels={DAY_NAMES}
        formatValue={(v) => replies(Math.round(v))}
        emptyLabel="No replies"
      />

      {streak > 0 && (
        <p className="mt-2.5 text-xs text-muted-foreground tabular-nums">{`${plural(streak, "day")} in a row`}</p>
      )}
    </div>
  );
}

/** Three icon buttons, one per cell shape, behaving as a radio group. */
function ShapePicker({ value, onChange }: { value: HeatMapShape; onChange: (shape: HeatMapShape) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = SHAPES.findIndex((s) => s.shape === value);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + SHAPES.length) % SHAPES.length;
    onChange(SHAPES[next].shape);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Cell shape" onKeyDown={onKeyDown} className="flex items-center gap-0.5">
      {SHAPES.map(({ shape, label, icon: Icon }, i) => {
        const checked = shape === value;
        return (
          <button
            key={shape}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(shape)}
            className={cn(
              "grid size-6 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {/* Selected is a solid shape, unselected an outline: the state reads
                from the shape itself, not from a faint background. */}
            <Icon className="size-3.5" fill={checked ? "currentColor" : "none"} />
          </button>
        );
      })}
    </div>
  );
}
