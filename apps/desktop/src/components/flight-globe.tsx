// A flight on the globe, for the trip's tile: the Earth turns to the origin and closes
// in, then the camera follows the plane along the great circle, pulling back as far as
// the route needs and pushing in on the destination, where it rests (hovering flies it
// again). A flight with stops lands at each, so the leg-by-leg route is plain, and a
// change of route flies the new one from the start. The Earth is a satellite photo
// (`lib/earth-imagery.ts`) with borders and the route drawn over it on a canvas, all from
// the bundle, so it needs no network, and it's loaded with the card only when there's a
// route to show (`flight-card.tsx`). The legs are great circles between the airports:
// the plane shows the route, not a real flight's position or track.
//
// This all runs on the UI thread, so a moving camera only ever draws the simplest borders.
// The detailed ones are painted once, after landing, while the camera is still, and fade
// in over the simple ones. If the photo can't be shown, the land is drawn from the same
// maps. Nothing runs off screen, at rest or with reduced motion.

import { geoCentroid, geoDistance, geoInterpolate, geoOrthographic, geoPath, type GeoPath, type GeoPermissibleObjects, type GeoProjection } from "d3-geo";
import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import coarseAtlas from "world-atlas/countries-110m.json";

import { acquireEarth, releaseEarth, type Earth } from "@/lib/earth-imagery";
import type { GeoPoint } from "@/lib/tauri";
import { useTemperatureUnit } from "@/lib/weather";

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
const FLIGHT_MS = 7000;
/** The time in the air grows by this for each stop, so short legs aren't rushed. */
const EXTRA_LEG_MS = 2500;
/** The plane sits on the ground at a stop for this long. */
const STOP_MS = 700;
/** The detailed map fades in and the landing ring spreads for this long. */
const SETTLE_MS = 600;
const HOLD_MS = 3500;
/** Fades out for this long before a replay, so starting again doesn't jump. */
const FADE_MS = 350;
const PLAYS = 2;
/** Caps painting at about 60 fps on faster screens. */
const FRAME_MS = 14;
/** How far along the route the plane is drawn when it can't move. */
const STILL_AT = 0.72;
const ROUTE_SAMPLES = 96;
/** Zoomed in further than this, the coarse map's coastlines look too rough. */
const DETAIL_FROM_ZOOM = 2.5;
const MAX_PIXEL_RATIO = 2;

const PLANE = new Path2D(
  "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
);

const EARTH_RADIUS_KM = 6371;
const MILES_PER_KM = 0.621371;

type Rgb = [number, number, number];

/** The accent as figures to mix: a canvas can't read a CSS variable, and not every webview has `color-mix`. */
function rgbOf(color: string): Rgb {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d");
  if (!ctx) return [128, 128, 128];
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/**
 * The picture's colors: the route in the user's accent over the Earth as it looks from
 * space, the same in both themes. A light edge keeps a dark accent readable on the night-dark sea.
 */
function paletteOf(accent: string) {
  const brand = rgbOf(accent);
  const css = ([r, g, b]: Rgb, alpha = 1) => `rgb(${r} ${g} ${b} / ${alpha})`;
  return {
    route: css(brand),
    glow: css(brand, 0.35),
    edge: "rgb(255 255 255 / 0.9)",
    // The drawn map, for when the photo can't be shown.
    sea: "#0e2a4d",
    land: "#44603f",
    air: "rgb(92 153 255 / 0.5)",
    airClear: "rgb(92 153 255 / 0)",
    limb: "rgb(4 10 24 / 0.5)",
    limbClear: "rgb(4 10 24 / 0)",
    border: "rgb(255 255 255 / 0.3)",
    ahead: "#e4eaec",
    plane: "#ffffff",
    halo: "#0c1014",
    text: "#f8fafa",
  };
}
type Colors = ReturnType<typeof paletteOf>;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const ease = (t: number) => (1 - Math.cos(Math.PI * clamp(t, 0, 1))) / 2;
const accentColor = () => getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();

export interface GlobeStop {
  point: GeoPoint;
  name: string;
}

function projectionOf(width: number, height: number, center: [number, number], radius: number, roll = 0) {
  return geoOrthographic()
    .translate([width / 2, height / 2])
    .scale(radius)
    .rotate([-center[0], -center[1], roll])
    .clipAngle(90)
    .clipExtent([
      [0, 0],
      [width, height],
    ])
    .precision(0.4);
}

function paintBorders(ctx: CanvasRenderingContext2D, path: GeoPath<any, GeoPermissibleObjects>, map: WorldMap, colors: Colors) {
  ctx.beginPath();
  path(map.borders);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 0.75;
  ctx.stroke();
}

function paintMap(ctx: CanvasRenderingContext2D, projection: GeoProjection, map: WorldMap, colors: Colors, earth: Earth | null) {
  const path = geoPath(projection, ctx);
  if (earth?.draw(ctx, projection)) {
    paintBorders(ctx, path, map, colors);
    return;
  }
  const radius = projection.scale();
  const [centerX, centerY] = projection.translate();
  // A soft atmosphere outside the Earth and a darker edge inside it, while the edge shows.
  const edgeShows = radius < Math.hypot(centerX, centerY);
  if (edgeShows) {
    const air = ctx.createRadialGradient(centerX, centerY, radius * 0.96, centerX, centerY, radius * 1.1);
    air.addColorStop(0, colors.air);
    air.addColorStop(1, colors.airClear);
    ctx.fillStyle = air;
    ctx.fillRect(0, 0, centerX * 2, centerY * 2);
  }
  ctx.beginPath();
  path(SPHERE);
  ctx.fillStyle = colors.sea;
  ctx.fill();
  ctx.beginPath();
  path(map.land);
  ctx.fillStyle = colors.land;
  ctx.fill();
  paintBorders(ctx, path, map, colors);
  if (!edgeShows) return;
  const edge = ctx.createRadialGradient(centerX, centerY, radius * 0.6, centerX, centerY, radius);
  edge.addColorStop(0, colors.limbClear);
  edge.addColorStop(1, colors.limb);
  ctx.beginPath();
  path(SPHERE);
  ctx.fillStyle = edge;
  ctx.fill();
}

/** Compass direction from one point to another, in degrees. */
function bearing(from: [number, number], to: [number, number]) {
  const [fromLng, fromLat, toLng, toLat] = [from[0], from[1], to[0], to[1]].map((degrees) => (degrees * Math.PI) / 180);
  const y = Math.sin(toLng - fromLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(toLng - fromLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** The zoom that fits points this far from the frame's center, whichever way they're turned. */
const zoomToFit = (height: number, reach: number) => clamp((0.4 * height) / Math.max(Math.sin(Math.min(reach, Math.PI / 2)), 0.001), height * 0.46, height * 5);

/** What stays the same throughout one leg, worked out once. */
function planLeg(start: [number, number], end: [number, number], peak: number, close: number) {
  const route = geoInterpolate(start, end);
  const halfChord = Math.sin(geoDistance(start, end) / 2);
  const radiusAt = (t: number) => close * (peak / close) ** (Math.sin(Math.PI * t) ** 2);

  // Ground covered per frame shrinks as the camera closes in, so the Earth crosses the
  // frame at an even speed: it pulls back first, travels, then pushes in.
  const travelled = [0];
  for (let i = 0; i < ROUTE_SAMPLES; i++) {
    const t = (i + 0.5) / ROUTE_SAMPLES;
    travelled.push(travelled[i] + Math.sin(Math.PI * t) / radiusAt(t));
  }
  const total = travelled[ROUTE_SAMPLES];
  const alongAt = (t: number) => {
    const position = clamp(t, 0, 1) * ROUTE_SAMPLES;
    const index = Math.min(Math.floor(position), ROUTE_SAMPLES - 1);
    return (travelled[index] + (travelled[index + 1] - travelled[index]) * (position - index)) / total;
  };

  // North is up at both ends. In between, the route's direction on screen turns steadily
  // from one end's to the other's, and the roll makes up the difference. Keeping north
  // up all the way would spin the Earth around the pole on a route that passes near it.
  const courseAt = (along: number) => bearing(route(along - 0.0005), route(along + 0.0005));
  const firstCourse = courseAt(0);
  const lastCourse = courseAt(1);
  const turn = ((lastCourse - firstCourse + 540) % 360) - 180;
  const eastward = (course: number) => Math.sin((course * Math.PI) / 180) >= 0;

  const cameraAt = (t: number) => {
    const along = alongAt(t);
    return { along, center: route(along), radius: radiusAt(t), roll: courseAt(along) - firstCourse - turn * ease(along) };
  };

  return {
    /** The great-circle distance. */
    km: geoDistance(start, end) * EARTH_RADIUS_KM,
    cameraAt,
    // Which side of its dot each city's name goes, clear of the route: behind the plane
    // leaving, ahead of it arriving. Picked once, so a name doesn't jump mid-flight.
    fromSide: eastward(firstCourse) ? -1 : 1,
    toSide: eastward(lastCourse) ? 1 : -1,
    track: Array.from({ length: ROUTE_SAMPLES + 1 }, (_, i) => route(i / ROUTE_SAMPLES)),
    // The route bows a little off the ground, the way a flight path looks on a map.
    lift: 0.12 * halfChord,
  };
}

/** A whole flight: its legs in turn, and where the plane and camera are at any moment. */
function planFlight(height: number, stops: GlobeStop[]) {
  const ends = stops.map((stop): [number, number] => [stop.point.longitude, stop.point.latitude]);
  const pairs = ends.slice(1).map((end, i) => [ends[i], end]);
  const peaks = pairs.map(([a, b]) => zoomToFit(height, geoDistance(a, b) / 2));
  // Every leg starts and ends at one zoom, north up, so the camera has no jump at a stop.
  const close = Math.max(height * 3.2, ...peaks.map((peak) => peak * 1.6));
  const legs = pairs.map(([a, b], i) => planLeg(a, b, peaks[i], close));
  const last = legs.length - 1;
  const km = legs.reduce((sum, leg) => sum + leg.km, 0);

  // A short leg gets less time than a long one, but not so much less that it's a blink.
  const airMs = FLIGHT_MS + EXTRA_LEG_MS * last;
  const weights = legs.map((leg) => Math.sqrt(leg.km));
  const weight = weights.reduce((sum, w) => sum + w, 0) || 1;
  const legMs = weights.map((w) => Math.max((airMs * w) / weight, 1));
  const flightMs = legMs.reduce((sum, ms) => sum + ms, 0) + STOP_MS * last;

  /** At `t` from 0 to 1 through the flight. `stopping` runs 0 to 1 while on the ground at the end of `leg`. */
  const momentAt = (t: number) => {
    let left = clamp(t, 0, 1) * flightMs;
    for (let leg = 0; leg < last; leg++) {
      if (left <= legMs[leg]) return { leg, stopping: null, ...legs[leg].cameraAt(left / legMs[leg]) };
      left -= legMs[leg];
      if (left < STOP_MS) return { leg, stopping: left / STOP_MS, ...legs[leg].cameraAt(1) };
      left -= STOP_MS;
    }
    return { leg: last, stopping: null, ...legs[last].cameraAt(left / legMs[last]) };
  };

  // Where the plane is drawn when it can't move: `STILL_AT` of the way, by distance.
  let stillLeg = 0;
  let stillKm = km * STILL_AT;
  while (stillLeg < last && stillKm > legs[stillLeg].km) stillKm -= legs[stillLeg++].km;
  const middle = legs.length === 1 ? geoInterpolate(ends[0], ends[1])(0.5) : geoCentroid({ type: "MultiPoint", coordinates: ends });

  return {
    start: ends[0],
    ends,
    legs,
    km,
    wholeGlobe: height * 0.46,
    flightMs,
    momentAt,
    /** How far is left at a moment. */
    kmLeft: (moment: Moment) => km - legs.slice(0, moment.leg).reduce((sum, leg) => sum + leg.km, 0) - legs[moment.leg].km * moment.along,
    /** The whole route at once, north up, for when nothing can move. */
    overview: {
      leg: stillLeg,
      stopping: null,
      along: legs[stillLeg].km > 0 ? stillKm / legs[stillLeg].km : 1,
      center: middle,
      radius: zoomToFit(height, Math.max(...ends.map((end) => geoDistance(end, middle)))),
      roll: 0,
    },
  };
}

type Plan = ReturnType<typeof planFlight>;
type Moment = { leg: number; stopping: number | null; along: number; center: [number, number]; radius: number; roll: number };

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

function paintStop(ctx: CanvasRenderingContext2D, at: Point | null, name: string, side: number, colors: Colors, gap: number, opacity: number) {
  if (!at || opacity === 0) return;
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = colors.edge;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(at.x, at.y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = colors.route;
  ctx.fill();
  ctx.font = '500 12px "Geist Variable", sans-serif';
  ctx.textBaseline = "middle";
  ctx.textAlign = side < 0 ? "right" : "left";
  const x = at.x + side * gap;
  ctx.strokeStyle = colors.halo;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeText(name, x, at.y);
  ctx.fillStyle = colors.text;
  ctx.fillText(name, x, at.y);
  ctx.restore();
}

/** The route, its cities and the plane at this moment, as the camera sees them. */
function paintFlight(ctx: CanvasRenderingContext2D, plan: Plan, moment: Moment, projection: GeoProjection, stops: GlobeStop[], width: number, height: number, colors: Colors) {
  const [centerX, centerY] = [width / 2, height / 2];
  const tracks = plan.legs.map((leg) =>
    leg.track.map((point, i) => {
      if (geoDistance(point, moment.center) >= Math.PI / 2) return null;
      const at = projection(point);
      const lifted = 1 + leg.lift * Math.sin((Math.PI * i) / ROUTE_SAMPLES);
      return at && { x: centerX + (at[0] - centerX) * lifted, y: centerY + (at[1] - centerY) * lifted };
    }),
  );
  const progress = clamp(moment.along, 0, 1);
  const position = progress * ROUTE_SAMPLES;
  const index = Math.min(Math.floor(position), ROUTE_SAMPLES - 1);
  const a = tracks[moment.leg][index];
  const b = tracks[moment.leg][index + 1];
  const plane = a && b ? { x: a.x + (b.x - a.x) * (position - index), y: a.y + (b.y - a.y) * (position - index) } : (a ?? b);

  tracks.forEach((points, leg) => {
    const flying = leg === moment.leg;
    if (leg > moment.leg || (flying && progress < 1)) strokeRoute(ctx, flying ? [plane, ...points.slice(index + 1)] : points, colors.ahead, 1.25, [3, 4]);
    if (leg < moment.leg || (flying && progress > 0)) {
      const flown = flying ? [...points.slice(0, index + 1), plane] : points;
      strokeRoute(ctx, flown, colors.glow, 6, []);
      strokeRoute(ctx, flown, colors.edge, 3.5, []);
      strokeRoute(ctx, flown, colors.route, 2, []);
    }
  });

  // A city's name moves clear of the plane sitting on it, and fades at the Earth's edge
  // rather than vanishing there.
  const gapFrom = (at: Point | null) => 9 + (plane && at ? 12 * clamp(1 - Math.hypot(plane.x - at.x, plane.y - at.y) / 24, 0, 1) : 0);
  const opacityAt = (point: [number, number]) => clamp(Math.cos(geoDistance(point, moment.center)) / 0.1, 0, 1);
  stops.forEach((stop, i) => {
    const at = i === 0 ? tracks[0][0] : tracks[i - 1][ROUTE_SAMPLES];
    const side = i === 0 ? plan.legs[0].fromSide : plan.legs[i - 1].toSide;
    paintStop(ctx, at, stop.name, side, colors, gapFrom(at), opacityAt(plan.ends[i]));
  });
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

/** The flight's distance in the corner, like a seat-back map's. */
function paintReadout(ctx: CanvasRenderingContext2D, text: string, width: number, height: number, colors: Colors) {
  ctx.font = '500 12px "Geist Variable", sans-serif';
  ctx.textBaseline = "alphabetic";
  // Right-aligned, so the figures changing don't move the words.
  ctx.textAlign = "right";
  ctx.strokeStyle = colors.halo;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeText(text, width - 16, height - 16);
  ctx.fillStyle = colors.text;
  ctx.fillText(text, width - 16, height - 16);
}

/** A ring spreading from the frame's center, where the camera has the plane as it lands. */
function paintRing(ctx: CanvasRenderingContext2D, spread: number, width: number, height: number, colors: Colors) {
  ctx.save();
  ctx.globalAlpha *= 1 - spread;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, 8 + spread * 32, 0, Math.PI * 2);
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

type Stage = "intro" | "flight" | "settle" | "hold" | "rest";

export function FlightGlobe({ from, via = [], to }: { from: GlobeStop; via?: GlobeStop[]; to: GlobeStop }) {
  const stops = [from, ...via, to];
  const routeKey = stops.map((stop) => `${stop.name}:${stop.point.latitude},${stop.point.longitude}`).join("|");
  const flownRoute = useRef(routeKey);
  const canvas = useRef<HTMLCanvasElement>(null);
  const inView = useInView(canvas);
  const reduced = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [accent, setAccent] = useState(accentColor);
  const [detail, setDetail] = useState<WorldMap | null>(null);
  // Undefined while the photo loads, null if it can't be shown.
  const [earth, setEarth] = useState<Earth | null>();
  // Someone who reads Fahrenheit usually reads miles too.
  const imperial = useTemperatureUnit() === "f";
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

  useEffect(() => {
    let mounted = true;
    void acquireEarth().then((loaded) => {
      if (mounted) setEarth(loaded);
    });
    return () => {
      mounted = false;
      releaseEarth();
    };
  }, []);

  // The map is only repainted when the accent actually changes.
  useEffect(() => {
    const observer = new MutationObserver(() => setAccent(accentColor()));
    // The accent differs by theme, and a custom one's color is set in `style` (`lib/appearance.ts`).
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    const { width, height } = size;
    // Waiting for the photo keeps the first frames, and the flight, from starting without it.
    if (!element || !ctx || width === 0 || height === 0 || earth === undefined) return;

    const scale = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    element.width = Math.round(width * scale);
    element.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const colors = paletteOf(accent);
    const plan = planFlight(height, stops);
    const projectionFor = (camera: Moment) => projectionOf(width, height, camera.center, camera.radius, camera.roll);
    const closeOverview = plan.overview.radius / plan.wholeGlobe >= DETAIL_FROM_ZOOM;
    const distance = (km: number) => `${(Math.round((imperial ? km * MILES_PER_KM : km) / 10) * 10).toLocaleString()} ${imperial ? "mi" : "km"}`;

    // Decoded before the camera moves, so it can't interrupt the flight.
    let cancelled = false;
    if (!detail && (!reduced || closeOverview)) {
      void loadDetailed().then((map) => {
        if (!cancelled) setDetail(map);
      });
    }

    const firstCamera = plan.momentAt(0);
    const away: [number, number] = [plan.start[0] - 70, plan.start[1] * 0.3];
    const toStart = geoInterpolate(away, plan.start);
    const paintIntro = (t: number) => {
      const intro = ease(t / INTRO_MS);
      const radius = plan.wholeGlobe * (firstCamera.radius / plan.wholeGlobe) ** intro;
      ctx.clearRect(0, 0, width, height);
      paintMap(ctx, projectionOf(width, height, toStart(intro), radius), COARSE, colors, earth);
    };
    const paintMoving = (t: number) => {
      const moment = plan.momentAt(t);
      const projection = projectionFor(moment);
      ctx.clearRect(0, 0, width, height);
      paintMap(ctx, projection, COARSE, colors, earth);
      // The route and the cities come in as the camera sets off, not all at once.
      ctx.globalAlpha = clamp(t / 0.04, 0, 1);
      if (moment.stopping !== null) paintRing(ctx, moment.stopping, width, height, colors);
      paintFlight(ctx, plan, moment, projection, stops, width, height, colors);
      paintReadout(ctx, moment.stopping !== null ? `Stop in ${stops[moment.leg + 1].name}` : `${distance(plan.kmLeft(moment))} to go`, width, height, colors);
      ctx.globalAlpha = 1;
    };

    // Painting the detailed map is slow, so it's done once, and only when the camera is still.
    let landedMap: HTMLCanvasElement | null = null;
    const lastCamera = plan.momentAt(1);
    const lastProjection = projectionFor(lastCamera);
    const paintLanded = (sharpness: number) => {
      if (!landedMap && detail) {
        landedMap = document.createElement("canvas");
        landedMap.width = element.width;
        landedMap.height = element.height;
        const landedCtx = landedMap.getContext("2d");
        landedCtx?.setTransform(scale, 0, 0, scale, 0, 0);
        if (landedCtx) paintMap(landedCtx, lastProjection, detail, colors, earth);
      }
      ctx.clearRect(0, 0, width, height);
      if (!landedMap || sharpness < 1) paintMap(ctx, lastProjection, COARSE, colors, earth);
      if (landedMap) {
        ctx.globalAlpha = sharpness;
        ctx.drawImage(landedMap, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }
      if (sharpness < 1) paintRing(ctx, sharpness, width, height, colors);
      paintFlight(ctx, plan, lastCamera, lastProjection, stops, width, height, colors);
      paintReadout(ctx, `${distance(plan.km)} flown`, width, height, colors);
    };
    const paintStill = () => {
      const projection = projectionFor(plan.overview);
      ctx.clearRect(0, 0, width, height);
      paintMap(ctx, projection, closeOverview && detail ? detail : COARSE, colors, earth);
      paintFlight(ctx, plan, plan.overview, projection, stops, width, height, colors);
      paintReadout(ctx, distance(plan.km), width, height, colors);
    };

    // A different flight was picked: fly it from the start, fading in over the old picture's cut.
    if (flownRoute.current !== routeKey) {
      flownRoute.current = routeKey;
      timeline.current = { stage: "flight", t: 0, plays: PLAYS };
      element.style.transition = "none";
      element.style.opacity = "0";
      void element.offsetWidth;
      element.style.transition = "";
      element.style.opacity = "1";
    }

    const state = timeline.current;
    let frame = 0;
    let running = false;

    const start = () => {
      if (running || reduced) return;
      running = true;
      let last = performance.now();
      let lastPaint = 0;
      const tick = (now: number) => {
        state.t += now - last;
        last = now;
        const due = now - lastPaint >= FRAME_MS;
        if (due) lastPaint = now;
        if (state.stage === "intro") {
          if (state.t >= INTRO_MS) {
            state.stage = "flight";
            state.t = 0;
          } else if (due) {
            paintIntro(state.t);
          }
        } else if (state.stage === "flight") {
          if (state.t >= plan.flightMs) {
            state.stage = "settle";
            state.t = 0;
            paintLanded(0);
          } else if (due) {
            paintMoving(state.t / plan.flightMs);
          }
        } else if (state.stage === "settle") {
          const settled = state.t >= SETTLE_MS;
          if (settled || due) paintLanded(ease(state.t / SETTLE_MS));
          if (settled) {
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
      paintStill();
    } else if (state.stage === "intro") {
      paintIntro(state.t);
    } else if (state.stage === "flight") {
      paintMoving(state.t / plan.flightMs);
    } else {
      paintLanded(state.stage === "settle" ? ease(state.t / SETTLE_MS) : 1);
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
      // The camera is at the destination, so fade out on the way back to the origin.
      state.stage = "hold";
      state.t = HOLD_MS - FADE_MS;
      state.plays = 2;
      start();
    };

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      replay.current = () => {};
      setOnScreen.current = () => {};
      // Let go of the copy's memory now rather than whenever it's collected.
      if (landedMap) {
        landedMap.width = 0;
        landedMap.height = 0;
      }
    };
  }, [size, accent, detail, earth, reduced, imperial, routeKey]);

  // Scrolling past only pauses and resumes: it mustn't repaint the map.
  useEffect(() => setOnScreen.current(inView), [inView]);

  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={`A plane flying a route on the globe from ${from.name}${via.length > 0 ? ` via ${via.map((stop) => stop.name).join(", ")}` : ""} to ${to.name}`}
      className="block size-full transition-opacity duration-300"
      onPointerEnter={() => replay.current()}
    />
  );
}
