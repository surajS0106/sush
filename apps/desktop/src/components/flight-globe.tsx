// A flight on the globe, for the trip's tile: the Earth zooms in on the route, a
// plane flies the great circle between the two cities with a trail behind it, and
// after one replay it rests at the destination (hovering flies it again). It's drawn
// on a canvas from maps in the bundle, so it needs no network, and it's loaded with
// the card only when there's a route to show (`flight-card.tsx`). The plane shows the
// route, not a real flight's position.
//
// This all runs on the UI thread, so it's built not to redraw the map: projecting the
// detailed map takes over 40 ms, more than two whole frames. It's painted once to a
// canvas that each frame copies, the camera stays still during the flight, and the
// route's points are worked out once. Only the zoom moves the map, using the simplest
// map, without borders, at 30 fps. Nothing runs off screen, at rest or with reduced motion.

import { geoDistance, geoInterpolate, geoOrthographic, geoPath, type GeoPermissibleObjects, type GeoProjection } from "d3-geo";
import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import coarseAtlas from "world-atlas/countries-110m.json";

import type { GeoPoint } from "@/lib/tauri";

type World = Topology<{ land: GeometryCollection; countries: GeometryCollection }>;
type Point = { x: number; y: number };

const SPHERE: GeoPermissibleObjects = { type: "Sphere" };

function decode(atlas: unknown) {
  const world = atlas as World;
  return {
    land: feature(world, world.objects.land) as GeoPermissibleObjects,
    borders: mesh(world, world.objects.countries, (a, b) => a !== b) as GeoPermissibleObjects,
  };
}

type WorldMap = ReturnType<typeof decode>;

const COARSE = decode(coarseAtlas);

let detailed: Promise<WorldMap> | null = null;
/** Coastlines fine enough for a close-up. Long routes stay zoomed out and never load them. */
const loadDetailed = () => (detailed ??= import("world-atlas/countries-50m.json").then((m) => decode(m.default)));

const INTRO_MS = 1800;
const INTRO_FRAME_MS = 33;
const FLIGHT_MS = 5500;
const HOLD_MS = 3500;
/** Fades out for this long before a replay, so starting again doesn't jump. */
const FADE_MS = 350;
const PLAYS = 2;
/** How far along the route the plane is drawn when it can't move. */
const STILL_AT = 0.72;
const ROUTE_SAMPLES = 96;
/** Zoomed in further than this, the coarse map's coastlines look too rough. */
const DETAIL_FROM_ZOOM = 2.5;
const MAX_PIXEL_RATIO = 2;

const PLANE = new Path2D(
  "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
);

const LIGHT = { sea: "#dbe9f4", land: "#f8fafc", border: "#cbd5e1", route: "#0284c7", ahead: "#64748b", plane: "#0f172a", halo: "#ffffff", text: "#0f172a" };
const DARK = { sea: "#0f1f30", land: "#2c3e52", border: "#415469", route: "#38bdf8", ahead: "#94a3b8", plane: "#ffffff", halo: "#0f172a", text: "#f8fafc" };
type Colors = typeof LIGHT;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const ease = (t: number) => (1 - Math.cos(Math.PI * clamp(t, 0, 1))) / 2;
const isDark = () => document.documentElement.classList.contains("dark");

export interface GlobeStop {
  point: GeoPoint;
  name: string;
}

function projectionOf(width: number, height: number, center: [number, number], radius: number) {
  return geoOrthographic()
    .translate([width / 2, height / 2])
    .scale(radius)
    .rotate([-center[0], -center[1]])
    .clipAngle(90)
    .clipExtent([
      [0, 0],
      [width, height],
    ])
    .precision(0.4);
}

function paintMap(ctx: CanvasRenderingContext2D, projection: GeoProjection, map: WorldMap, colors: Colors, borders: boolean) {
  const path = geoPath(projection, ctx);
  ctx.beginPath();
  path(SPHERE);
  ctx.fillStyle = colors.sea;
  ctx.fill();
  ctx.beginPath();
  path(map.land);
  ctx.fillStyle = colors.land;
  ctx.fill();
  if (!borders) return;
  ctx.beginPath();
  path(map.borders);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 0.75;
  ctx.stroke();
}

/** What stays the same throughout a flight, worked out once. */
function planFlight(width: number, height: number, from: GlobeStop, to: GlobeStop) {
  const start: [number, number] = [from.point.longitude, from.point.latitude];
  const end: [number, number] = [to.point.longitude, to.point.latitude];
  const route = geoInterpolate(start, end);
  const center = route(0.5);
  const wholeGlobe = height * 0.46;
  // A route takes up about 40% of the width. Close to home that needs a big zoom, up to a limit.
  const radius = clamp((0.2 * width) / Math.max(Math.sin(geoDistance(start, end) / 2), 0.001), wholeGlobe, height * 6);
  const projection = projectionOf(width, height, center, radius);
  const visible = (point: [number, number]) => {
    const at = geoDistance(point, center) < Math.PI / 2 ? projection(point) : null;
    return at ? { x: at[0], y: at[1] } : null;
  };
  const startAt = visible(start);
  const endAt = visible(end);
  const chord = startAt && endAt ? Math.hypot(endAt.x - startAt.x, endAt.y - startAt.y) : 0;
  // The route bows a little off the ground, the way a flight path looks on a map.
  const lift = Math.min(chord * 0.16, height * 0.18);
  const points = Array.from({ length: ROUTE_SAMPLES + 1 }, (_, i) => {
    const t = i / ROUTE_SAMPLES;
    const at = visible(route(t));
    return at && { x: at.x, y: at.y - lift * Math.sin(Math.PI * t) };
  });
  return { center, radius, wholeGlobe, projection, points, startAt, endAt };
}

type Plan = ReturnType<typeof planFlight>;

function strokeRoute(ctx: CanvasRenderingContext2D, points: (Point | null)[], color: string, lineWidth: number, dash: number[]) {
  ctx.beginPath();
  let drawing = false;
  for (const at of points) {
    if (!at) {
      drawing = false;
      continue;
    }
    if (drawing) ctx.lineTo(at.x, at.y);
    else ctx.moveTo(at.x, at.y);
    drawing = true;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

function paintStop(ctx: CanvasRenderingContext2D, at: Point | null, name: string, width: number, colors: Colors) {
  if (!at) return;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = colors.halo;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(at.x, at.y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = colors.route;
  ctx.fill();
  ctx.font = '500 12px "Geist Variable", sans-serif';
  ctx.textBaseline = "middle";
  const right = at.x > width - 90;
  ctx.textAlign = right ? "right" : "left";
  const x = at.x + (right ? -9 : 9);
  ctx.strokeStyle = colors.halo;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeText(name, x, at.y);
  ctx.fillStyle = colors.text;
  ctx.fillText(name, x, at.y);
}

/** The route, the two cities and the plane `progress` of the way along. */
function paintFlight(ctx: CanvasRenderingContext2D, plan: Plan, progress: number, from: GlobeStop, to: GlobeStop, width: number, colors: Colors) {
  const { points } = plan;
  const position = clamp(progress, 0, 1) * ROUTE_SAMPLES;
  const index = Math.min(Math.floor(position), ROUTE_SAMPLES - 1);
  const a = points[index];
  const b = points[index + 1];
  const plane = a && b ? { x: a.x + (b.x - a.x) * (position - index), y: a.y + (b.y - a.y) * (position - index) } : (a ?? b);

  if (progress < 1) strokeRoute(ctx, [plane, ...points.slice(index + 1)], colors.ahead, 1.25, [3, 4]);
  if (progress > 0) strokeRoute(ctx, [...points.slice(0, index + 1), plane], colors.route, 2, []);
  paintStop(ctx, plan.startAt, from.name, width, colors);
  paintStop(ctx, plan.endAt, to.name, width, colors);
  if (!plane) return;

  const heading = a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  ctx.save();
  ctx.translate(plane.x, plane.y);
  // The icon's nose points up and to the right.
  ctx.rotate(heading + Math.PI / 4);
  ctx.scale(1.1, 1.1);
  ctx.translate(-12, -12);
  ctx.strokeStyle = colors.halo;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke(PLANE);
  ctx.fillStyle = colors.plane;
  ctx.fill(PLANE);
  ctx.restore();
}

type Stage = "intro" | "flight" | "hold" | "rest";

export function FlightGlobe({ from, to }: { from: GlobeStop; to: GlobeStop }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const inView = useInView(canvas);
  const reduced = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dark, setDark] = useState(isDark);
  const [detail, setDetail] = useState<WorldMap | null>(null);
  // Where the animation is, so a resize or going off screen carries on from there.
  const timeline = useRef<{ stage: Stage; t: number; plays: number }>({ stage: "intro", t: 0, plays: PLAYS });
  const replay = useRef<() => void>(() => {});
  const setOnScreen = useRef<(on: boolean) => void>(() => {});
  const onScreen = useRef(inView);
  onScreen.current = inView;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The map is only repainted when the theme actually changes.
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    const { width, height } = size;
    if (!element || !ctx || width === 0 || height === 0) return;

    const scale = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    element.width = Math.round(width * scale);
    element.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const colors = dark ? DARK : LIGHT;
    const plan = planFlight(width, height, from, to);
    const close = plan.radius / plan.wholeGlobe >= DETAIL_FROM_ZOOM;

    const base = document.createElement("canvas");
    base.width = element.width;
    base.height = element.height;
    const baseCtx = base.getContext("2d");
    if (!baseCtx) return;
    baseCtx.setTransform(scale, 0, 0, scale, 0, 0);
    paintMap(baseCtx, plan.projection, close && detail ? detail : COARSE, colors, true);

    let cancelled = false;
    if (close && !detail) {
      void loadDetailed().then((map) => {
        if (!cancelled) setDetail(map);
      });
    }

    const away: [number, number] = [plan.center[0] - 70, plan.center[1] * 0.3];
    const toCenter = geoInterpolate(away, plan.center);
    const paintIntro = (t: number) => {
      const intro = ease(t / INTRO_MS);
      const radius = plan.wholeGlobe * (plan.radius / plan.wholeGlobe) ** intro;
      ctx.clearRect(0, 0, width, height);
      paintMap(ctx, projectionOf(width, height, toCenter(intro), radius), COARSE, colors, false);
    };
    const paintAt = (progress: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(base, 0, 0, width, height);
      paintFlight(ctx, plan, progress, from, to, width, colors);
    };

    const state = timeline.current;
    let frame = 0;
    let running = false;

    const start = () => {
      if (running || reduced) return;
      running = true;
      let last = performance.now();
      let lastIntroPaint = 0;
      const tick = (now: number) => {
        state.t += now - last;
        last = now;
        if (state.stage === "intro") {
          if (state.t >= INTRO_MS) {
            state.stage = "flight";
            state.t = 0;
          } else if (now - lastIntroPaint >= INTRO_FRAME_MS) {
            paintIntro(state.t);
            lastIntroPaint = now;
          }
        } else if (state.stage === "flight") {
          const landed = state.t >= FLIGHT_MS;
          paintAt(landed ? 1 : ease(state.t / FLIGHT_MS));
          if (landed) {
            state.t = 0;
            state.stage = state.plays > 1 ? "hold" : "rest";
            if (state.stage === "rest") {
              running = false;
              return;
            }
          }
        } else if (state.stage === "hold") {
          // The picture doesn't change here, so nothing is painted.
          if (state.t >= HOLD_MS) {
            state.plays -= 1;
            state.stage = "flight";
            state.t = 0;
            element.style.opacity = "1";
          } else if (state.t >= HOLD_MS - FADE_MS) {
            element.style.opacity = "0";
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    if (reduced) {
      element.style.opacity = "1";
      paintAt(STILL_AT);
    } else if (state.stage === "intro") {
      paintIntro(state.t);
    } else {
      paintAt(state.stage === "flight" ? ease(state.t / FLIGHT_MS) : 1);
    }
    setOnScreen.current = (on) => {
      if (on && state.stage !== "rest") {
        start();
      } else if (!on) {
        cancelAnimationFrame(frame);
        running = false;
      }
    };
    setOnScreen.current(onScreen.current);

    replay.current = () => {
      if (state.stage !== "rest" || reduced) return;
      state.stage = "flight";
      state.t = 0;
      state.plays = 1;
      start();
    };

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      replay.current = () => {};
      setOnScreen.current = () => {};
      // Let go of the copy's memory now rather than whenever it's collected.
      base.width = 0;
      base.height = 0;
    };
  }, [size, dark, detail, reduced, from.point.latitude, from.point.longitude, from.name, to.point.latitude, to.point.longitude, to.name]);

  // Scrolling past only pauses and resumes: it mustn't repaint the map.
  useEffect(() => setOnScreen.current(inView), [inView]);

  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={`A plane flying a route on the globe from ${from.name} to ${to.name}`}
      className="block size-full transition-opacity duration-300"
      onPointerEnter={() => replay.current()}
    />
  );
}
