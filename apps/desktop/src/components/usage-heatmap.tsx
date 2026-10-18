// Usage card for Cowork's start screen, after Claude's usage stats. Overview:
// summary tiles over a GitHub-style activity heatmap, one cell per day over the
// past year shaded by how many replies Sush gave that day. Models: tokens per
// day stacked by model, over a legend with each model's tokens, cost and share.
// A range filter (all / 30 / 7 days) applies to both; the heatmap's cells are
// hexagons, circles or squares, picked in the header and remembered.

import { useId, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Circle, Hexagon, Square, type LucideIcon } from "lucide-react";

import { HeatMap, type HeatMapShape, type HeatMapValue } from "@/components/ui/HeatMap";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUsd } from "@/lib/pricing";
import { createStore, useConversations } from "@/lib/store";
import {
  activity,
  dayKey,
  emptyTally,
  formatSpend,
  formatTokens,
  formatTokensExact,
  MODEL_COLORS,
  OTHER_MODEL_COLOR,
  summarizeUsage,
  totalTokens,
  type DayUsage,
  type Tally,
  type UsageRange,
  type UsageSummary,
} from "@/lib/usage";
import { cn } from "@/lib/utils";

const WEEKS = 53;
// HeatMap's cell pitch and the viewBox padding around the grid, used to line
// the month labels up with their columns. In the hex layout odd rows shift
// right by half a cell, which makes the grid half a cell wider.
const CELL = 24;
const PAD = 4;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

const SHAPES: { shape: HeatMapShape; label: string; icon: LucideIcon }[] = [
  { shape: "hex", label: "Hexagons", icon: Hexagon },
  { shape: "dot", label: "Circles", icon: Circle },
  { shape: "square", label: "Squares", icon: Square },
];

type View = "overview" | "models";

const VIEWS: { value: View; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "models", label: "Models" },
];

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "all", label: "All" },
  { value: "30d", label: "30d" },
  { value: "7d", label: "7d" },
];

const cellShape = createStore<HeatMapShape>("sush.heatmap-shape", "hex");
if (!SHAPES.some((s) => s.shape === cellShape.get())) cellShape.set("hex");
const useCellShape = () => useSyncExternalStore(cellShape.subscribe, cellShape.get);

const viewStore = createStore<View>("sush.usage-view", "overview");
if (!VIEWS.some((v) => v.value === viewStore.get())) viewStore.set("overview");
const useView = () => useSyncExternalStore(viewStore.subscribe, viewStore.get);

const rangeStore = createStore<UsageRange>("sush.usage-range", "all");
if (!RANGES.some((r) => r.value === rangeStore.get())) rangeStore.set("all");
const useRange = () => useSyncExternalStore(rangeStore.subscribe, rangeStore.get);

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const longMonthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const replies = (n: number) => plural(n, "reply", "replies");

/** Midnight at the start of today, local time. */
function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/** Midnight starting the range: today and the 6 or 29 days before it, or the beginning of time. */
function rangeSince(range: UsageRange, today: Date) {
  if (range === "all") return 0;
  const days = range === "7d" ? 7 : 30;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();
}

export function UsageHeatmap({ localProviders, className }: { localProviders: Set<string>; className?: string }) {
  const conversations = useConversations();
  const shape = useCellShape();
  const view = useView();
  const range = useRange();
  const panelId = useId();

  const today = startOfToday();
  const since = rangeSince(range, today);
  const todayMs = today.getTime();

  // All time for the heatmap and the streak; the range for everything else.
  const allTime = useMemo(() => activity(conversations, localProviders, 0), [conversations, localProviders]);
  const ranged = useMemo(
    () => (since === 0 ? allTime : activity(conversations, localProviders, since)),
    [allTime, conversations, localProviders, since],
  );
  const usage = useMemo(
    () => summarizeUsage(conversations, localProviders, since),
    [conversations, localProviders, since],
  );

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between gap-4">
        <Toggle label="Usage view" tabs={panelId} value={view} options={VIEWS} onChange={viewStore.set} />
        <div className="flex items-center gap-3">
          <Toggle label="Time range" value={range} options={RANGES} onChange={rangeStore.set} />
          {view === "overview" && <ShapePicker value={shape} onChange={cellShape.set} />}
        </div>
      </div>

      <div id={`${panelId}-${view}`} role="tabpanel" aria-labelledby={`${panelId}-tab-${view}`}>
        {view === "overview" ? (
          <Overview
            usage={usage}
            ranged={ranged.days}
            allTime={allTime.days}
            messages={ranged.messages}
            hours={ranged.hours}
            since={since}
            todayMs={todayMs}
            shape={shape}
          />
        ) : (
          <Models usage={usage} days={ranged.days} range={range} since={since} todayMs={todayMs} />
        )}
      </div>
    </div>
  );
}

// --- overview -----------------------------------------------------------------------

function Overview({
  usage,
  ranged,
  allTime,
  messages,
  hours,
  since,
  todayMs,
  shape,
}: {
  usage: UsageSummary;
  ranged: Map<string, DayUsage>;
  allTime: Map<string, DayUsage>;
  messages: number;
  hours: number[];
  since: number;
  todayMs: number;
  shape: HeatMapShape;
}) {
  const { data, weekLabels, months, total, max } = useMemo(() => {
    const today = new Date(todayMs);
    // Columns are weeks starting on Sunday; the last one holds today.
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);

    // Rows are weekdays, columns weeks. Days with no replies, days before the
    // range and days still to come are null, so they draw as empty outlines
    // rather than the coldest colour.
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
        const shown = date <= today && date.getTime() >= since;
        const count = shown ? (allTime.get(dayKey(date.getTime()))?.replies ?? 0) : 0;
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
    return { data, weekLabels, months, total, max };
  }, [allTime, since, todayMs]);

  // Days in a row with replies, ending today (or yesterday, if today has none yet).
  const streak = useMemo(() => {
    let streak = 0;
    const day = new Date(todayMs);
    if (!allTime.get(dayKey(day.getTime()))) day.setDate(day.getDate() - 1);
    while (allTime.get(dayKey(day.getTime()))) {
      streak++;
      day.setDate(day.getDate() - 1);
    }
    return streak;
  }, [allTime, todayMs]);

  const tokens = totalTokens(usage.total);
  const peak = hours.reduce((best, n, h) => (n > hours[best] ? h : best), 0);
  const favorite = usage.models[0]?.model;
  const partial = usage.total.unpricedTokens > 0 && usage.total.usd > 0;
  const span = WEEKS * CELL + (shape === "hex" ? CELL / 2 : 0) + PAD * 2;
  const label = `${replies(total)} ${since === 0 ? "in the past year" : `in the last ${Math.round((todayMs - since) / DAY_MS) + 1} days`}`;
  const comparison = compare(tokens);

  return (
    <>
      <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Sessions" value={formatTokensExact(usage.chat.sessions + usage.cowork.sessions)} />
        <Tile label="Messages" value={formatTokensExact(messages)} />
        <Tile label="Total tokens" value={formatTokens(tokens)} title={`${formatTokensExact(tokens)} tokens`} />
        <Tile
          label="Est. cost"
          value={`${formatSpend(usage.total)}${partial ? "+" : ""}`}
          title={partial ? "Leaves out models without a known price" : undefined}
        />
        <Tile label="Active days" value={formatTokensExact(ranged.size)} />
        <Tile label="Peak hour" value={hours[peak] > 0 ? hourFmt.format(new Date(2000, 0, 1, peak)) : "—"} />
        <Tile label="Streak" value={plural(streak, "day")} />
        <Tile label="Favorite model" value={favorite ?? "—"} title={favorite} mono={!!favorite} />
      </dl>

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
        label={`Activity heatmap: ${label}`}
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

      {comparison && <p className="mt-2.5 text-xs text-muted-foreground tabular-nums">{comparison}</p>}
    </>
  );
}

function Tile({ label, value, title, mono }: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        title={title}
        className={cn("truncate text-sm font-medium tabular-nums", mono && "font-mono text-[13px] tracking-tight")}
      >
        {value}
      </dd>
    </div>
  );
}

// Rough token counts (about 1.3 tokens per English word) of things everyone
// has a feel for the length of, smallest first.
const WORKS: [string, number][] = [
  ["the Gettysburg Address", 360],
  ["The Great Gatsby", 62_000],
  ["Moby-Dick", 275_000],
  ["The Lord of the Rings", 750_000],
  ["the complete works of Shakespeare", 1_200_000],
  ["all of English Wikipedia", 6_500_000_000],
];

/** "You've used ~40× the tokens in Moby-Dick.", against the longest work it beats. */
function compare(tokens: number) {
  const work = WORKS.findLast(([, n]) => n <= tokens);
  if (!work) return null;
  const times = tokens / work[1];
  if (times < 1.5) return `You've used about as many tokens as ${work[0]}.`;
  return `You've used ~${formatTokensExact(Math.round(times))}× the tokens in ${work[0]}.`;
}

// --- models -------------------------------------------------------------------------

interface Series {
  label: string;
  color: string;
  /** Models in the series: one, or the rest for "Other". */
  models: Set<string>;
  tally: Tally;
  local: boolean;
}

interface Bucket {
  key: number;
  label: string;
  title: string;
  tokens: number[];
  total: number;
  usd: number;
}

/** At most this many bars; longer ranges go by week, then by month. */
const MAX_BARS = 62;

function Models({
  usage,
  days,
  range,
  since,
  todayMs,
}: {
  usage: UsageSummary;
  days: Map<string, DayUsage>;
  range: UsageRange;
  since: number;
  todayMs: number;
}) {
  const series = useMemo<Series[]>(() => {
    const top = usage.models.slice(0, MODEL_COLORS.length);
    const rest = usage.models.slice(MODEL_COLORS.length);
    const out: Series[] = top.map((m, i) => ({
      label: m.model,
      color: MODEL_COLORS[i],
      models: new Set([m.model]),
      tally: m,
      local: m.local,
    }));
    if (rest.length > 0) {
      const tally = emptyTally();
      for (const m of rest) {
        tally.inputTokens += m.inputTokens;
        tally.outputTokens += m.outputTokens;
        tally.replies += m.replies;
        tally.usd += m.usd;
        tally.unpricedTokens += m.unpricedTokens;
      }
      out.push({
        label: "Other",
        color: OTHER_MODEL_COLOR,
        models: new Set(rest.map((m) => m.model)),
        tally,
        local: rest.every((m) => m.local),
      });
    }
    return out;
  }, [usage]);

  const buckets = useMemo(() => {
    const today = new Date(todayMs);
    // "All" starts at the first day with a reply.
    let first = since;
    if (first === 0) {
      first = todayMs;
      for (const key of days.keys()) {
        const [y, m, d] = key.split("-").map(Number);
        first = Math.min(first, new Date(y, m - 1, d).getTime());
      }
    }
    const start = new Date(first);
    const span = Math.round((todayMs - first) / DAY_MS) + 1;
    const unit = span <= MAX_BARS ? "day" : span <= MAX_BARS * 7 ? "week" : "month";
    const bucketOf = (d: Date) =>
      unit === "day"
        ? d
        : unit === "week"
          ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())
          : new Date(d.getFullYear(), d.getMonth(), 1);

    const out: Bucket[] = [];
    for (let d = start; d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const b = bucketOf(d);
      let bucket = out[out.length - 1];
      if (bucket?.key !== b.getTime()) {
        bucket = {
          key: b.getTime(),
          label: unit === "month" ? monthYearFmt.format(b) : weekFmt.format(b),
          title:
            unit === "day" ? weekFmt.format(b) : unit === "week" ? `Week of ${weekFmt.format(b)}` : longMonthFmt.format(b),
          tokens: series.map(() => 0),
          total: 0,
          usd: 0,
        };
        out.push(bucket);
      }
      const day = days.get(dayKey(d.getTime()));
      if (!day) continue;
      bucket.usd += day.usd;
      for (const [model, n] of day.tokens) {
        const i = series.findIndex((s) => s.models.has(model));
        if (i < 0) continue;
        bucket.tokens[i] += n;
        bucket.total += n;
      }
    }
    return out;
  }, [days, series, since, todayMs]);

  const all = totalTokens(usage.total);
  if (all === 0) {
    return (
      <p className="rounded-lg bg-muted/50 px-4 py-10 text-center text-sm text-muted-foreground">
        No model usage {range === "all" ? "yet" : `in the last ${range === "7d" ? "7" : "30"} days`}.
      </p>
    );
  }

  return (
    <>
      <BarChart buckets={buckets} series={series} />
      <ul className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1.5 text-sm">
        {series.map((s) => (
          <li key={s.label} className="contents">
            <span className={cn("size-2.5 rounded-sm", s.color)} aria-hidden />
            <span className={cn("truncate", s.label !== "Other" && "font-mono text-[13px] tracking-tight")} title={s.label}>
              {s.label}
            </span>
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title={`${formatTokensExact(s.tally.inputTokens)} input · ${formatTokensExact(s.tally.outputTokens)} output tokens`}
            >
              {formatTokens(s.tally.inputTokens)} in · {formatTokens(s.tally.outputTokens)} out
            </span>
            <span className="w-16 text-right tabular-nums">{formatSpend(s.tally, s.local)}</span>
            <span className="w-12 text-right font-medium tabular-nums">{share(totalTokens(s.tally), all)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** "86.6%", or "<0.1%" for a sliver. */
function share(part: number, whole: number) {
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

/** Steps of 1, 2, 2.5 or 5 × 10ⁿ, about three to the top bar. */
function niceStep(max: number) {
  const raw = max / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Tokens per bucket, stacked by model with the biggest at the bottom. */
function BarChart({ buckets, series }: { buckets: Bucket[]; series: Series[] }) {
  const max = Math.max(...buckets.map((b) => b.total));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // About five date labels, spread evenly.
  const every = Math.max(1, Math.ceil(buckets.length / 5));
  const busiest = buckets.reduce((a, b) => (b.total > a.total ? b : a));

  return (
    <div role="img" aria-label={`Tokens over time by model. Busiest: ${busiest.title}, ${formatTokens(busiest.total)} tokens.`}>
      <div className="flex gap-2">
        <div aria-hidden className="relative h-40 w-9 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(t / top) * 100}%` }}>
              {formatTokens(t)}
            </span>
          ))}
        </div>
        <div className="relative h-40 min-w-0 flex-1">
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden
              className={cn("absolute inset-x-0 border-t", t === 0 ? "border-border" : "border-dashed border-border/60")}
              style={{ bottom: `${(t / top) * 100}%` }}
            />
          ))}
          <div className={cn("absolute inset-0 flex items-end", buckets.length > 31 ? "gap-px" : "gap-1")}>
            {buckets.map((b) => (
              <Bar key={b.key} bucket={b} series={series} height={(b.total / top) * 100} />
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden className="relative mt-1.5 ml-11 h-3">
        {buckets.map((b, i) =>
          i % every === 0 ? (
            <span
              key={b.key}
              className="absolute -translate-x-1/2 text-[10px] leading-none whitespace-nowrap text-muted-foreground"
              style={{ left: `${((i + 0.5) / buckets.length) * 100}%` }}
            >
              {b.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function Bar({ bucket, series, height }: { bucket: Bucket; series: Series[]; height: number }) {
  // The whole column is the hover target, so short bars are easy to hit.
  const column = (
    <div className="flex h-full min-w-0 flex-1 items-end justify-center">
      {bucket.total > 0 && (
        <div
          className="flex w-full max-w-8 min-h-px flex-col-reverse gap-px overflow-hidden rounded-t-[3px] transition-[height] duration-300"
          style={{ height: `${height}%` }}
        >
          {series.map((s, i) =>
            bucket.tokens[i] > 0 ? (
              <div key={s.label} className={cn("min-h-px", s.color)} style={{ flexGrow: bucket.tokens[i], flexBasis: 0 }} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
  if (bucket.total === 0) return column;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{column}</TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">{bucket.title}</p>
        <dl className="mt-1 tabular-nums">
          {series.map((s, i) =>
            bucket.tokens[i] > 0 ? (
              <Line key={s.label} label={<><span className={cn("size-2 rounded-sm", s.color)} />{s.label}</>}>
                {formatTokens(bucket.tokens[i])}
              </Line>
            ) : null,
          )}
          <Line label="Total">
            {formatTokens(bucket.total)}
            {bucket.usd > 0 && ` · ${formatUsd(bucket.usd)}`}
          </Line>
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="flex items-center gap-1.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// --- controls -----------------------------------------------------------------------

/**
 * Text buttons, one selected, behaving as a radio group, or as tabs when
 * `tabs` names their panels.
 */
function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
  tabs,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Id prefix of the tab panels; makes this a tab list. */
  tabs?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = options.findIndex((o) => o.value === value);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role={tabs ? "tablist" : "radiogroup"} aria-label={label} onKeyDown={onKeyDown} className="flex items-center gap-0.5">
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={tabs ? "tab" : "radio"}
            id={tabs ? `${tabs}-tab-${o.value}` : undefined}
            aria-controls={tabs && checked ? `${tabs}-${o.value}` : undefined}
            aria-selected={tabs ? checked : undefined}
            aria-checked={tabs ? undefined : checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-6 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
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
