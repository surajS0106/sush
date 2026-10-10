"use client";

import { motion } from "framer-motion";
import {
  ChartFrame,
  linePath,
  type AxisSpec,
  type ChartContext,
  type ChartPoint,
  type Curve,
  type Pt,
  type ReferenceLine,
  type SeriesSpec,
} from "@/components/ui/ChartFrame";

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface LineChartProps {
  data: ChartPoint[];
  series: SeriesSpec[];
  label: string;
  summary?: string;
  /**
   * `linear` joins readings, `spline` is monotone cubic (it cannot
   * overshoot into values the series never reached), and the two step
   * curves hold a value until the next reading instead of sloping towards
   * it. That distinction is the whole reason step lines exist: a diagonal
   * between two readings claims the series passed through every value in
   * between, which is true of a temperature and false of a price tier, a
   * headcount, or a feature flag.
   */
  curve?: Curve;
  /** Marks at each reading. `auto` draws them only when the series is short enough to stay readable. */
  dots?: boolean | "auto";
  width?: number;
  x?: AxisSpec;
  y?: AxisSpec;
  height?: number;
  legend?: boolean;
  reference?: ReferenceLine[];
  formatValue?: (v: number) => string;
  className?: string;
}

/** Splits a series at its gaps, so a null breaks the line instead of diving to zero. */
export function runsOf(ctx: ChartContext, id: string): Pt[][] {
  const out: Pt[][] = [];
  let run: Pt[] = [];
  ctx.points.forEach((p, i) => {
    const v = p.values[id];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      if (run.length) out.push(run);
      run = [];
      return;
    }
    const along = ctx.px(p, i);
    const across = ctx.value.at(v);
    run.push(ctx.horizontal ? { x: across, y: along } : { x: along, y: across });
  });
  if (run.length) out.push(run);
  return out;
}

export function LineChart({
  data,
  series,
  label,
  summary,
  curve = "linear",
  dots = "auto",
  width = 2,
  x,
  y,
  height = 260,
  legend = true,
  reference,
  formatValue,
  className,
}: LineChartProps) {
  const isBand = data.length > 0 && typeof data[0].x === "string";
  const showDots = dots === "auto" ? data.length <= 24 : dots;

  const draw = (ctx: ChartContext) => (
    <>
      {ctx.series.map((s, si) =>
        runsOf(ctx, s.id).map((run, ri) => (
          <g key={`${s.id}-${ri}`}>
            {run.length > 1 && (
              <motion.path
                d={linePath(run, curve)}
                fill="none"
                stroke={ctx.color(s.id)}
                strokeDasharray={ctx.dash(s.id)}
                strokeWidth={width}
                strokeLinecap="round"
                strokeLinejoin="round"
                // Drawn on rather than faded in, and staggered by series, so
                // the lines arrive one after another in legend order instead
                // of the whole plot resolving at once.
                initial={ctx.reduceMotion ? false : { pathLength: 0 }}
                animate={ctx.inView ? { pathLength: 1 } : undefined}
                transition={{ duration: 0.9, delay: 0.15 + si * 0.12, ease: [0.22, 1, 0.36, 1] }}
              />
            )}

            {/* A single reading with gaps either side has no line to draw,
                so it gets a dot whatever the `dots` setting is: otherwise
                the value is simply missing from the chart. */}
            {(showDots || run.length === 1) &&
              run.map((pt, pi) => (
                <motion.circle
                  key={pi}
                  cx={pt.x}
                  cy={pt.y}
                  r={run.length === 1 ? 3.5 : 3}
                  fill={ctx.color(s.id)}
                  stroke="var(--cf-dot-ring)"
                  strokeWidth={1.5}
                  initial={ctx.reduceMotion ? false : { opacity: 0, scale: 0.4 }}
                  animate={ctx.inView ? { opacity: 1, scale: 1 } : undefined}
                  transition={{
                    duration: 0.35,
                    delay: 0.5 + si * 0.12 + (pi / Math.max(1, run.length)) * 0.4,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                />
              ))}
          </g>
        )),
      )}
    </>
  );

  return (
    <ChartFrame
      label={label}
      summary={summary}
      series={series}
      points={data}
      height={height}
      legend={legend}
      reference={reference}
      formatValue={formatValue}
      className={className}
      x={isBand ? { categories: data.map((p) => String(p.x)), ...x } : x}
      // A line chart is read for its shape, so the axis is not forced
      // through zero: pinning a series that oscillates between 980 and 1020
      // to a zero baseline flattens it into a straight line.
      y={{ zero: false, pad: 0.1, ...y }}
    >
      {draw}
    </ChartFrame>
  );
}
