"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";

/* ------------------------------------------------------------------ *
 * Series colour
 *
 * The library is greyscale, so a series is told apart by lightness
 * rather than by hue. That is a narrower channel than it sounds, and
 * the narrowing is one-sided: the palette may only use greys that clear
 * 3:1 against their own surface, the WCAG 1.4.11 floor for a shape that
 * carries meaning. On white that rules out everything lighter than
 * about zinc-500, leaving roughly 50 points of L* to divide up; on the
 * near-black it rules out everything darker than zinc-500 and leaves
 * about the same. Six slots in fifty points is ten points apart, which
 * is one Tailwind step: visible side by side in a legend, thin for two
 * lines crossing at a shallow angle.
 *
 * So the six are ordered rather than ramped. Slots 0-2 take the three
 * most separated greys available (17 to 21 L* apart), slots 3-5 take
 * the three that fall between them, and the second group is drawn
 * dashed. A chart with three series or fewer, which is most of them,
 * is untouched by the dash and reads on lightness alone. A chart with
 * four or more gets a second, non-colour channel exactly at the point
 * where lightness alone starts to strain. Two slots that share a dash
 * are far apart in lightness; two slots close in lightness differ in
 * dash. Nothing rests on a distinction of less than 17 L*.
 *
 * Fills ignore `dash`, so a stacked bar past four series is the one
 * place this palette is genuinely working at its limit. Order the
 * series so the ones a reader must compare are not neighbours, or pass
 * an explicit `color` on the SeriesSpec.
 *
 * Two palettes rather than one that "works on both": a single set of
 * greys legible on white and on near-black would have to sit in the
 * muddy middle and would be legible on neither.
 * ------------------------------------------------------------------ */

/** emerald/amber alternating. L* 15, 47, 35 | 60, 44, 31. Min contrast on white 3.19:1. */
const SERIES_LIGHT = ["#022c22", "#b45309", "#065f46", "#d97706", "#047857", "#78350f"];
/** emerald/amber alternating. L* 90, 60, 76 | 86, 67, 47. Min contrast on the ink near-black 3.96:1. */
const SERIES_DARK = ["#a7f3d0", "#d97706", "#34d399", "#fcd34d", "#10b981", "#b45309"];

/** One dash per group of three, so it changes exactly when lightness tightens. */
const SERIES_DASH = [undefined, "7 4", "2 4", "11 4 2 4"];
const SERIES_DASH_GROUP = 3;

export const CHART_SERIES_SLOTS = SERIES_LIGHT.length;

/**
 * Theme is resolved in CSS, not in JavaScript. Reading the `dark` class
 * during render would make the server and the first client paint disagree
 * whenever the user is in dark mode, and React tears the subtree down over
 * exactly that kind of mismatch. Emitting both palettes as custom
 * properties and letting the cascade pick leaves nothing for the two
 * renders to disagree about, and it hands consumers a real override hook:
 * set --cf-s0 on any ancestor and the chart follows.
 *
 * The selector assumes Tailwind's class dark mode (`darkMode: "class"`).
 * On the media strategy, swap `.dark &` for a prefers-color-scheme block.
 * The `:not([data-light] *)` tail mirrors the site's own dark variant: an
 * ancestor carrying `data-light` pins everything under it to daylight, and
 * the chart palette has to agree with the Tailwind utilities around it or
 * a light card ends up holding a dark-mode chart.
 */
function paletteCss(uid: string): string {
  const light = SERIES_LIGHT.map((c, i) => `--cf-s${i}:${c};`).join("");
  const dark = SERIES_DARK.map((c, i) => `--cf-s${i}:${c};`).join("");
  return (
    `[data-cf="${uid}"]{${light}--cf-axis:#a8a29e;--cf-grid:rgba(28,25,23,0.09);` +
    `--cf-text:#78716c;--cf-strong:#292524;--cf-ref:#57534e;--cf-dot-ring:#ffffff;}` +
    `.dark [data-cf="${uid}"]:not([data-light] *){${dark}--cf-axis:#57534e;--cf-grid:rgba(231,229,228,0.12);` +
    `--cf-text:#a8a29e;--cf-strong:#e7e5e4;--cf-ref:#a8a29e;--cf-dot-ring:#0E0F13;}`
  );
}

/* ------------------------------------------------------------------ *
 * Deterministic number helpers
 *
 * Math.pow and Math.log10 are implementation-approximated: the spec does
 * not pin their last bit, so two engines can disagree and a tick label
 * rendered on the server can differ from the one hydrated in the browser.
 * Powers of ten are built by repeated multiplication (exact in IEEE754
 * for the range a chart axis ever reaches) and the decimal exponent is
 * found by looping, so no axis in the library depends on a transcendental.
 * ------------------------------------------------------------------ */

const round2 = (n: number) => Math.round(n * 100) / 100;

function pow10(e: number): number {
  let r = 1;
  for (let i = 0; i < Math.abs(e); i++) r *= 10;
  return e < 0 ? 1 / r : r;
}

/** floor(log10(|x|)) without Math.log10. */
function magnitude(x: number): number {
  const a = Math.abs(x);
  if (!(a > 0) || !Number.isFinite(a)) return 0;
  let e = 0;
  let v = a;
  if (v >= 1) while (v >= 10) { v /= 10; e++; }
  else while (v < 1) { v *= 10; e--; }
  return e;
}

/** Round to the number of decimals a step of this size actually carries. */
function roundToStep(v: number, step: number): number {
  const p = pow10(Math.max(0, -magnitude(step)));
  return Math.round(v * p) / p;
}

/**
 * Thousands separators by hand. `toLocaleString` reads the runtime locale,
 * which on the server is the build machine's and in the browser is the
 * visitor's, so a chart axis formatted with it can hydrate to a different
 * string than it rendered with.
 */
function group(n: number): string {
  const neg = n < 0;
  const [whole, frac] = Math.abs(n).toString().split(".");
  let out = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ",";
    out += whole[i];
  }
  return `${neg ? "-" : ""}${out}${frac ? `.${frac}` : ""}`;
}

/** Compact axis numbers: 12,400 reads as 12.4k on a tick, in full in a tooltip. */
export function formatCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${roundToStep(v / 1e9, 0.1)}B`;
  if (a >= 1e6) return `${roundToStep(v / 1e6, 0.1)}M`;
  if (a >= 1e4) return `${roundToStep(v / 1e3, 0.1)}k`;
  return group(roundToStep(v, a >= 10 ? 1 : a >= 1 ? 0.1 : 0.01));
}

export function formatFull(v: number): string {
  return group(roundToStep(v, Math.abs(v) >= 100 ? 1 : 0.01));
}

/* ------------------------------------------------------------------ *
 * Scales
 * ------------------------------------------------------------------ */

export type ScaleKind = "linear" | "time" | "band" | "log";

export interface Scale {
  kind: ScaleKind;
  /** Domain value to pixel, in the plot's own coordinate space. */
  at: (v: number) => number;
  /** Pixel back to a domain value. Band scales return the category index. */
  invert: (px: number) => number;
  ticks: () => { v: number; px: number; text: string }[];
  domain: [number, number];
  /** Full step between band centres. Band scales only. */
  band: number;
  categories: string[];
  format: (v: number) => string;
}

export interface AxisSpec {
  kind?: ScaleKind;
  /** [min, max] for linear/time/log. Ignored for band, which reads categories. */
  domain?: [number, number];
  /**
   * Seeds the domain in place of the raw values, then still gets padded,
   * zero-clamped and snapped out to whole ticks. Stacked charts need this:
   * their axis has to cover the summed bands, not the tallest single value,
   * and `domain` would pin it too hard to keep the tick snapping.
   */
  extent?: [number, number];
  /** Ordered category list. Implies a band scale when `kind` is omitted. */
  categories?: string[];
  label?: string;
  /** Roughly how many ticks to aim for. The generator lands on human numbers near it. */
  ticks?: number;
  format?: (v: number) => string;
  /** Extend the domain to include zero. Bars are wrong without it. */
  zero?: boolean;
  grid?: boolean;
  /**
   * Drops the tick labels for this axis. A streamgraph needs it: its
   * baseline floats to minimise wiggle, so the absolute position of a band
   * means nothing and a labelled axis would invite a reading that is not
   * there.
   */
  hideTicks?: boolean;
  /** Headroom past the extremes, as a fraction of the span. */
  pad?: number;
}

/**
 * The tick step that lands closest to the requested tick count.
 *
 * Rounding the rough step up to the next 1, 2, 5 or 10 is the usual
 * shortcut, and it silently costs plot area: a series topping out at 664
 * against a rough step of 133 rounds to 200, the domain snaps out to 800,
 * and a sixth of the chart is empty. Choosing the candidate whose tick
 * count is nearest the requested one picks 100 there, and the axis stops
 * at 700. Overshooting the count by a tick or two is cheaper than
 * throwing away a fifth of the drawing.
 */
function niceStep(span: number, count: number): number {
  if (!(span > 0)) return 1;
  const want = Math.max(1, count);
  const base = pow10(magnitude(span / want));
  let best = base;
  let bestErr = Infinity;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * base;
    const err = Math.abs(span / step - want);
    if (err < bestErr) { bestErr = err; best = step; }
  }
  return best;
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const step = niceStep(span, count);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  // Accumulate by index rather than by repeated addition: adding a float
  // step 20 times drifts far enough to print 0.30000000000000004.
  for (let i = 0; i < 64; i++) {
    const v = roundToStep(start + i * step, step);
    if (v > max + step * 1e-6) break;
    out.push(v);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

const TIME_STEPS = [
  MS_SECOND, 5 * MS_SECOND, 15 * MS_SECOND, 30 * MS_SECOND,
  MS_MINUTE, 5 * MS_MINUTE, 15 * MS_MINUTE, 30 * MS_MINUTE,
  MS_HOUR, 3 * MS_HOUR, 6 * MS_HOUR, 12 * MS_HOUR,
  MS_DAY, 2 * MS_DAY, 7 * MS_DAY, 14 * MS_DAY,
];

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/**
 * Everything is read in UTC. A server in one zone and a browser in
 * another would otherwise label the same instant with two different days,
 * which is a hydration mismatch that only shows up for some visitors.
 * Pass `format` to render in local time once you are client-only.
 */
function formatTime(ms: number, step: number): string {
  const d = new Date(ms);
  if (step < MS_DAY) return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  if (step < 28 * MS_DAY) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (step < 320 * MS_DAY) return MONTHS[d.getUTCMonth()];
  return `${d.getUTCFullYear()}`;
}

/** Calendar-stepped ticks past a fortnight, so months land on the 1st. */
function timeTicks(min: number, max: number, count: number): { v: number; step: number }[] {
  const span = max - min;
  if (!(span > 0)) return [{ v: min, step: MS_DAY }];
  const rough = span / Math.max(1, count);

  if (rough <= 14 * MS_DAY) {
    let step = TIME_STEPS[TIME_STEPS.length - 1];
    for (const s of TIME_STEPS) if (s >= rough) { step = s; break; }
    const out: { v: number; step: number }[] = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start, i = 0; v <= max && i < 64; v += step, i++) out.push({ v, step });
    return out;
  }

  const monthSpan = span / (30 * MS_DAY);
  const perTick = monthSpan / Math.max(1, count);
  const monthStep = perTick <= 1 ? 1 : perTick <= 3 ? 3 : perTick <= 6 ? 6 : 12 * Math.max(1, Math.round(perTick / 12));
  const step = monthStep * 30 * MS_DAY;
  const from = new Date(min);
  let y = from.getUTCFullYear();
  let m = Math.ceil(from.getUTCMonth() / monthStep) * monthStep;
  if (from.getUTCDate() > 1) m += monthStep;
  const out: { v: number; step: number }[] = [];
  for (let i = 0; i < 64; i++) {
    while (m >= 12) { m -= 12; y += 1; }
    const v = Date.UTC(y, m, 1);
    if (v > max) break;
    if (v >= min) out.push({ v, step });
    m += monthStep;
  }
  return out;
}

function buildScale(spec: AxisSpec, range: [number, number], values: number[]): Scale {
  const categories = spec.categories ?? [];
  const kind: ScaleKind = spec.kind ?? (categories.length > 0 ? "band" : "linear");
  const [r0, r1] = range;
  const extent = r1 - r0;
  const tickCount = spec.ticks ?? 5;

  if (kind === "band") {
    const n = Math.max(1, categories.length);
    // A band on the y axis runs against an inverted range, so the raw step
    // is negative. Bar thickness would then come out negative and the bars
    // would vanish, so direction is kept separate and `band` is always a
    // positive width a caller can multiply by.
    const dir = extent < 0 ? -1 : 1;
    const band = Math.abs(extent) / n;
    const at = (i: number) => round2(r0 + dir * band * (i + 0.5));
    return {
      kind,
      domain: [0, n - 1],
      band,
      categories,
      format: (v) => categories[Math.round(v)] ?? "",
      at,
      invert: (px) => Math.max(0, Math.min(n - 1, Math.floor((dir * (px - r0)) / band))),
      ticks: () => categories.map((text, i) => ({ v: i, px: at(i), text })),
    };
  }

  const finite = values.filter((v) => Number.isFinite(v));
  const rawMin = spec.extent ? spec.extent[0] : finite.length ? Math.min(...finite) : 0;
  const rawMax = spec.extent ? spec.extent[1] : finite.length ? Math.max(...finite) : 1;
  let min = spec.domain ? spec.domain[0] : rawMin;
  let max = spec.domain ? spec.domain[1] : rawMax;

  if (!spec.domain) {
    if (spec.zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const p = (max - min) * (spec.pad ?? 0);
    min -= p;
    max += p;
    // Headroom must not invent a sign the data never had. Padding a
    // series that bottoms out at zero into negative territory draws a
    // zero line floating above the axis, which reads as a rendering
    // fault rather than as breathing room.
    if (rawMin >= 0) min = Math.max(min, 0);
    if (rawMax <= 0) max = Math.min(max, 0);

    // Then snap the ends out to whole ticks. Left unsnapped, a series
    // topping out at 592 gets ticks at 0, 200 and 400 and simply stops
    // being labelled for its top third.
    if (kind === "linear" && max > min) {
      const step = niceStep(max - min, tickCount);
      min = roundToStep(Math.floor(min / step) * step, step);
      max = roundToStep(Math.ceil(max / step) * step, step);
    }
  }
  if (max === min) { max = min + 1; }

  if (kind === "log") {
    // A log axis cannot show zero or a negative, and silently clamping
    // would draw a point that is not in the data. Floor at the smallest
    // positive value instead and leave the gap visible.
    const positives = finite.filter((v) => v > 0);
    const lo = Math.max(positives.length ? Math.min(...positives) : 1, min > 0 ? min : 1e-9);
    const hi = Math.max(max, lo * 10);
    const l0 = Math.log(lo);
    const l1 = Math.log(hi);
    const span = l1 - l0 || 1;
    const format = spec.format ?? formatCompact;
    const at = (v: number) => round2(r0 + ((Math.log(Math.max(v, lo)) - l0) / span) * extent);
    const out: number[] = [];
    for (let e = magnitude(lo); e <= magnitude(hi); e++) {
      for (const m of [1, 2, 5]) {
        const v = m * pow10(e);
        if (v >= lo && v <= hi) out.push(v);
      }
    }
    return {
      kind, domain: [lo, hi], band: 0, categories: [], format,
      at,
      invert: (px) => Math.exp(l0 + ((px - r0) / extent) * span),
      ticks: () => out.map((v) => ({ v, px: at(v), text: format(v) })),
    };
  }

  const span = max - min || 1;
  const at = (v: number) => round2(r0 + ((v - min) / span) * extent);

  if (kind === "time") {
    const format = spec.format ?? ((v: number) => formatTime(v, span / Math.max(1, tickCount)));
    return {
      kind, domain: [min, max], band: 0, categories: [], format,
      at,
      invert: (px) => min + ((px - r0) / extent) * span,
      ticks: () =>
        timeTicks(min, max, tickCount).map(({ v, step }) => ({
          v, px: at(v), text: spec.format ? spec.format(v) : formatTime(v, step),
        })),
    };
  }

  const format = spec.format ?? formatCompact;
  return {
    kind, domain: [min, max], band: 0, categories: [], format,
    at,
    invert: (px) => min + ((px - r0) / extent) * span,
    ticks: () => niceTicks(min, max, tickCount).map((v) => ({ v, px: at(v), text: format(v) })),
  };
}

/* ------------------------------------------------------------------ *
 * Path builders
 *
 * Shared so there is one spline in the library rather than one per chart.
 * ------------------------------------------------------------------ */

export type Curve = "linear" | "spline" | "step" | "step-before";

export interface Pt {
  x: number;
  y: number;
}

/**
 * Monotone cubic (Fritsch-Carlson), not a natural cubic spline.
 *
 * A natural spline is smoother but overshoots: fed four rising points and
 * one flat one it bulges past the highest value in the data. On a line
 * chart that invents a peak nobody measured; on an area chart with a zero
 * baseline it dips the fill below zero. Monotone cubic is the version that
 * cannot leave the interval between two neighbouring points, which is the
 * only property that matters here. The weighted-harmonic tangent below is
 * what enforces it, and the `m[i - 1] * m[i] <= 0` branch flattens the
 * tangent at every local extreme so the curve turns over cleanly.
 */
function monotonePath(p: Pt[]): string {
  const n = p.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1].x - p[i].x;
    m[i] = (p[i + 1].y - p[i].y) / (dx[i] || 1);
  }
  const t: number[] = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d +=
      ` C${round2(p[i].x + h)},${round2(p[i].y + t[i] * h)}` +
      ` ${round2(p[i + 1].x - h)},${round2(p[i + 1].y - t[i + 1] * h)}` +
      ` ${p[i + 1].x},${p[i + 1].y}`;
  }
  return d;
}

/**
 * `step` holds each value until the next reading arrives; `step-before`
 * jumps to the new value at the previous x. Neither draws a diagonal,
 * which is the entire point of a step line: a diagonal claims the series
 * passed through every value in between, and a step series did not.
 */
export function linePath(pts: Pt[], curve: Curve = "linear"): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  if (curve === "spline") return monotonePath(pts);
  if (curve === "step" || curve === "step-before") {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      d += curve === "step" ? ` L${b.x},${a.y} L${b.x},${b.y}` : ` L${a.x},${b.y} L${b.x},${b.y}`;
    }
    return d;
  }
  return `M${pts.map((p) => `${p.x},${p.y}`).join(" L")}`;
}

/**
 * Point on a circle. Angle 0 is twelve o'clock and grows clockwise, which
 * is how every chart in the library reads a dial, and not how the maths
 * convention runs. Both coordinates are rounded: sine and cosine are
 * implementation-approximated, so an unrounded arc endpoint is a
 * hydration mismatch waiting for a browser that computes the last bit
 * differently.
 */
export function polarPoint(cx: number, cy: number, r: number, angle: number): Pt {
  return {
    x: Math.round((cx + r * Math.sin(angle)) * 100) / 100,
    y: Math.round((cy - r * Math.cos(angle)) * 100) / 100,
  };
}

/**
 * One arc segment, from a wedge (`r0` of zero) to an annulus band.
 *
 * Shared by every polar chart in the library rather than reimplemented per
 * chart: pie, donut, semi-circle donut, nightingale, gauge and the
 * sunburst all reduce to this, differing only in what they vary. A full
 * turn is drawn as two half arcs, because a single arc whose start and end
 * points coincide is degenerate and browsers draw nothing at all for it,
 * which is how a "100% of one category" pie ends up rendering blank.
 */
export function arcPath(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string {
  const sweep = a1 - a0;
  if (Math.abs(sweep) < 1e-6 || r1 <= 0) return "";
  const full = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
  const r = Math.round(r1 * 100) / 100;
  const ri = Math.round(Math.max(0, r0) * 100) / 100;

  if (full) {
    const mid = a0 + Math.PI;
    const t0 = polarPoint(cx, cy, r, a0);
    const t1 = polarPoint(cx, cy, r, mid);
    const outer = `M${t0.x},${t0.y} A${r},${r} 0 1 1 ${t1.x},${t1.y} A${r},${r} 0 1 1 ${t0.x},${t0.y}`;
    if (ri <= 0.01) return `${outer} Z`;
    const b0 = polarPoint(cx, cy, ri, a0);
    const b1 = polarPoint(cx, cy, ri, mid);
    // Opposite winding on the inner circle punches the hole out.
    return `${outer} Z M${b0.x},${b0.y} A${ri},${ri} 0 1 0 ${b1.x},${b1.y} A${ri},${ri} 0 1 0 ${b0.x},${b0.y} Z`;
  }

  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep > 0 ? 1 : 0;
  const p0 = polarPoint(cx, cy, r, a0);
  const p1 = polarPoint(cx, cy, r, a1);
  if (ri <= 0.01) {
    return `M${cx},${cy} L${p0.x},${p0.y} A${r},${r} 0 ${large} ${dir} ${p1.x},${p1.y} Z`;
  }
  const p2 = polarPoint(cx, cy, ri, a1);
  const p3 = polarPoint(cx, cy, ri, a0);
  return (
    `M${p0.x},${p0.y} A${r},${r} 0 ${large} ${dir} ${p1.x},${p1.y}` +
    ` L${p2.x},${p2.y} A${ri},${ri} 0 ${large} ${dir ? 0 : 1} ${p3.x},${p3.y} Z`
  );
}

/**
 * Closed band between two edges. The baseline is walked back through the
 * same curve as the top, so a stacked band and the band above it share an
 * edge exactly instead of leaving a hairline of background between them.
 */
export function areaPath(top: Pt[], bottom: Pt[], curve: Curve = "linear"): string {
  if (top.length === 0 || bottom.length === 0) return "";
  const back = linePath([...bottom].reverse(), curve);
  return `${linePath(top, curve)} L${back.slice(1)} Z`;
}

/* ------------------------------------------------------------------ *
 * Reveal
 * ------------------------------------------------------------------ */

/**
 * Scroll reveal is measured on an HTML wrapper, never on the SVG nodes
 * themselves. `whileInView` on a motion.g or motion.path is unreliable:
 * browsers report the bounding box of an SVG group inconsistently, so the
 * observer fires early, late, or not at all. Every chart in the library
 * takes `inView` from here and drives its own animation from it.
 */
export function useChartReveal(ref: React.RefObject<HTMLElement | null>) {
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const reduceMotion = useReducedMotion() ?? false;
  return { inView: reduceMotion ? true : inView, reduceMotion };
}

/* ------------------------------------------------------------------ *
 * Shared chrome
 *
 * Chart Frame is a cartesian frame: scales, axes, gridlines, a column
 * crosshair. A pie has none of those, and neither does a waffle, a funnel
 * or a gauge. What they do share with every line and bar chart is the
 * chrome around the drawing: the palette, the legend, the tooltip card,
 * the live region and the screen-reader table.
 *
 * So those live here as their own exports rather than inside the frame.
 * Chart Frame composes them like everything else; a polar chart uses them
 * without inheriting an axis it has no use for. The alternative was a
 * second legend implementation, and then a third.
 * ------------------------------------------------------------------ */

export interface SeriesSpec {
  id: string;
  label: string;
  /** Overrides the palette slot. Use a CSS colour, not a Tailwind class. */
  color?: string;
  /**
   * An SVG paint server (`url(#id)`) for the marks themselves: a pattern, a
   * gradient, an image. `color` still drives everything HTML (legend dots,
   * tooltip swatches), which cannot show a paint server.
   */
  paint?: string;
}

/**
 * Palette wiring for one chart instance: a stable id, the colour and dash
 * lookups, and the scoped `<style>` that defines the custom properties.
 * The element carrying `data-cf={uid}` must wrap everything that paints.
 */
export function useChartPaint(series: SeriesSpec[]) {
  const uid = useId().replace(/:/g, "");

  const color = useCallback(
    (id: string) => {
      const i = series.findIndex((s) => s.id === id);
      const own = series[i]?.color;
      if (own) return own;
      return `var(--cf-s${(i < 0 ? 0 : i) % CHART_SERIES_SLOTS})`;
    },
    [series],
  );

  const paint = useCallback(
    (id: string) => series.find((s) => s.id === id)?.paint ?? color(id),
    [series, color],
  );

  const dash = useCallback(
    (id: string) => {
      const i = series.findIndex((s) => s.id === id);
      // The dash exists to separate palette slots that sit close in
      // lightness. A series that brings its own colour has opted out of the
      // palette, and with it out of the fallback the palette needs.
      if (series[i]?.color) return undefined;
      return SERIES_DASH[Math.floor((i < 0 ? 0 : i) / SERIES_DASH_GROUP) % SERIES_DASH.length];
    },
    [series],
  );

  return { uid, color, paint, dash, style: <style>{paletteCss(uid)}</style> };
}

/* ------------------------------------------------------------------ *
 * Sequential ramp
 *
 * The six-slot palette answers "which series is this". A funnel, a
 * treemap and a sunburst ask a different question: the parts are one
 * ordered quantity, not six independent things, so stepping down the
 * categorical greys across them invents a boundary the data does not
 * have. These charts get a continuous ramp instead, and the position on
 * it is the *value* rather than the index, which makes lightness a
 * second reading of the same number.
 *
 * Greyscale suits a sequential ramp far better than it suits a
 * categorical palette: lightness is already the right encoding for
 * "more", so nothing is being substituted for a hue that used to carry
 * the meaning. The one thing that has to change is where the ramp ends.
 * A hue ramp can start at emerald-200 because the hue keeps a pale fill
 * visible on white; a grey one cannot, and a pale grey bar reads as a
 * hole punched in the card rather than as the smallest value. So each
 * ramp runs from the faintest grey that still nearly clears 3:1 on its
 * own surface (zinc-400 on white, zinc-500 on the near-black) to the
 * far end of the scale, and both directions stay inside the range where
 * a fill is a fill.
 *
 * Light runs pale to deep; dark runs deep to pale. Same idea both ways
 * round, since "more" on a white page is more ink and on a near-black
 * page is more light. Because the endpoints are chosen per theme rather
 * than shared, the dark ramp is not the light one reversed.
 *
 * Two contrast problems come with a ramp this wide, and both are
 * settled here rather than left to each chart:
 *
 * 1. A label sitting *on* a ramp fill needs 4.5:1. White clears it at
 *    the deep end and near-black clears it at the pale end, but the ramp
 *    has to pass through a middle where neither does. That dead zone is
 *    narrow, so `rampStop` nudges any value that lands inside it to the
 *    closer edge. The colour moves by well under one percent of the
 *    ramp, which is invisible, and the label is legible everywhere
 *    instead of almost everywhere.
 * 2. The faint end is under 3:1 against its own surface, which WCAG
 *    1.4.11 asks of a shape carrying meaning. Those stops get a hairline
 *    outline, so the outline reads as a property of the palest bands
 *    rather than as a border style. Raising the pale end to zinc-400
 *    shrank that band from the old palette's 41 percent of the ramp to
 *    8 percent, and in dark mode to nothing at all.
 *
 * Every threshold below is a precomputed constant. Working the contrast
 * out at render would mean raising channels to 2.4, and a transcendental
 * whose last bit the spec does not pin can hand the server and the
 * browser different answers on a stop sitting near an edge.
 * ------------------------------------------------------------------ */

const RAMP_TONES = {
  /**
   * The default, and the library's primary accent.
   */
  emerald: {
    lightFrom: "#10b981",
    lightTo: "#022c22",
    darkFrom: "#047857",
    darkTo: "#d1fae5",
    /**
     * Text on a pale fill. This is the page ink, not the deepest stop in
     * the tone's own family, and that is the whole reason a hue ramp is
     * usable here: emerald-950 is Y 0.022 against near-black's 0.005, and
     * that difference alone widens the dead zone from 1.2 percent of the
     * ramp to 30 percent. A deep-green label would look tidier in
     * isolation and would cost a third of the scale.
     */
    ink: "#09090b",
    edgeLight: "#047857",
    edgeDark: "#34d399",
    /** Below these the fill is under 3:1 on its surface and wants an edge. */
    edgeBelowLight: 0.11,
    edgeBelowDark: 0,
  },
  /**
   * The second tone, for the one chart that folds two ramps into the
   * same lane. Emerald and amber are far enough apart in hue that they
   * do not need the extra channel zinc and stone did, but HorizonChart
   * keeps its hatching anyway: hue alone fails for a red-green reader,
   * and that is exactly the pair this chart puts side by side.
   */
  amber: {
    lightFrom: "#d97706",
    lightTo: "#451a03",
    darkFrom: "#b45309",
    darkTo: "#fef3c7",
    ink: "#09090b",
    edgeLight: "#b45309",
    edgeDark: "#fbbf24",
    edgeBelowLight: 0,
    edgeBelowDark: 0,
  },
} as const;

export type RampTone = keyof typeof RAMP_TONES;

/**
 * Where neither white nor the tone's ink reaches 4.5:1. Both tones and
 * both themes share one list, widened to the union of all four, so a
 * chart drawing zinc above the fold and stone below it does not have to
 * keep several sets of thresholds straight. The lower band belongs to
 * the dark ramp and the upper to the light one, which is why they sit so
 * far apart.
 */
const RAMP_DEAD: [number, number][] = [
  [0.065, 0.079],
  [0.111, 0.12],
  [0.231, 0.242],
  [0.343, 0.352],
];
/** Above this the light fill is dark enough for white text. */
const RAMP_TEXT_LIGHT = 0.352;
/** Below this the dark fill is still dark enough for white text. */
const RAMP_TEXT_DARK = 0.065;
/**
 * The CIE L* below which a fill takes a white label and above which it
 * takes a black one, for the browser-side pick that overrides the two
 * positions above wherever relative colour syntax is supported. L* is a
 * function of luminance alone, and at Y 0.19 (L* 50.7) black and white
 * both sit at exactly 4.5:1, so this is the one cut that is right for any
 * hue: the positional thresholds are only right for the tones they were
 * measured on, and an override in another hue lands its ink half on fills
 * that need white (an indigo at the same HSL lightness as emerald-500 is
 * a third as bright).
 */
const RAMP_TEXT_LSTAR = 50.7;


/**
 * Clamp to [0, 1] and step out of the dead zones described above.
 */
export function rampStop(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  for (const [lo, hi] of RAMP_DEAD) {
    if (c > lo && c < hi) return c - lo < hi - c ? lo : hi;
  }
  return c;
}

/**
 * Paint for a ramped chart. `ts` are already-snapped positions, one per
 * part, and the returned lookups take the index of the part.
 *
 * The uid comes from `useChartPaint` so both style blocks land on the
 * same scope, and every colour is a custom property resolved by the
 * cascade rather than a class read during render. A chart needing two
 * ramps at once (a horizon chart folds emerald above its baseline and amber
 * below) calls this twice with different `key` values so the two sets of
 * properties do not collide.
 */
export function chartRamp(
  uid: string,
  ts: number[],
  opts: { tone?: RampTone; key?: string } = {},
) {
  const tone = RAMP_TONES[opts.tone ?? "emerald"];
  const k = opts.key ?? "r";
  // Every endpoint is read through a custom property with the tone as its
  // fallback, so the ramp has the same override hook the series palette
  // has: set `--cf-r-from` and `--cf-r-to` on any ancestor and a treemap,
  // funnel or sunburst repaints in that hue. The mix itself moves into CSS
  // (`color-mix` in sRGB is the same channel lerp a hex blend did) because a
  // hex computed here would bake the tone in. The edge threshold stays
  // precomputed: an override is expected to keep the tone's lightness
  // shape (pale to deep on white, deep to pale on the near-black), which is
  // what that constant was derived from.
  //
  // The label colour is not precomputed, because a position along the ramp
  // says nothing about luminance once the hue is an override. It is derived
  // from the resolved fill instead: `lab(from <fill> ...)` reads the fill's
  // L*, the offset from RAMP_TEXT_LSTAR is multiplied by minus infinity, and
  // lab() clamps the result to pure white below the line and pure black
  // above it. The positional pick is still written first, as the fallback
  // for a browser without relative colour syntax.
  const v = (name: string, fallback: string) => `var(--cf-${k}-${name},${fallback})`;
  const decl = (t: number, i: number, dark: boolean) => {
    const from = v("from", dark ? tone.darkFrom : tone.lightFrom);
    const to = v("to", dark ? tone.darkTo : tone.lightTo);
    const fill = `color-mix(in srgb,${to} ${Math.round(t * 1000) / 10}%,${from})`;
    const white = dark ? t <= RAMP_TEXT_DARK : t >= RAMP_TEXT_LIGHT;
    const below = dark ? tone.edgeBelowDark : tone.edgeBelowLight;
    const edge = t < below ? v("edge", dark ? tone.edgeDark : tone.edgeLight) : "transparent";
    const text = white ? "#ffffff" : tone.ink;
    return `--cf-${k}f${i}:${fill};--cf-${k}t${i}:${text};--cf-${k}e${i}:${edge};`;
  };

  const light = ts.map((t, i) => decl(t, i, false)).join("");
  const dark = ts.map((t, i) => decl(t, i, true)).join("");
  const auto = ts
    .map((_, i) => `--cf-${k}t${i}:lab(from var(--cf-${k}f${i}) calc((l - ${RAMP_TEXT_LSTAR}) * -infinity) 0 0);`)
    .join("");

  return {
    fill: (i: number) => `var(--cf-${k}f${i})`,
    text: (i: number) => `var(--cf-${k}t${i})`,
    edge: (i: number) => `var(--cf-${k}e${i})`,
    style: (
      <style>
        {`[data-cf="${uid}"]{${light}}.dark [data-cf="${uid}"]:not([data-light] *){${dark}}` +
          `@supports (color:lab(from red calc(l * -infinity) 0 0)){[data-cf="${uid}"],.dark [data-cf="${uid}"]:not([data-light] *){${auto}}}`}
      </style>
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Distribution maths
 *
 * Four charts in the library reduce raw observations to something
 * drawable, and they must all agree about how. A box plot whose median
 * sits at a different number from the histogram beside it is worse than
 * either chart alone.
 *
 * Nothing here touches a transcendental on the drawing path. Quantiles
 * and the kernel are polynomial, so they are exact in IEEE754 and the
 * server and the browser cannot disagree. The two places a power is
 * genuinely needed (Silverman's bandwidth, the Freedman-Diaconis bin
 * width) round their result before anything downstream sees it, so the
 * shape that gets drawn is identical on both.
 * ------------------------------------------------------------------ */

/**
 * Linear interpolation between order statistics, which is R's type 7 and
 * numpy's default. Stated because there are nine defensible definitions
 * of a quantile and they disagree on small samples: a box plot that does
 * not say which one it used cannot be checked against anything.
 */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export interface Summary {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  iqr: number;
  /** Whisker ends: the most extreme observations inside Tukey's fences. */
  lo: number;
  hi: number;
  mean: number;
  /** Observations beyond the fences, in ascending order. */
  outliers: number[];
  /** Ascending copy of the input. */
  sorted: number[];
}

/**
 * Tukey's five-number summary plus the fences.
 *
 * The whiskers stop at the most extreme observation *inside* 1.5 IQR of
 * the box, not at the fence itself. Drawing the whisker to the fence
 * invents a reading: the fence is a rule, the whisker end is a datum.
 */
export function summarise(values: number[]): Summary {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, iqr: NaN,
      lo: NaN, hi: NaN, mean: NaN, outliers: [], sorted };
  }
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const fenceLo = q1 - 1.5 * iqr;
  const fenceHi = q3 + 1.5 * iqr;
  let lo = sorted[n - 1];
  let hi = sorted[0];
  const outliers: number[] = [];
  for (const v of sorted) {
    if (v < fenceLo || v > fenceHi) outliers.push(v);
    else {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (outliers.length === n) { lo = sorted[0]; hi = sorted[n - 1]; }
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n, min: sorted[0], q1, median: quantile(sorted, 0.5), q3, max: sorted[n - 1],
    iqr, lo, hi, mean: sum / n, outliers, sorted,
  };
}

/**
 * Silverman's rule of thumb, rounded before it leaves.
 *
 * `n ** -0.2` is the one power in the pipeline and powers are
 * implementation-approximated, so the result is snapped to four decimals
 * here. Everything downstream is polynomial on that number, which makes
 * the density curve bit-identical on the server and in the browser.
 */
export function silverman(s: Summary): number {
  if (s.n < 2) return 1;
  let sq = 0;
  for (const v of s.sorted) sq += (v - s.mean) * (v - s.mean);
  const sd = Math.sqrt(sq / (s.n - 1));
  const spread = s.iqr > 0 ? Math.min(sd, s.iqr / 1.34) : sd;
  const h = 1.06 * (spread || sd || 1) * Math.pow(s.n, -0.2);
  return Math.max(1e-6, Math.round(h * 10000) / 10000);
}

/**
 * Kernel density estimate with an Epanechnikov kernel.
 *
 * Gaussian is the reflex choice and it is the wrong one here twice over.
 * It needs `Math.exp`, which is implementation-approximated and would put
 * a transcendental on the drawing path of every violin and ridge; and it
 * has infinite support, so every observation contributes to every
 * evaluation point and the curve never quite reaches zero. Epanechnikov
 * is a polynomial with compact support, which makes it exact, faster, and
 * the kernel that minimises asymptotic error in the first place.
 */
export function kde(sorted: number[], at: number[], bandwidth: number): number[] {
  const h = bandwidth > 0 ? bandwidth : 1;
  const scale = 0.75 / (sorted.length * h);
  return at.map((x) => {
    let sum = 0;
    for (const v of sorted) {
      const u = (x - v) / h;
      if (u > -1 && u < 1) sum += 1 - u * u;
    }
    return sum * scale;
  });
}

export type BinStrategy = "freedman-diaconis" | "sturges" | "sqrt";

/**
 * Bin edges for a histogram.
 *
 * Bin width is the entire chart: the same data binned two ways tells two
 * stories, so the strategy is a named choice the caller makes and the
 * chart reports, never a constant buried in here. The chosen width is
 * snapped to a whole 1, 2 or 5 times a power of ten, which keeps the
 * edges readable numbers and, as a side effect, makes the two strategies
 * that need a fractional power deterministic.
 */
export function binEdges(
  s: Summary,
  strategy: BinStrategy,
  count?: number,
): { edges: number[]; width: number; count: number } {
  const span = s.max - s.min;
  if (s.n === 0 || !(span > 0)) {
    return { edges: [s.min || 0, (s.min || 0) + 1], width: 1, count: 1 };
  }

  let k: number;
  if (count && count > 0) {
    k = Math.round(count);
  } else if (strategy === "sturges") {
    // log2 by counting doublings rather than calling Math.log2, which is
    // implementation-approximated and would make the bin count itself a
    // thing the server and the browser could disagree about.
    let bits = 0;
    for (let m = 1; m < s.n; m *= 2) bits++;
    k = bits + 1;
  } else if (strategy === "sqrt") {
    k = Math.ceil(Math.sqrt(s.n));
  } else {
    const h = s.iqr > 0 ? 2 * s.iqr * Math.pow(s.n, -1 / 3) : 0;
    k = h > 0 ? Math.ceil(span / h) : Math.ceil(Math.sqrt(s.n));
  }
  k = Math.max(1, Math.min(200, k));

  const width = niceStep(span, k);
  const start = Math.floor(s.min / width) * width;
  const end = Math.ceil(s.max / width) * width;
  const edges: number[] = [];
  for (let v = start; v <= end + width / 2; v += width) edges.push(roundToStep(v, width));
  if (edges.length < 2) edges.push(roundToStep(start + width, width));
  return { edges, width, count: edges.length - 1 };
}

export interface TooltipRow {
  label: string;
  value: string;
  /** Omit for a channel row, which is not a series and gets no swatch. */
  swatch?: string;
}

/** The tooltip card. Placement is the caller's job; a pie anchors nothing like a bar. */
export function ChartTooltipCard({
  title,
  rows,
  reduceMotion,
}: {
  title: string;
  rows: TooltipRow[];
  reduceMotion: boolean;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="min-w-[112px] whitespace-nowrap rounded-lg bg-stone-900 px-3 py-2 text-[11px] shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:bg-white"
    >
      <p className="mb-1 font-medium text-white/60 dark:text-stone-900/60">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2 text-white dark:text-stone-900">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={r.swatch ? { background: r.swatch } : undefined}
          />
          <span className="text-white/70 dark:text-stone-900/70">{r.label}</span>
          <span className="ml-auto font-medium tabular-nums">{r.value}</span>
        </p>
      ))}
    </motion.div>
  );
}

/**
 * Click-to-toggle legend. The last visible series cannot be switched off:
 * an empty plot reads as a broken chart rather than as a filter the user
 * applied.
 */
export function ChartLegend({
  series,
  hidden,
  onToggle,
  color,
  inView,
  reduceMotion,
}: {
  series: SeriesSpec[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  color: (id: string) => string;
  inView: boolean;
  reduceMotion: boolean;
}) {
  const visible = series.filter((s) => !hidden.has(s.id));
  const locked = visible.length === 1 ? visible[0].id : null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      {series.map((s, i) => {
        const off = hidden.has(s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={!off}
            disabled={locked === s.id}
            onClick={() => onToggle(s.id)}
            title={locked === s.id ? "At least one series stays visible" : undefined}
            className={`group flex items-center gap-2 rounded-md px-1 py-0.5 text-xs transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:cursor-default ${
              off ? "opacity-40" : "opacity-100"
            }`}
          >
            <motion.span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full"
              style={{
                background: off ? "transparent" : color(s.id),
                boxShadow: off ? `inset 0 0 0 1.5px ${color(s.id)}` : undefined,
              }}
              initial={reduceMotion ? false : { scale: 0 }}
              animate={inView ? { scale: 1 } : undefined}
              transition={{ duration: 0.35, delay: 0.3 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            />
            <span className="text-stone-600 group-hover:text-stone-900 dark:text-stone-300 dark:group-hover:text-stone-100">
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The non-visual alternative to the drawing. Every chart in the library
 * ships one: colour and position are the encoding, and neither survives a
 * screen reader.
 */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: { head: string; cells: string[] }[];
}) {
  if (rows.length === 0) return null;
  // The wrapper carries sr-only, not the table: a table treats a 1px height
  // as a minimum and grows to its rows, and that box (absolutely positioned)
  // adds to the scroll height of whatever scroll container holds the chart.
  return (
    <div className="sr-only">
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`row-${i}`}>
            <th scope="row">{r.head}</th>
            {r.cells.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */


export interface ChartPoint {
  /** Category name on a band axis, a number or epoch ms otherwise. */
  x: number | string;
  /** Row name in the tooltip and the data table. Defaults to the formatted x. */
  label?: string;
  /** Series id to value. `null` is a gap in the data, never a zero. */
  values: Record<string, number | null>;
  /** Extra channels (a bubble's size, a category name). Surfaced through `channels`. */
  meta?: Record<string, number | string>;
}

/** An extra column read from `point.meta`, shown in tooltip, announcement and table. */
export interface ChartChannel {
  id: string;
  label: string;
  format?: (v: number | string) => string;
}

export interface ChartContext {
  x: Scale;
  y: Scale;
  /** Plot area, inside the axis gutters. */
  width: number;
  height: number;
  /** Left and top offset of the plot area inside the svg. */
  left: number;
  top: number;
  /** Visible series only: a legend toggle removes them from here. */
  series: SeriesSpec[];
  color: (id: string) => string;
  /** What a mark is filled with: the series' `paint` if it has one, else its colour. */
  paint: (id: string) => string;
  dash: (id: string) => string | undefined;
  points: ChartPoint[];
  /** Pixel position of a point on the x axis. */
  px: (point: ChartPoint, index: number) => number;
  inView: boolean;
  reduceMotion: boolean;
  uid: string;
  /** Index of the hovered or keyboard-focused column, if any. */
  active: number | null;
  /** The resolved series under the pointer. Only set in `nearest` hover mode. */
  activeSeries: string | null;
  /** True when `point.x` runs down the left axis instead of across the bottom. */
  horizontal: boolean;
  /** The axis carrying `point.x`. Aliases `x` or `y` depending on orientation. */
  position: Scale;
  /** The axis carrying the series values. The other one. */
  value: Scale;
}

export interface ReferenceLine {
  axis?: "x" | "y";
  value: number;
  /** Draws a band instead of a line when set. */
  to?: number;
  label?: string;
}

export interface ChartFrameProps {
  /** Accessible name. Charts encode with position and colour, so this is required. */
  label: string;
  /** One sentence a screen reader hears before the data table. */
  summary?: string;
  x?: AxisSpec;
  y?: AxisSpec;
  series?: SeriesSpec[];
  points?: ChartPoint[];
  height?: number;
  /** Fallback width for the server render, before the container is measured. */
  initialWidth?: number;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  reference?: ReferenceLine[];
  legend?: boolean;
  /** Column crosshair, series dots, and the tooltip. */
  tooltip?: boolean;
  /**
   * How a pointer resolves to a reading. `column` highlights every series at
   * one x, which is what a line or bar chart wants. `nearest` resolves a
   * single mark in two dimensions, which is the only sane behaviour for a
   * scatter, where two points sharing an x are unrelated observations.
   */
  hover?: "column" | "nearest";
  /**
   * What the crosshair draws. `both` is the default: a dashed line at the
   * active column and a dot on every visible series. `line` drops the
   * dots, which a chart whose marks do not sit on the shared value scale
   * has to do (a horizon chart folds each row into its own lane, so a dot
   * placed at the row's real value lands outside the row). `none` leaves
   * the highlight entirely to the chart while keeping the tooltip, the
   * arrow-key roving and the live region.
   */
  crosshair?: "both" | "line" | "none";
  /** Extra channels read from `point.meta`. */
  channels?: ChartChannel[];
  /**
   * Which axis the points' `x` field is plotted along. `vertical` is the
   * usual thing: categories run across the bottom and values go up.
   * `horizontal` turns the plot on its side, which is the difference
   * between a column chart and a bar chart, and the only readable layout
   * once category names get long. `x` still describes the bottom axis and
   * `y` the left one, so in horizontal mode the caller puts the categories
   * in `y` and the value spec in `x`.
   */
  orientation?: "vertical" | "horizontal";
  /**
   * Supplies the y domain as a function of which series are still visible.
   * Stacked charts need it: their axis covers summed bands, so switching a
   * series off through the legend has to reshape the axis, and a static
   * `y.domain` would leave the plot sitting in dead space.
   */
  yExtent?: (visibleIds: string[], points: ChartPoint[]) => [number, number];
  /** Value formatter for the tooltip and the table. Falls back to the y axis format. */
  formatValue?: (v: number) => string;
  className?: string;
  children?: (ctx: ChartContext) => ReactNode;
  /**
   * Drawn after the axes, in the same coordinates as `children` but
   * *outside* the plot clip.
   *
   * Everything in `children` is clipped to the plot area, which is what
   * keeps a line from spilling over its own axis. End labels are the one
   * thing that legitimately belongs in the gutters: a slopegraph names
   * its series beside the first and last column, and clipped to the plot
   * those names have nowhere to go but on top of the lines. Reserve the
   * room with `padding` and draw them here.
   */
  overlay?: (ctx: ChartContext) => ReactNode;
}

const AXIS_GUTTER = { top: 12, right: 12, bottom: 28, left: 44 };

export function ChartFrame({
  label,
  summary,
  x: xSpec = {},
  y: ySpec = {},
  series = [],
  points = [],
  height = 240,
  initialWidth = 640,
  padding,
  reference = [],
  legend = true,
  tooltip = true,
  hover = "column",
  crosshair = "both",
  channels = [],
  orientation = "vertical",
  yExtent,
  formatValue,
  className = "",
  children,
  overlay,
}: ChartFrameProps) {
  const { uid, color: colorOf, paint: paintOf, dash: dashOf, style: paletteStyle } = useChartPaint(series);
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<SVGRectElement>(null);
  const { inView, reduceMotion } = useChartReveal(wrapRef);

  // Width is measured rather than left to the viewBox, so a 12px tick label
  // is 12px on a 320px card and on a 1200px hero. A viewBox that scales the
  // whole drawing scales the type with it, and the axis of a wide chart ends
  // up set in what reads as 20px. The server and the first client paint both
  // use initialWidth so there is nothing to hydrate a mismatch on; the
  // measured value lands in an effect, before the scroll reveal plays.
  const [width, setWidth] = useState(initialWidth);
  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);
  const [activeSeries, setActiveSeries] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const visible = useMemo(() => series.filter((s) => !hidden.has(s.id)), [series, hidden]);

  // Turned on its side, the left axis carries category names rather than
  // four-character numbers, and a fixed 44px gutter simply cuts them off.
  // The width is estimated from the longest label at the tick font size,
  // which is cheap and stable; measuring text would mean a layout pass
  // whose result differs between the server and the browser.
  const sideLabels =
    orientation === "horizontal" && !ySpec.hideTicks
      ? (ySpec.categories ?? points.map((p) => String(p.x)))
      : [];
  const sideGutter = sideLabels.reduce((m, t) => Math.max(m, t.length), 0) * 6.4 + 16;

  const gutter = {
    ...AXIS_GUTTER,
    ...(sideLabels.length > 0 ? { left: Math.min(200, Math.max(AXIS_GUTTER.left, Math.round(sideGutter))) } : {}),
    ...(ySpec.hideTicks ? { left: 8 } : {}),
    ...(xSpec.hideTicks ? { bottom: 12 } : {}),
    ...padding,
  };
  const plotW = Math.max(0, width - gutter.left - gutter.right);
  const plotH = Math.max(0, height - gutter.top - gutter.bottom);

  const horizontal = orientation === "horizontal";
  const posSpec = horizontal ? ySpec : xSpec;
  const valSpec = horizontal ? xSpec : ySpec;

  const isBandPos =
    (posSpec.kind ?? (posSpec.categories ? "band" : undefined)) === "band" || !!posSpec.categories;
  const posValues = useMemo(
    () => (isBandPos ? [] : points.map((p) => (typeof p.x === "number" ? p.x : Number(p.x)))),
    [points, isBandPos],
  );
  const yValues = useMemo(() => {
    const out: number[] = [];
    for (const p of points) {
      for (const s of visible) {
        const v = p.values[s.id];
        if (typeof v === "number" && Number.isFinite(v)) out.push(v);
      }
    }
    return out;
  }, [points, visible]);

  const posCategories = posSpec.categories ?? (isBandPos ? points.map((p) => String(p.x)) : undefined);
  const posScale = useMemo(
    // Horizontally, the first category belongs at the top: a bar chart is
    // read down the page like a list, not up from an origin.
    () => buildScale({ ...posSpec, categories: posCategories }, horizontal ? [0, plotH] : [0, plotW], posValues),
    [posSpec, posCategories, plotW, plotH, posValues, horizontal],
  );
  const extent = useMemo(
    () => yExtent?.(visible.map((s) => s.id), points),
    [yExtent, visible, points],
  );
  const valScale = useMemo(
    // The vertical value range is inverted: SVG y grows downward, charts
    // grow upward. Horizontally it runs left to right like the maths does.
    () =>
      buildScale(
        { zero: true, ...valSpec, ...(extent ? { extent } : {}) },
        horizontal ? [0, plotW] : [plotH, 0],
        yValues,
      ),
    [valSpec, plotH, plotW, yValues, extent, horizontal],
  );

  const xScale = horizontal ? valScale : posScale;
  const yScale = horizontal ? posScale : valScale;

  /** Position of a point along whichever axis carries `point.x`. */
  const pxOf = useCallback(
    (point: ChartPoint, index: number) =>
      posScale.kind === "band"
        ? posScale.at(index)
        : posScale.at(typeof point.x === "number" ? point.x : Number(point.x)),
    [posScale],
  );

  const fmt = useCallback(
    (v: number) => (formatValue ? formatValue(v) : ySpec.format ? ySpec.format(v) : formatFull(v)),
    [formatValue, ySpec],
  );

  const rowLabel = useCallback(
    (p: ChartPoint, i: number) =>
      p.label ?? (posScale.kind === "band" ? posScale.categories[i] ?? String(p.x) : posScale.format(Number(p.x))),
    [posScale],
  );

  /** Nearest column to a pixel, used by both the pointer and the keyboard. */
  const columnAt = useCallback(
    (px: number) => {
      if (points.length === 0) return null;
      if (posScale.kind === "band") return Math.max(0, Math.min(points.length - 1, posScale.invert(px)));
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(pxOf(points[i], i) - px);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    },
    [points, posScale, pxOf],
  );

  /** Nearest mark in two dimensions, for scatter-shaped data. */
  const markAt = useCallback(
    (mx: number, my: number) => {
      let best: { i: number; id: string } | null = null;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const px = pxOf(points[i], i);
        for (const s of visible) {
          const v = points[i].values[s.id];
          if (typeof v !== "number") continue;
          const vp = valScale.at(v);
          const dx = (horizontal ? vp : px) - mx;
          const dy = (horizontal ? px : vp) - my;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = { i, id: s.id }; }
        }
      }
      return best;
    },
    [points, visible, pxOf, valScale, horizontal],
  );

  // Left as plain functions rather than wrapped in useCallback: the React
  // Compiler memoises them itself, and a manual dependency list here does
  // not match the one it infers, which makes it skip the whole component.
  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    if (!tooltip) return;
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (hover === "nearest") {
      const hit = markAt(mx, my);
      setActive(hit ? hit.i : null);
      setActiveSeries(hit ? hit.id : null);
      return;
    }
    setActive(columnAt(horizontal ? my : mx));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!tooltip || points.length === 0) return;
    const at = active ?? 0;

    // In nearest mode the marks form a grid, so up and down change series
    // and left and right walk along one. Without that, a scatter with three
    // series would only ever be keyboard-reachable one series deep.
    if (hover === "nearest" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (visible.length === 0) return;
      e.preventDefault();
      const cur = Math.max(0, visible.findIndex((s) => s.id === activeSeries));
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveSeries(visible[(cur + step + visible.length) % visible.length].id);
      if (active === null) setActive(0);
      return;
    }

    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(points.length - 1, at + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    else if (e.key === "Escape") { setActive(null); setActiveSeries(null); return; }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    if (hover === "nearest" && !activeSeries) setActiveSeries(visible[0]?.id ?? null);
  }

  const toggle = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const channelText = useCallback(
    (p: ChartPoint) =>
      channels
        .filter((c) => p.meta?.[c.id] !== undefined)
        .map((c) => {
          const raw = p.meta![c.id];
          return `${c.label} ${c.format ? c.format(raw) : typeof raw === "number" ? fmt(raw) : raw}`;
        }),
    [channels, fmt],
  );

  const describe = useCallback(
    (i: number) => {
      const p = points[i];
      if (!p) return "";
      // In nearest mode the reading is one mark, so announcing every series
      // at that x would name points the pointer is not on.
      const named = hover === "nearest" && activeSeries ? visible.filter((s) => s.id === activeSeries) : visible;
      const parts = named.map((s) => {
        const v = p.values[s.id];
        return `${s.label} ${v === null || v === undefined ? "no data" : fmt(v)}`;
      });
      return [rowLabel(p, i), ...parts, ...channelText(p)].join(", ");
    },
    [points, visible, fmt, rowLabel, hover, activeSeries, channelText],
  );

  const ctx: ChartContext = {
    x: xScale, y: yScale, width: plotW, height: plotH,
    left: gutter.left, top: gutter.top,
    series: visible, color: colorOf, paint: paintOf, dash: dashOf, points,
    px: pxOf, inView, reduceMotion, uid, active,
    activeSeries: hover === "nearest" ? activeSeries : null,
    horizontal, position: posScale, value: valScale,
  };

  const spring = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 38, mass: 0.6 };

  const activePoint = active !== null ? points[active] : undefined;
  const activeX = activePoint ? pxOf(activePoint, active as number) : 0;
  const yTicks = useMemo(() => (plotH > 0 ? yScale.ticks() : []), [yScale, plotH]);
  const xTicks = useMemo(() => (plotW > 0 ? xScale.ticks() : []), [xScale, plotW]);

  // Drop every other x tick until the labels stop colliding. Rotating them
  // instead would cost a line of height on every chart in the library to
  // solve a problem only the crowded ones have.
  const xStride = useMemo(() => {
    if (xTicks.length < 2 || plotW <= 0) return 1;
    const widest = xTicks.reduce((m, t) => Math.max(m, t.text.length), 0) * 6.5 + 12;
    return Math.max(1, Math.ceil(widest / Math.max(1, plotW / xTicks.length)));
  }, [xTicks, plotW]);

  return (
    <div ref={wrapRef} data-cf={uid} className={`relative w-full ${className}`}>
      {paletteStyle}

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        aria-describedby={`cf-hint-${uid}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => { setFocused(true); if (active === null && points.length) setActive(0); }}
        onBlur={() => { setFocused(false); setActive(null); setActiveSeries(null); }}
        className="block max-w-full rounded-lg outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
      >
        <defs>
          <clipPath id={`cf-clip-${uid}`}>
            <rect x={0} y={0} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        <g transform={`translate(${gutter.left} ${gutter.top})`}>
          {/* Gridlines wipe out from the axis rather than fading in place, so
              the frame reads as being drawn before the data lands on it. */}
          {/* A hidden axis drops its gridlines with it. Lines the reader
              cannot put a number to are furniture, and on a stream graph
              they invite measuring against a baseline that is not fixed. */}
          {(ySpec.grid ?? true) && !ySpec.hideTicks &&
            yTicks.map((t, i) => (
              <motion.line
                key={`gy-${t.v}`}
                x1={0}
                x2={plotW}
                y1={t.px}
                y2={t.px}
                stroke="var(--cf-grid)"
                strokeWidth={1}
                initial={reduceMotion ? false : { scaleX: 0, opacity: 0 }}
                animate={inView ? { scaleX: 1, opacity: 1 } : undefined}
                style={{ transformOrigin: "0px 0px" }}
                transition={{ duration: 0.5, delay: 0.04 * i, ease: [0.22, 1, 0.36, 1] }}
              />
            ))}

          {xSpec.grid && !xSpec.hideTicks &&
            xTicks.map((t, i) => (
              <motion.line
                key={`gx-${t.v}`}
                x1={t.px}
                x2={t.px}
                y1={0}
                y2={plotH}
                stroke="var(--cf-grid)"
                strokeWidth={1}
                initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
                animate={inView ? { scaleY: 1, opacity: 1 } : undefined}
                style={{ transformOrigin: `0px ${plotH}px` }}
                transition={{ duration: 0.5, delay: 0.04 * i, ease: [0.22, 1, 0.36, 1] }}
              />
            ))}

          {reference.map((r, i) => {
            const scale = (r.axis ?? "y") === "y" ? yScale : xScale;
            const a = scale.at(r.value);
            const b = r.to !== undefined ? scale.at(r.to) : null;
            const vertical = (r.axis ?? "y") === "x";
            return (
              <motion.g
                key={`ref-${i}`}
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={inView ? { opacity: 1 } : undefined}
                transition={{ duration: 0.5, delay: 0.35 }}
              >
                {b === null ? (
                  <line
                    x1={vertical ? a : 0}
                    x2={vertical ? a : plotW}
                    y1={vertical ? 0 : a}
                    y2={vertical ? plotH : a}
                    stroke="var(--cf-ref)"
                    strokeWidth={1}
                    strokeDasharray="5 4"
                    strokeOpacity={0.85}
                  />
                ) : (
                  <rect
                    x={vertical ? Math.min(a, b) : 0}
                    y={vertical ? 0 : Math.min(a, b)}
                    width={vertical ? Math.abs(b - a) : plotW}
                    height={vertical ? plotH : Math.abs(b - a)}
                    fill="var(--cf-ref)"
                    fillOpacity={0.08}
                  />
                )}
                {r.label && (
                  <text
                    x={vertical ? a + 4 : plotW}
                    // A reference line sitting on the domain maximum would
                    // put its label in the top gutter, where the svg clips
                    // it. Flip it under the line instead of losing it.
                    y={vertical ? 12 : a < 14 ? a + 14 : a - 6}
                    textAnchor={vertical ? "start" : "end"}
                    fontSize={11}
                    fill="var(--cf-ref)"
                  >
                    {r.label}
                  </text>
                )}
              </motion.g>
            );
          })}

          {/* A zero line is not a gridline: it is the thing every value is
              read against, so it is drawn darker and never dropped. */}
          {valScale.kind !== "band" && valScale.domain[0] < 0 && valScale.domain[1] > 0 && (
            <line
              x1={horizontal ? valScale.at(0) : 0}
              x2={horizontal ? valScale.at(0) : plotW}
              y1={horizontal ? 0 : valScale.at(0)}
              y2={horizontal ? plotH : valScale.at(0)}
              stroke="var(--cf-axis)"
              strokeWidth={1}
            />
          )}

          <g clipPath={`url(#cf-clip-${uid})`}>{children?.(ctx)}</g>

          <line x1={0} x2={plotW} y1={plotH} y2={plotH} stroke="var(--cf-axis)" strokeWidth={1} strokeOpacity={0.55} />

          {(ySpec.hideTicks ? [] : yTicks).map((t, i) => (
            <motion.text
              key={`ty-${t.v}`}
              x={-8}
              y={t.px}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={11}
              fill="var(--cf-text)"
              className="tabular-nums"
              initial={reduceMotion ? false : { opacity: 0, x: -6 }}
              animate={inView ? { opacity: 1, x: 0 } : undefined}
              transition={{ duration: 0.4, delay: 0.04 * i, ease: [0.22, 1, 0.36, 1] }}
            >
              {t.text}
            </motion.text>
          ))}

          {(xSpec.hideTicks ? [] : xTicks).map((t, i) =>
            i % xStride === 0 ? (
              <motion.text
                key={`tx-${t.v}`}
                x={t.px}
                y={plotH + 16}
                textAnchor="middle"
                dominantBaseline="hanging"
                fontSize={11}
                fill="var(--cf-text)"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={inView ? { opacity: 1, y: 0 } : undefined}
                transition={{ duration: 0.4, delay: 0.04 * i, ease: [0.22, 1, 0.36, 1] }}
              >
                {t.text}
              </motion.text>
            ) : null,
          )}

          {/* One crosshair that slides between columns instead of two states
              cross-fading: the library's standard way of showing that the
              active thing moved. */}
          {tooltip && activePoint && (
            <motion.g
              aria-hidden="true"
              className="pointer-events-none"
              initial={false}
              animate={horizontal ? { y: activeX, x: 0 } : { x: activeX, y: 0 }}
              transition={spring}
            >
              {hover === "column" && crosshair !== "none" &&
                (horizontal ? (
                  <line x1={0} x2={plotW} stroke="var(--cf-axis)" strokeWidth={1} strokeDasharray="4 4" />
                ) : (
                  <line y1={0} y2={plotH} stroke="var(--cf-axis)" strokeWidth={1} strokeDasharray="4 4" />
                ))}
              {(crosshair !== "both"
                ? []
                : hover === "nearest"
                  ? visible.filter((s) => s.id === activeSeries)
                  : visible
              ).map((s) => {
                const v = activePoint.values[s.id];
                if (typeof v !== "number") return null;
                const along = valScale.at(v);
                const cx = horizontal ? along : 0;
                const cy = horizontal ? 0 : along;
                return (
                  <g key={s.id}>
                    <circle cx={cx} cy={cy} r={6} fill={colorOf(s.id)} fillOpacity={0.2} />
                    <circle cx={cx} cy={cy} r={3.5} fill={colorOf(s.id)} stroke="var(--cf-dot-ring)" strokeWidth={1.5} />
                  </g>
                );
              })}
            </motion.g>
          )}

          {overlay?.(ctx)}

          <rect
            ref={plotRef}
            x={0}
            y={0}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => { if (!focused) { setActive(null); setActiveSeries(null); } }}
          />
        </g>
      </svg>

      {/* Anchored to the side of the crosshair with the most room, so the
          panel never covers the dot it is describing. */}
      {tooltip && activePoint && (
        <div
          className="pointer-events-none absolute z-10"
          style={
            horizontal
              ? {
                  left: `${gutter.left + plotW}px`,
                  top: `${gutter.top + activeX}px`,
                  transform: "translate(calc(-100% - 12px), -50%)",
                }
              : {
                  left: `${gutter.left + activeX}px`,
                  top: `${gutter.top}px`,
                  transform: activeX > plotW / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
                }
          }
        >
          <ChartTooltipCard
            reduceMotion={reduceMotion}
            title={rowLabel(activePoint, active as number)}
            rows={[
              ...(hover === "nearest" && activeSeries
                ? visible.filter((sr) => sr.id === activeSeries)
                : visible
              ).map((sr) => {
                const v = activePoint.values[sr.id];
                return {
                  label: sr.label,
                  value: typeof v === "number" ? fmt(v) : "no data",
                  swatch: colorOf(sr.id),
                };
              }),
              ...channels
                .filter((c) => activePoint.meta?.[c.id] !== undefined)
                .map((c) => {
                  const raw = activePoint.meta![c.id];
                  return {
                    label: c.label,
                    value: c.format ? c.format(raw) : typeof raw === "number" ? fmt(raw) : String(raw),
                  };
                }),
            ]}
          />
        </div>
      )}

      {legend && series.length > 1 && (
        <ChartLegend
          series={series}
          hidden={hidden}
          onToggle={toggle}
          color={colorOf}
          inView={inView}
          reduceMotion={reduceMotion}
        />
      )}

      <p id={`cf-hint-${uid}`} className="sr-only">
        {summary ? `${summary} ` : ""}
        Interactive chart. Use the left and right arrow keys to move between data points
        {hover === "nearest" ? ", up and down to change series" : ""}, Escape to dismiss the
        reading. The full data follows as a table.
      </p>

      {/* One live region for the whole chart. Announcing per series would
          queue several messages for a single arrow-key press. */}
      <span className="sr-only" aria-live="polite">
        {active !== null ? describe(active) : ""}
      </span>

      <ChartTable
        caption={label}
        columns={[xSpec.label ?? "Point", ...series.map((sr) => sr.label), ...channels.map((c) => c.label)]}
        rows={points.map((pt, i) => ({
          head: rowLabel(pt, i),
          cells: [
            ...series.map((sr) => {
              const v = pt.values[sr.id];
              return typeof v === "number" ? fmt(v) : "no data";
            }),
            ...channels.map((c) => {
              const raw = pt.meta?.[c.id];
              return raw === undefined ? "" : c.format ? c.format(raw) : typeof raw === "number" ? fmt(raw) : String(raw);
            }),
          ],
        }))}
      />
    </div>
  );
}
