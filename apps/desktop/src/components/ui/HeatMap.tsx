"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";

/* ------------------------------------------------------------------ *
 * Colour ramps
 *
 * Every ramp is a list of control stops that gets interpolated between,
 * not a two-colour hue rotation. Blending blue to red through HSL swings
 * the path through cyan and green, which invents structure the data does
 * not have. The four scientific ramps below (magma, inferno, plasma,
 * viridis) are the matplotlib colormaps, sampled at ten points each:
 * they are perceptually uniform, so an equal step in value is an equal
 * step in apparent brightness, and they survive greyscale printing.
 *
 * The four single-hue ramps stop short of white at the top for the same
 * reason `floor` exists at the bottom: a peak cell the colour of a light
 * card reads as a hole punched in the map, not as the maximum.
 * ------------------------------------------------------------------ */

export type HeatMapVariant =
  | "magma"
  | "inferno"
  | "plasma"
  | "viridis"
  | "ice"
  | "matrix"
  | "amber"
  | "emerald";

const RAMP_HEX: Record<HeatMapVariant, string[]> = {
  magma: ["#000004", "#180f3d", "#440f76", "#721f81", "#9e2f7f", "#cd4071", "#f1605d", "#fd9668", "#feca8d", "#fcfdbf"],
  inferno: ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"],
  plasma: ["#0d0887", "#41049d", "#6a00a8", "#8f0da4", "#b12a90", "#cc4778", "#e16462", "#f2844b", "#fca636", "#fcce25", "#f0f921"],
  viridis: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
  ice: ["#04121f", "#082a45", "#0d4a70", "#12729b", "#1f9dbf", "#4dc6da", "#7ddcea", "#a8ecf5"],
  matrix: ["#03150c", "#04301a", "#046b32", "#08a049", "#12cc63", "#3ff08b", "#8dffc0"],
  amber: ["#451a03", "#78350f", "#92400e", "#b45309", "#d97706", "#f59e0b", "#fbbf24", "#fcd34d"],
  emerald: ["#022c22", "#064e3b", "#065f46", "#047857", "#059669", "#10b981", "#34d399", "#6ee7b7"],
};

export const heatMapVariants = Object.keys(RAMP_HEX) as HeatMapVariant[];

type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RAMPS = Object.fromEntries(
  Object.entries(RAMP_HEX).map(([name, hexes]) => [name, hexes.map(hexToRgb)]),
) as Record<HeatMapVariant, Rgb[]>;

/**
 * Sample a ramp at t in [0, 1].
 *
 * Interpolation is a plain lerp on the 0-255 channels, rounded to
 * integers. No Math.pow gamma round-trip: transcendentals are not
 * bit-identical across JS engines, so a server render and a client
 * hydration can disagree in the last place and React tears down the
 * subtree. Ten stops are close enough together that a linear blend
 * between neighbours is visually indistinguishable from the real thing.
 */
function sampleRamp(stops: Rgb[], t: number): string {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pos = clamped * (stops.length - 1);
  let i = Math.floor(pos);
  if (i > stops.length - 2) i = stops.length - 2;
  const f = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

/**
 * The same ramp as a CSS gradient, sampled through the same floor, so the
 * legend cannot drift from the cells it is explaining.
 */
function rampGradient(paint: (t: number) => string, floor: number, angle = "90deg"): string {
  const steps = 12;
  const list = Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return `${paint(floor + t * (1 - floor))} ${Math.round(t * 100)}%`;
  });
  return `linear-gradient(${angle}, ${list.join(", ")})`;
}

/**
 * Cheap perceived brightness (ITU-R BT.601 weights on the gamma-encoded
 * channels). Used only to decide whether a printed value sits on a dark
 * or a light cell, where being a few percent off does not matter, and it
 * keeps the whole file free of Math.pow.
 */
function isLightFill(stops: Rgb[], t: number): boolean {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pos = clamped * (stops.length - 1);
  let i = Math.floor(pos);
  if (i > stops.length - 2) i = stops.length - 2;
  const f = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = a[0] + (b[0] - a[0]) * f;
  const g = a[1] + (b[1] - a[1]) * f;
  const bl = a[2] + (b[2] - a[2]) * f;
  return (r * 299 + g * 587 + bl * 114) / 1000 > 150;
}

/* ------------------------------------------------------------------ *
 * Scales
 * ------------------------------------------------------------------ */

export type HeatMapScale = "linear" | "quantile";

interface Scale {
  /** value -> position on the ramp, 0 to 1 */
  at: (value: number) => number;
  /** ramp position -> the value that lands there, for legend ticks */
  tick: (t: number) => number;
}

function buildScale(values: number[], scale: HeatMapScale, domain?: [number, number]): Scale {
  if (values.length === 0) return { at: () => 0, tick: () => 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  if (scale === "quantile" && !domain) {
    // Rank, not magnitude. One runaway outlier in a linear scale pushes
    // every other cell into the first stop and the map goes flat; ranking
    // spends the whole ramp on the cells you actually have. The cost is
    // that equal colour steps no longer mean equal value steps, which is
    // why the legend switches to percentile ticks when this is on.
    const below = (v: number) => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const atOrBelow = (v: number) => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return {
      // Mid-rank, so a block of tied values sits at one colour instead of
      // smearing across a band of the ramp.
      at: (v) => (n <= 1 ? 0.5 : ((below(v) + atOrBelow(v)) / 2 - 0.5) / (n - 1)),
      tick: (t) => sorted[Math.round(t * (n - 1))],
    };
  }

  const min = domain ? domain[0] : sorted[0];
  const max = domain ? domain[1] : sorted[n - 1];
  const span = max - min || 1;
  return {
    at: (v) => (v - min) / span,
    tick: (t) => min + t * span,
  };
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export type HeatMapShape = "hex" | "square" | "dot";

const SQRT3 = Math.sqrt(3);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pointy-top hexagon of circumradius r, centred on 0,0. */
function hexPoints(r: number): string {
  const half = round2(r / 2);
  const w = round2((SQRT3 * r) / 2);
  const rr = round2(r);
  return `0,${-rr} ${w},${-half} ${w},${half} 0,${rr} ${-w},${half} ${-w},${-half}`;
}

interface Layout {
  width: number;
  height: number;
  centre: (row: number, col: number) => { cx: number; cy: number };
  /** Circumradius (hex) or half-edge (square/dot) of one cell, gap already removed. */
  unit: number;
}

function buildLayout(shape: HeatMapShape, rows: number, cols: number, size: number, gap: number): Layout {
  if (shape === "hex") {
    // Pointy-top hexes in offset rows: horizontal pitch is the full width,
    // vertical pitch is only three quarters of the height because the rows
    // interlock. That is what makes a honeycomb denser than a square grid
    // at the same cell width.
    const r = size / SQRT3;
    const rowStep = r * 1.5;
    return {
      width: round2(size * cols + size / 2),
      height: round2(rowStep * (rows - 1) + r * 2),
      unit: r - gap / 2,
      centre: (row, col) => ({
        cx: round2(size / 2 + col * size + (row % 2 === 1 ? size / 2 : 0)),
        cy: round2(r + row * rowStep),
      }),
    };
  }
  return {
    width: round2(size * cols),
    height: round2(size * rows),
    unit: (size - gap) / 2,
    centre: (row, col) => ({
      cx: round2(size / 2 + col * size),
      cy: round2(size / 2 + row * size),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export type HeatMapValue = number | null;

export interface HeatMapCell {
  row: number;
  col: number;
  value: number;
}

export interface HeatMapProps {
  /** Row-major matrix. `null` is a hole in the data, not a zero. */
  data: HeatMapValue[][];
  /** Accessible name for the grid. Required: the colours carry the data. */
  label: string;
  variant?: HeatMapVariant;
  /**
   * Your own colormap: hex stops from coldest to hottest. Wins over
   * `variant`. Two stops make a plain two-colour ramp; the built-in ones
   * carry eight to eleven so a hue can turn along the way.
   */
  ramp?: string[];
  /**
   * Any CSS colour, `var(--brand)` included. Wins over `ramp` and `variant`:
   * cells are mixed from `base` up to this colour by the browser
   * (`color-mix`), so a theme or accent change repaints the map with no
   * re-render. Values printed on cells then follow the mix, not luminance.
   */
  color?: string;
  /** Where a `color` ramp starts. Defaults to the shadcn `--muted` token. */
  base?: string;
  shape?: HeatMapShape;
  scale?: HeatMapScale;
  /** Pin the colour domain so two maps can be compared against each other. */
  domain?: [number, number];
  /** Cell pitch in viewBox units. The SVG scales to its container. */
  size?: number;
  gap?: number;
  /**
   * Lift the bottom of the ramp off the surface. magma and inferno both
   * bottom out at #000004, which on a dark card is indistinguishable from
   * the card, so the coldest cells read as holes rather than as data. This
   * samples the ramp over [floor, 1] instead of [0, 1]; the legend uses the
   * same window, so nothing is misreported. Set to 0 for the raw colormap.
   */
  floor?: number;
  /** Soft bloom behind the hottest cells. */
  glow?: boolean;
  glowFrom?: number;
  legend?: boolean;
  showValues?: boolean;
  xLabels?: string[];
  yLabels?: string[];
  unit?: string;
  formatValue?: (value: number) => string;
  /** What a `null` cell reads as, in the tooltip and to screen readers. */
  emptyLabel?: string;
  onCellSelect?: (cell: HeatMapCell) => void;
  className?: string;
}

export function HeatMap({
  data,
  label,
  variant = "magma",
  ramp,
  color,
  base = "var(--muted)",
  shape = "hex",
  scale = "linear",
  domain,
  size = 24,
  gap = 3,
  floor = 0.1,
  glow = false,
  glowFrom = 0.72,
  legend = true,
  showValues = false,
  xLabels,
  yLabels,
  unit = "",
  formatValue,
  emptyLabel = "no data",
  onCellSelect,
  className = "",
}: HeatMapProps) {
  const uid = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, SVGGElement>());
  const inView = useInView(wrapRef, { once: true, margin: "-10% 0px" });
  const reduceMotion = useReducedMotion();

  const [active, setActive] = useState<{ row: number; col: number; value: number | null } | null>(null);
  const [roving, setRoving] = useState({ row: 0, col: 0 });

  const rows = data.length;
  const cols = useMemo(() => data.reduce((m, r) => Math.max(m, r.length), 0), [data]);

  const stops = useMemo(() => (ramp && ramp.length > 1 ? ramp.map(hexToRgb) : RAMPS[variant]), [ramp, variant]);
  // t is a position on the ramp, floor already applied.
  const paint = useCallback(
    (t: number) =>
      color
        ? `color-mix(in oklab, ${color} ${Math.round((t < 0 ? 0 : t > 1 ? 1 : t) * 100)}%, ${base})`
        : sampleRamp(stops, t),
    [color, base, stops],
  );
  const format = useCallback(
    (v: number) => (formatValue ? formatValue(v) : `${Math.round(v * 10) / 10}${unit}`),
    [formatValue, unit],
  );

  const values = useMemo(
    () => data.flat().filter((v): v is number => v !== null && Number.isFinite(v)),
    [data],
  );
  const scaleFn = useMemo(() => buildScale(values, scale, domain), [values, scale, domain]);
  const layout = useMemo(() => buildLayout(shape, rows, cols, size, gap), [shape, rows, cols, size, gap]);

  // Pad the viewBox so a focus ring on an edge cell is not clipped by the
  // SVG viewport.
  const pad = 4;
  const viewBox = `${-pad} ${-pad} ${layout.width + pad * 2} ${layout.height + pad * 2}`;

  interface PlacedCell {
    row: number;
    col: number;
    value: number | null;
    t: number;
    cx: number;
    cy: number;
  }

  const grid = useMemo(() => {
    const out: PlacedCell[][] = [];
    for (let row = 0; row < rows; row++) {
      const line: PlacedCell[] = [];
      for (let col = 0; col < cols; col++) {
        const value = data[row]?.[col] ?? null;
        const { cx, cy } = layout.centre(row, col);
        line.push({ row, col, value, t: value === null ? 0 : scaleFn.at(value), cx, cy });
      }
      out.push(line);
    }
    return out;
  }, [data, rows, cols, layout, scaleFn]);

  const describe = useCallback(
    (row: number, col: number, value: number | null) => {
      const y = yLabels?.[row] ?? `row ${row + 1}`;
      const x = xLabels?.[col] ?? `column ${col + 1}`;
      return `${y}, ${x}: ${value === null ? emptyLabel : format(value)}`;
    },
    [xLabels, yLabels, format, emptyLabel],
  );

  const focusCell = useCallback((row: number, col: number) => {
    setRoving({ row, col });
    cellRefs.current.get(`${row}-${col}`)?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const { row, col } = roving;
      let next: { row: number; col: number } | null = null;
      if (e.key === "ArrowRight") next = { row, col: Math.min(cols - 1, col + 1) };
      else if (e.key === "ArrowLeft") next = { row, col: Math.max(0, col - 1) };
      else if (e.key === "ArrowDown") next = { row: Math.min(rows - 1, row + 1), col };
      else if (e.key === "ArrowUp") next = { row: Math.max(0, row - 1), col };
      else if (e.key === "Home") next = { row, col: 0 };
      else if (e.key === "End") next = { row, col: cols - 1 };
      else if (e.key === "Enter" || e.key === " ") {
        const value = data[row]?.[col];
        if (typeof value === "number") {
          e.preventDefault();
          onCellSelect?.({ row, col, value });
        }
        return;
      }
      if (!next) return;
      e.preventDefault();
      focusCell(next.row, next.col);
    },
    [roving, rows, cols, data, focusCell, onCellSelect],
  );

  const hot = glow ? grid.flat().filter((c) => c.value !== null && c.t >= glowFrom) : [];

  const shade = useCallback((t: number) => floor + (t < 0 ? 0 : t > 1 ? 1 : t) * (1 - floor), [floor]);

  const shapeFor = (t: number, isEmpty: boolean, key: string) => {
    // Fill goes through style, not the attribute: SVG presentation
    // attributes do not resolve var(), which a `color` ramp relies on.
    const emptyProps = isEmpty
      ? { fill: "none", stroke: "currentColor", strokeWidth: 1, strokeOpacity: 0.14 }
      : { style: { fill: paint(shade(t)) } };
    if (shape === "hex") {
      return <polygon key={key} points={hexPoints(layout.unit)} {...emptyProps} />;
    }
    if (shape === "dot") {
      // Radius carries the value as well as the hue, so the reading does
      // not depend on colour vision alone.
      const r = isEmpty ? layout.unit * 0.35 : layout.unit * (0.34 + 0.66 * (t < 0 ? 0 : t > 1 ? 1 : t));
      return <circle key={key} r={round2(r)} {...emptyProps} />;
    }
    const s = layout.unit * 2;
    const rx = Math.max(2, Math.round((s * 0.24) / 2) * 2);
    return (
      <rect key={key} x={round2(-layout.unit)} y={round2(-layout.unit)} width={round2(s)} height={round2(s)} rx={rx} {...emptyProps} />
    );
  };

  const revealDelay = (row: number, col: number) => Math.min((row + col) * 0.014, 0.55);

  return (
    <div className={`w-full ${className}`}>
      <div ref={wrapRef} className="relative">
        {/* Reveal is driven by useInView on this HTML wrapper. whileInView on
            an SVG node is unreliable: the intersection observer measures a
            bounding box the browser reports inconsistently for <g>. */}
        <svg
          viewBox={viewBox}
          role="grid"
          aria-label={label}
          aria-rowcount={rows}
          aria-colcount={cols}
          className="w-full overflow-visible"
          onKeyDown={onKeyDown}
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <filter id={`hm-glow-${uid}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation={size * 0.42} />
            </filter>
          </defs>

          {glow && hot.length > 0 && (
            <motion.g
              aria-hidden="true"
              filter={`url(#hm-glow-${uid})`}
              initial={{ opacity: reduceMotion ? 0.55 : 0 }}
              animate={inView ? { opacity: 0.55 } : undefined}
              transition={{ duration: 0.9, delay: 0.25 }}
            >
              {hot.map((c) => (
                <g key={`glow-${c.row}-${c.col}`} transform={`translate(${c.cx} ${c.cy})`}>
                  {shapeFor(c.t, false, `g-${c.row}-${c.col}`)}
                </g>
              ))}
            </motion.g>
          )}

          {grid.map((line, row) => (
            <g key={`row-${row}`} role="row" aria-rowindex={row + 1}>
              {line.map((c) => {
                  const isEmpty = c.value === null;
                  const isRoving = roving.row === c.row && roving.col === c.col;
                  return (
                    <g
                      key={`${c.row}-${c.col}`}
                      ref={(node) => {
                        if (node) cellRefs.current.set(`${c.row}-${c.col}`, node);
                        else cellRefs.current.delete(`${c.row}-${c.col}`);
                      }}
                      role="gridcell"
                      aria-colindex={c.col + 1}
                      aria-label={describe(c.row, c.col, c.value)}
                      tabIndex={isRoving ? 0 : -1}
                      transform={`translate(${c.cx} ${c.cy})`}
                      // Tailwind's outline-none is a transparent 2px outline, not
                      // `outline: none`, and Chrome still paints a box around the
                      // <g>. The drawn ring replaces it.
                      style={{ outline: "none" }}
                      onFocus={() => {
                        setRoving({ row: c.row, col: c.col });
                        setActive({ row: c.row, col: c.col, value: c.value });
                      }}
                      onBlur={() => setActive(null)}
                      onMouseEnter={() => setActive({ row: c.row, col: c.col, value: c.value })}
                      onClick={() => !isEmpty && onCellSelect?.({ row: c.row, col: c.col, value: c.value as number })}
                    >
                      <motion.g
                        style={{ transformBox: "fill-box", transformOrigin: "center" }}
                        initial={{ opacity: reduceMotion ? 1 : 0, scale: reduceMotion ? 1 : 0.35 }}
                        animate={inView ? { opacity: 1, scale: 1 } : undefined}
                        transition={{ duration: 0.45, delay: revealDelay(c.row, c.col), ease: [0.22, 1, 0.36, 1] }}
                      >
                        {shapeFor(c.t, isEmpty, `s-${c.row}-${c.col}`)}
                        {showValues && !isEmpty && (
                          <text
                            textAnchor="middle"
                            dominantBaseline="central"
                            fontSize={round2(size * 0.34)}
                            fill={(color ? shade(c.t) < 0.5 : isLightFill(stops, shade(c.t))) ? "#0b0b0f" : "#ffffff"}
                            fillOpacity={0.85}
                            pointerEvents="none"
                          >
                            {format(c.value as number)}
                          </text>
                        )}
                      </motion.g>
                    </g>
                  );
                })}
            </g>
          ))}

          {/* One ring for the whole grid, drawn after every cell so it is
              never painted over by a neighbour, and two-tone (black under
              white) so it stays visible at both ends of every ramp. Keeping
              it out of the cells also saves two hidden nodes per cell. */}
          {active &&
            (() => {
              const { cx, cy } = layout.centre(active.row, active.col);
              const ring = (stroke: string, width: number) =>
                shape === "dot" ? (
                  <circle r={round2(layout.unit + 2)} fill="none" stroke={stroke} strokeWidth={width} />
                ) : shape === "hex" ? (
                  <polygon points={hexPoints(layout.unit + 2)} fill="none" stroke={stroke} strokeWidth={width} />
                ) : (
                  <rect
                    x={round2(-layout.unit - 2)}
                    y={round2(-layout.unit - 2)}
                    width={round2(layout.unit * 2 + 4)}
                    height={round2(layout.unit * 2 + 4)}
                    rx={4}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={width}
                  />
                );
              return (
                <g aria-hidden="true" className="pointer-events-none" transform={`translate(${cx} ${cy})`}>
                  {ring("#000", 3.5)}
                  {ring("#fff", 1.5)}
                </g>
              );
            })()}
        </svg>

        {active &&
          (() => {
            // A tip anchored above row 0 would hang outside the card, so the
            // top row flips it under the cell instead.
            const below = active.row === 0;
            const { cx, cy } = layout.centre(active.row, active.col);
            return (
              <div
                className={`pointer-events-none absolute z-10 -translate-x-1/2 ${below ? "" : "-translate-y-full"}`}
                style={{
                  left: `${((cx + pad) / (layout.width + pad * 2)) * 100}%`,
                  top: `${((cy + pad) / (layout.height + pad * 2)) * 100}%`,
                }}
              >
                <div
                  className={`${below ? "mt-4" : "mb-4"} whitespace-nowrap rounded-lg bg-stone-900 px-2 py-1 text-[11px] font-medium text-white shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:bg-white dark:text-stone-900`}
                >
                  <span className="opacity-60">
                    {yLabels?.[active.row] ?? `Row ${active.row + 1}`}, {xLabels?.[active.col] ?? `Col ${active.col + 1}`}
                  </span>{" "}
                  {active.value === null ? <span className="opacity-60">{emptyLabel}</span> : format(active.value)}
                </div>
              </div>
            );
          })()}
      </div>

      {/* One live region for the whole grid, so arrowing across cells does
          not queue up one announcement per cell. */}
      <span className="sr-only" aria-live="polite">
        {active ? describe(active.row, active.col, active.value) : ""}
      </span>

      {legend && (
        <div className="mt-4">
          <div
            aria-hidden="true"
            className="h-2 w-full rounded-full"
            style={{ backgroundImage: rampGradient(paint, floor) }}
          />
          {/* Under a quantile scale the ramp is spaced by rank, so the ticks
              are labelled as percentiles: equal colour steps are equal counts
              of cells, not equal amounts of value. */}
          <div className="mt-2 flex items-center justify-between text-[11px] tabular-nums text-stone-500 dark:text-stone-400">
            {(scale === "quantile"
              ? ([
                  ["min", 0],
                  ["p50", 0.5],
                  ["max", 1],
                ] as const)
              : ([
                  ["min", 0],
                  ["max", 1],
                ] as const)
            ).map(([name, t]) => (
              <span key={name} className={t === 1 ? "text-right" : t === 0 ? "" : "text-center"}>
                <span className="opacity-50">{name} </span>
                {format(scaleFn.tick(t))}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
