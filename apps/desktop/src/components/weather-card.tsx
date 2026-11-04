// The `weather_show` card: a little pixel world with the weather in it, light or dark
// by the time of day at the place, not by the app's theme. The numbers
// and words are bitmap type drawn in the same pixels as Sushi, who lives in the scene:
// under an umbrella in the rain, in a hat in the snow, and asleep at night. Awake, it's
// the real mascot, so its eyes follow the pointer and it answers a click.

import { openUrl } from "@tauri-apps/plugin-opener";
import { MaximizeIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { Mascot, MascotSprite } from "@/components/mascot";
import { Segmented } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useMascot } from "@/lib/mascot";
import { cn } from "@/lib/utils";
import type { Phase } from "@/lib/tauri";
import { clockTime, degrees, setTemperatureUnit, TEMPERATURE_UNITS, temperatureGradient, useTemperatureUnit, windSpeed, type TemperatureUnit, type WeatherOutput } from "@/lib/weather";
import { createScene, isLightPhase, SCENE_GROUND, SCENE_SIZE, skyFor, type Sky } from "@/lib/weather-scene";

const RICE = "#fff8ee";
/** The card sets `--type-shadow` to suit its scene. */
const TYPE_SHADOW = "[filter:drop-shadow(0_1px_0_var(--type-shadow))]";

// A bitmap face, seven rows high with two more for descenders. "/" ends a row.
const GLYPHS: Record<string, string> = {
  "0": ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  "1": "..#../.##../..#../..#../..#../..#../.###.",
  "2": ".###./#...#/....#/...#./..#../.#.../#####",
  "3": "#####/...#./..#../...#./....#/#...#/.###.",
  "4": "...#./..##./.#.#./#..#./#####/...#./...#.",
  "5": "#####/#..../####./....#/....#/#...#/.###.",
  "6": "..##./.#.../#..../####./#...#/#...#/.###.",
  "7": "#####/....#/...#./..#../.#.../.#.../.#...",
  "8": ".###./#...#/#...#/.###./#...#/#...#/.###.",
  "9": ".###./#...#/#...#/.####/....#/...#./.##..",
  "°": "###/#.#/###/.../.../.../...",
  "-": "..../..../..../####/..../..../....",
  ":": "././#/./#/./.",
  "%": "##..#/##.#./...#./..#../.#.../.#.##/#..##",
  "/": "....#/....#/...#./..#../.#.../#..../#....",
  ".": "././././././#",
  ",": "../../../../../.#/#.",
  "'": "#/#/./././.",
  " ": "../../../../../../..",
  A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
  B: "####./#...#/#...#/####./#...#/#...#/####.",
  C: ".###./#...#/#..../#..../#..../#...#/.###.",
  D: "####./#...#/#...#/#...#/#...#/#...#/####.",
  E: "#####/#..../#..../####./#..../#..../#####",
  F: "#####/#..../#..../####./#..../#..../#....",
  G: ".###./#...#/#..../#.###/#...#/#...#/.###.",
  H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
  I: "###/.#./.#./.#./.#./.#./###",
  J: "..###/...#./...#./...#./...#./#..#./.##..",
  K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
  L: "#..../#..../#..../#..../#..../#..../#####",
  M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#",
  N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
  O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  P: "####./#...#/#...#/####./#..../#..../#....",
  Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
  R: "####./#...#/#...#/####./#.#../#..#./#...#",
  S: ".####/#..../#..../.###./....#/....#/####.",
  T: "#####/..#../..#../..#../..#../..#../..#..",
  U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
  V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
  W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
  X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
  Z: "#####/....#/...#./..#../.#.../#..../#####",
  a: "...../...../.###./....#/.####/#...#/.####",
  b: "#..../#..../####./#...#/#...#/#...#/####.",
  c: "...../...../.###./#..../#..../#...#/.###.",
  d: "....#/....#/.####/#...#/#...#/#...#/.####",
  e: "...../...../.###./#...#/#####/#..../.###.",
  f: "..##/.#../####/.#../.#../.#../.#..",
  g: "...../...../.####/#...#/#...#/.####/....#/....#/####.",
  h: "#..../#..../####./#...#/#...#/#...#/#...#",
  i: "#/./#/#/#/#/#",
  j: "..#/.../..#/..#/..#/..#/..#/..#/##.",
  k: "#.../#.../#..#/#.#./##../#.#./#..#",
  l: "##./.#./.#./.#./.#./.#./###",
  m: "...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#",
  n: "...../...../####./#...#/#...#/#...#/#...#",
  o: "...../...../.###./#...#/#...#/#...#/.###.",
  p: "...../...../####./#...#/#...#/#...#/####./#..../#....",
  q: "...../...../.####/#...#/#...#/#...#/.####/....#/....#",
  r: "..../..../#.##/##../#.../#.../#...",
  s: "...../...../.####/#..../.###./....#/####.",
  t: ".#../.#../####/.#../.#../.#../..##",
  u: "...../...../#...#/#...#/#...#/#...#/.####",
  v: "...../...../#...#/#...#/#...#/.#.#./..#..",
  w: "...../...../#...#/#...#/#.#.#/#.#.#/.#.#.",
  x: "...../...../#...#/.#.#./..#../.#.#./#...#",
  y: "...../...../#...#/#...#/#...#/.####/....#/....#/####.",
  z: "...../...../#####/...#./..#../.#.../#####",
};

/** A stable pseudo-random 0–1 per pixel, so the dissolve looks scattered but never reshuffles. */
const scatter = (x: number, y: number) => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;

/**
 * Bitmap text. `rows` leaves room for descenders, so words of a size share a baseline.
 * `px` must be a whole number: at a fraction, rows and columns snap to different
 * thicknesses depending on where they land, and strokes look shaved off.
 */
function PixelText({ text, px, rows = 7, dissolve }: { text: string; px: number; rows?: number; dissolve?: number }) {
  const rects: { x: number; y: number }[] = [];
  let x = 0;
  for (const ch of text) {
    const glyph = GLYPHS[ch]?.split("/");
    if (!glyph) continue;
    glyph.forEach((row, y) => [...row].forEach((c, dx) => c === "#" && rects.push({ x: x + dx, y })));
    x += glyph[0].length + 1;
  }
  const width = Math.max(x - 1, 1);
  return (
    <svg
      aria-hidden
      data-weather-pixels
      viewBox={`0 0 ${width} ${rows}`}
      width={width * px}
      height={rows * px}
      shapeRendering="crispEdges"
      className={`block shrink-0 ${TYPE_SHADOW}`}
    >
      {rects.map((r) => (
        <rect
          key={`${r.x},${r.y}`}
          x={r.x}
          y={r.y}
          width={1.02}
          height={1.02}
          fill="currentColor"
          style={dissolve ? { animation: `pixel-in 260ms ease-out ${Math.round(scatter(r.x, r.y) * dissolve)}ms backwards` } : undefined}
        />
      ))}
    </svg>
  );
}

/** Can this be set in the bitmap face, at a width that fits the card? */
const fitsPixels = (text: string) => text.length <= 22 && [...text].every((ch) => GLYPHS[ch]);

// The condition's icon, in the same pixels as the words.
const CLOUD = ["......###....", "....#######..", "...#########.", ".############", "#############", "#############"];
const ICONS: Record<Sky | "moon", string[]> = {
  clear: [".....#.....", ".#.......#.", "...#####...", "..#######..", "..#######..", "#.#######.#", "..#######..", "..#######..", "...#####...", ".#.......#.", ".....#....."],
  moon: ["....####...", "..####.....", ".####......", ".####......", "#####......", "#####......", "#####.....#", ".######..##", ".#########.", "..#######..", "....###...."],
  partly: ["#.#.#........", ".###.........", "#####.####...", ".###.#######.", "#.#.#########", "...##########", "..###########", "..###########", "...#########."],
  cloudy: ["", "", ...CLOUD, ".###########."],
  fog: ["", "#############", "", "..#########..", "", "#############", "", "..#########..", "", "#############"],
  drizzle: [...CLOUD, ".###########.", "", "...#.....#...", "", "......#......"],
  rain: [...CLOUD, ".###########.", "", "..#..#..#..#.", ".#..#..#..#..", "#..#..#..#..."],
  snow: [...CLOUD, ".###########.", "", "..#...#...#..", "", "#...#...#...#"],
  storm: [...CLOUD, ".###.....###.", ".......##....", "......##.....", ".....####....", ".......#.....", "......#......"],
};

function SkyIcon({ rows }: { rows: string[] }) {
  const width = Math.max(...rows.map((r) => r.length));
  return (
    <svg aria-hidden viewBox={`0 0 ${width} ${rows.length}`} width={width * 2} height={rows.length * 2} shapeRendering="crispEdges" className={`shrink-0 ${TYPE_SHADOW}`}>
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === "#" ? <rect key={`${x},${y}`} x={x} y={y} width={1.02} height={1.02} fill="currentColor" /> : null)))}
    </svg>
  );
}

const CLEAR_WORDS: Record<Phase, string> = { day: "Sunny", night: "Tranquil", dawn: "Dawn", dusk: "Dusk" };

const WORDS: Record<Sky, string> = {
  clear: "Sunny",
  partly: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Foggy",
  drizzle: "Drizzly",
  rain: "Rainy",
  snow: "Snowy",
  storm: "Storm",
};

/**
 * The canvas redraws constantly, and WebKit can composite it over siblings that have no
 * layer of their own. So the scene is `z-0`, and what sits on it is `z-10` on its own layer.
 */
function Scene({ sky, phase }: { sky: Sky; phase: Phase }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const draw = createScene(sky, phase);
    draw(ctx, 0);
    if (reduce) return;
    // Old chats can hold many of these, so only the ones on screen keep moving.
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
    observer.observe(el);
    let frame = 0;
    const timer = setInterval(() => {
      if (visible && !document.hidden) draw(ctx, ++frame);
    }, 125);
    return () => {
      clearInterval(timer);
      observer.disconnect();
    };
  }, [sky, phase, reduce]);
  return <canvas ref={canvas} aria-hidden width={SCENE_SIZE} height={SCENE_SIZE} className="absolute inset-0 z-0 size-full" style={{ imageRendering: "pixelated" }} />;
}

const SPRITE_COLORS: Record<string, string> = { S: "#e94a35", s: "#ff8f73", K: "#e3d1b8", T: "#2f9c92", t: "#0f5e5c", R: RICE, Z: "currentColor" };

function Sprite({ rows, px = 2.5 }: { rows: string[]; px?: number }) {
  return (
    <svg aria-hidden viewBox={`0 0 ${rows[0].length} ${rows.length}`} width={rows[0].length * px} height={rows.length * px} shapeRendering="crispEdges" className="block">
      {rows.flatMap((row, y) => [...row].map((c, x) => (SPRITE_COLORS[c] ? <rect key={`${x},${y}`} x={x} y={y} width={1.02} height={1.02} fill={SPRITE_COLORS[c]} /> : null)))}
    </svg>
  );
}

const UMBRELLA = [
  "......SSSSSSSS......",
  "....SSssSSSSssSS....",
  "..SSSSssSSSSssSSSS..",
  ".SSSSSssSSSSssSSSSS.",
  "SSSSSSssSSSSssSSSSSS",
  "S.SS.SSS.SS.SSS.SS.S",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
];
const HAT = ["...RR...", "..TTTT..", ".TTTTTT.", "RRRRRRRR"];
const ZED = ["ZZZ", ".Z.", "ZZZ"];

/** The picked mascot, dressed for the weather. */
function SceneMascot({ sky, night }: { sky: Sky; night: boolean }) {
  const kind = useMascot();
  const reduce = useReducedMotion();
  const wet = sky === "drizzle" || sky === "rain" || sky === "storm";
  // A click here stays with the mascot (hearts, a backflip), and doesn't expand the card.
  return (
    <div className="absolute right-6 z-10 transform-gpu" onClick={(e) => e.stopPropagation()} style={{ bottom: `${((SCENE_SIZE - SCENE_GROUND) / SCENE_SIZE) * 100}%` }}>
      {wet && (
        <motion.div
          className="absolute bottom-full left-1/2 -ml-6"
          style={{ transformOrigin: "50% 100%" }}
          animate={reduce ? undefined : { rotate: sky === "storm" ? [-10, 8, -6, 10, -10] : [-2, 2, -2] }}
          transition={{ duration: sky === "storm" ? 1.2 : 3.2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Sprite rows={UMBRELLA} />
        </motion.div>
      )}
      {sky === "snow" && (
        <div className="absolute bottom-full left-1/2 -mb-1 -ml-2.5">
          <Sprite rows={HAT} />
        </div>
      )}
      {night ? (
        <>
          {!reduce &&
            [0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="absolute -top-1 -right-1"
                initial={{ opacity: 0 }}
                animate={{ x: [0, 4, 8], y: [0, -8, -16], opacity: [0, 1, 0] }}
                transition={{ duration: 2.4, delay: i * 0.8, repeat: Infinity, ease: "easeOut" }}
              >
                <Sprite rows={ZED} px={1.5} />
              </motion.div>
            ))}
          {/* Breathing in its sleep, as it does on the composer. */}
          <motion.div
            style={{ transformOrigin: "50% 100%" }}
            animate={reduce ? undefined : { scaleY: [1, 1.05, 1] }}
            transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
          >
            <MascotSprite kind={kind} closed className="block" />
          </motion.div>
        </>
      ) : (
        <Mascot busy={false} draft="" still />
      )}
    </div>
  );
}

const shortDay = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" });
const weekday = (date: string) => shortDay(date).toUpperCase();

/** A saved chat outlives its weather. */
const STALE_AFTER = 60 * 60 * 1000;

/** Bitmap type where it can be, ordinary type where the text has characters the face lacks. */
function Type({ text, px }: { text: string; px: number }) {
  if (fitsPixels(text)) return <PixelText text={text} px={px} rows={9} />;
  return <span className="block truncate text-xs leading-none font-medium">{text}</span>;
}

function SkyMark({ sky, night }: { sky: Sky; night: boolean }) {
  return <SkyIcon rows={night && (sky === "clear" || sky === "partly") ? ICONS.moon : ICONS[sky]} />;
}

interface View {
  sky: Sky;
  phase: Phase;
  night: boolean;
  word: string;
  summary: string;
  title: string;
  style: CSSProperties;
  deg: (celsius: number) => string;
}

function viewOf(weather: WeatherOutput, unit: TemperatureUnit): View {
  const deg = (celsius: number) => degrees(celsius, unit);
  const sky = skyFor(weather.code);
  // Cards saved before phases existed only know day from night.
  const phase: Phase = weather.phase ?? (weather.isDay ? "day" : "night");
  const word = sky === "clear" ? CLEAR_WORDS[phase] : WORDS[sky];
  const today = weather.days[0];
  const light = isLightPhase(phase);
  return {
    sky,
    phase,
    night: phase === "night",
    word,
    deg,
    summary:
      `${weather.place}: ${deg(weather.temperatureC)}, ${word}, feels like ${deg(weather.feelsLikeC)}.` +
      (today ? ` Today's high ${deg(today.highC)}, low ${deg(today.lowC)}.` : "") +
      weather.days.slice(1, 4).map((d) => ` ${weekday(d.date)} ${deg(d.highC)}, ${d.condition}.`).join(""),
    title: today ? `Feels like ${deg(weather.feelsLikeC)} · High ${deg(today.highC)} · Low ${deg(today.lowC)}` : `Feels like ${deg(weather.feelsLikeC)}`,
    style: { color: light ? "#0e3a3a" : RICE, "--type-shadow": light ? "rgb(255 255 255 / 0.4)" : "rgb(0 0 0 / 0.3)" } as CSSProperties,
  };
}

/** The scene with the headline figures over it: the whole of the compact card. */
function Face({ weather, view, unit, onOpen }: { weather: WeatherOutput; view: View; unit: TemperatureUnit; onOpen?: () => void }) {
  const { sky, phase, night, word, deg } = view;
  return (
    <div
      role="img"
      aria-label={view.summary}
      title={view.title}
      style={view.style}
      onClick={onOpen}
      className={cn("relative isolate aspect-square w-full overflow-hidden rounded-3xl shadow-lg ring-1 ring-black/10 select-none dark:ring-white/10", onOpen && "cursor-pointer")}
    >
      <Scene sky={sky} phase={phase} />
      <SceneMascot sky={sky} night={night} />
      <div className="pointer-events-none absolute inset-0 z-10 flex transform-gpu flex-col p-6">
        <Type text={weather.place} px={2} />
        <div className="mt-2">
          {/* Keyed so a change of unit dissolves in whole, not just the pixels that differ. */}
          <PixelText key={unit} text={deg(weather.temperatureC)} px={9} dissolve={600} />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <SkyMark sky={sky} night={night} />
          <PixelText text={word} px={2} rows={9} />
        </div>
        <dl className="mt-auto grid grid-cols-3 gap-2">
          {weather.days.slice(1, 4).map((d) => (
            <div key={d.date} className="flex flex-col gap-2">
              <dt className="opacity-70">
                <PixelText text={weekday(d.date)} px={2} />
              </dt>
              <dd>
                <PixelText text={deg(d.highC)} px={2} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// The expanded view's ground, in the mood of the scene above it.
const PANEL: Record<Phase, string> = { day: "#eef8fc", dawn: "#fff3ec", dusk: "#2b1a25", night: "#0c1a2e" };
const TILE = "rounded-lg bg-[color-mix(in_srgb,currentColor_7%,transparent)]";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${TILE} flex min-w-0 flex-col justify-between gap-2 p-3`}>
      <dt className="text-xs opacity-70">{label}</dt>
      <dd className="text-lg leading-6 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

const uvWord = (uv: number) => (uv < 3 ? "Low" : uv < 6 ? "Moderate" : uv < 8 ? "High" : uv < 11 ? "Very high" : "Extreme");

const percent = (chance: number | null | undefined) => (chance === null || chance === undefined ? "-" : `${Math.round(chance)}%`);

function NextHours({ weather, deg }: { weather: WeatherOutput; deg: View["deg"] }) {
  return (
    <section aria-labelledby="weather-hours" className="flex min-w-0 flex-col gap-2">
      <h3 id="weather-hours" className="text-sm font-medium">
        Next 24 hours
      </h3>
      {/* Focusable, so the row can be scrolled from the keyboard. */}
      <ul tabIndex={0} aria-labelledby="weather-hours" className="flex gap-1 overflow-x-auto rounded-lg pb-2 outline-none focus-visible:ring-2 focus-visible:ring-current">
        {weather.hours.map((h, i) => (
          <li key={h.time} title={`Chance of rain ${percent(h.precipitationChance)}`} className={`${TILE} flex w-14 shrink-0 flex-col items-center gap-2 py-3`}>
            <span className="text-xs whitespace-nowrap">{i === 0 ? "Now" : clockTime(h.time, { hour: "numeric" }).replace(" ", "")}</span>
            <span className="flex h-7 items-center">
              <SkyMark sky={skyFor(h.code)} night={!h.isDay} />
            </span>
            <span className="text-sm font-medium tabular-nums">{deg(h.temperatureC)}</span>
            <span className="text-xs tabular-nums opacity-70">{percent(h.precipitationChance)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextWeek({ weather, deg }: { weather: WeatherOutput; deg: View["deg"] }) {
  const days = weather.days.slice(1, 8);
  // One scale for every row, so a warmer day sits further along.
  const low = Math.min(...days.map((d) => d.lowC));
  const span = Math.max(Math.max(...days.map((d) => d.highC)) - low, 1);
  return (
    <section aria-labelledby="weather-week" className="flex flex-col gap-2">
      <h3 id="weather-week" className="text-sm font-medium">
        Next 7 days
      </h3>
      <table aria-labelledby="weather-week" className="w-full border-separate border-spacing-y-1">
        <thead>
          <tr className="text-left text-xs opacity-70">
            <th scope="col" className="w-14 pl-3 font-normal">
              Day
            </th>
            <th scope="col" className="w-10 font-normal">
              <span className="sr-only">Conditions</span>
            </th>
            <th scope="col" className="w-14 font-normal">
              Rain
            </th>
            <th scope="col" className="w-12 font-normal">
              Low
            </th>
            <th scope="col" className="font-normal">
              <span className="sr-only">Range</span>
            </th>
            <th scope="col" className="w-14 pl-3 font-normal">
              High
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date} title={`${d.condition}, low ${deg(d.lowC)}, high ${deg(d.highC)}, chance of rain ${percent(d.precipitationChance)}`}>
              <th scope="row" className="rounded-l-lg bg-[color-mix(in_srgb,currentColor_7%,transparent)] py-2 pl-3 text-left text-sm font-medium">
                {shortDay(d.date)}
              </th>
              <td className="bg-[color-mix(in_srgb,currentColor_7%,transparent)] py-2">
                {/* A fixed height, so every row is the same whichever icon it has. */}
                <span className="flex h-7 items-center">
                  <SkyMark sky={skyFor(d.code)} night={false} />
                </span>
                <span className="sr-only">{d.condition}</span>
              </td>
              <td className="bg-[color-mix(in_srgb,currentColor_7%,transparent)] py-2 text-sm tabular-nums">{percent(d.precipitationChance)}</td>
              <td className="bg-[color-mix(in_srgb,currentColor_7%,transparent)] py-2 text-sm tabular-nums">{deg(d.lowC)}</td>
              <td aria-hidden className="bg-[color-mix(in_srgb,currentColor_7%,transparent)] py-2">
                <div className="relative h-2 min-w-16 rounded-xs bg-[color-mix(in_srgb,currentColor_12%,transparent)]">
                  <div
                    className="absolute inset-y-0 rounded-xs"
                    style={{ left: `${((d.lowC - low) / span) * 100}%`, width: `${Math.max(((d.highC - d.lowC) / span) * 100, 4)}%`, backgroundImage: temperatureGradient(d.lowC, d.highC) }}
                  />
                </div>
              </td>
              <td className="rounded-r-lg bg-[color-mix(in_srgb,currentColor_7%,transparent)] py-2 pl-3 text-sm font-medium tabular-nums">{deg(d.highC)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Follows the panel's colours rather than the app's theme, which may not match the scene. */
function UnitToggle({ unit }: { unit: TemperatureUnit }) {
  return (
    <div role="radiogroup" aria-label="Temperature unit" className={`${TILE} flex gap-1 p-1`}>
      {TEMPERATURE_UNITS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={unit === o.value}
          onClick={() => setTemperatureUnit(o.value)}
          className={`h-7 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-current ${unit === o.value ? "bg-[color-mix(in_srgb,currentColor_16%,transparent)] font-medium" : "opacity-70 hover:opacity-100"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Attribution({ weather }: { weather: WeatherOutput }) {
  const stale = Date.now() - weather.fetchedAt > STALE_AFTER;
  return (
    <span className="min-w-0">
      {stale && <>{new Date(weather.fetchedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · </>}
      <button type="button" onClick={() => void openUrl("https://open-meteo.com/")} className="underline-offset-2 hover:underline">
        Weather by Open-Meteo
      </button>
    </span>
  );
}

function Expanded({ weather, view, unit }: { weather: WeatherOutput; view: View; unit: TemperatureUnit }) {
  const { deg } = view;
  const today = weather.days[0];
  const stats: { label: string; value: string | null }[] = [
    { label: "Feels like", value: deg(weather.feelsLikeC) },
    { label: "High", value: today ? deg(today.highC) : null },
    { label: "Low", value: today ? deg(today.lowC) : null },
    { label: "Chance of rain", value: today && today.precipitationChance !== null ? percent(today.precipitationChance) : null },
    { label: "Humidity", value: weather.humidity === null ? null : percent(weather.humidity) },
    { label: "Wind", value: weather.windKmh === null ? null : windSpeed(weather.windKmh, unit) },
    { label: "UV index", value: weather.uvIndex === null ? null : `${Math.round(weather.uvIndex)} ${uvWord(weather.uvIndex)}` },
    { label: "Sunrise", value: weather.sunrise ? clockTime(weather.sunrise) : null },
    { label: "Sunset", value: weather.sunset ? clockTime(weather.sunset) : null },
  ];
  return (
    <DialogContent
      aria-describedby={undefined}
      style={{ ...view.style, backgroundColor: PANEL[view.phase] }}
      // The figures are for reading, so they're in the user's chat font. The card keeps its pixels.
      className="max-h-[90vh] w-[56rem] max-w-[calc(100vw-2rem)] gap-6 overflow-y-auto rounded-3xl p-6 font-(family-name:--transcript-font) [word-spacing:var(--transcript-word-spacing)] sm:max-w-[calc(100vw-2rem)]"
    >
      <DialogTitle className="sr-only">Weather in {weather.place}</DialogTitle>
      <div className="grid gap-4 md:grid-cols-[20rem_minmax(0,1fr)]">
        <Face weather={weather} view={view} unit={unit} />
        <section aria-labelledby="weather-today" className="flex min-w-0 flex-col gap-2">
          <h3 id="weather-today" className="text-sm font-medium">
            Today
          </h3>
          <dl className="grid flex-1 auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3">
            {stats.map((s) => s.value !== null && <Stat key={s.label} label={s.label} value={s.value} />)}
          </dl>
        </section>
      </div>
      <NextHours weather={weather} deg={deg} />
      <NextWeek weather={weather} deg={deg} />
      <footer className="flex items-center justify-between gap-2 text-xs">
        <span className="opacity-70">
          <Attribution weather={weather} />
        </span>
        <UnitToggle unit={unit} />
      </footer>
    </DialogContent>
  );
}

export function WeatherCard({ weather }: { weather: WeatherOutput }) {
  const unit = useTemperatureUnit();
  const [expanded, setExpanded] = useState(false);
  const view = viewOf(weather, unit);
  // Cards saved before the expanded view have nothing more to show.
  const canExpand = (weather.hours?.length ?? 0) > 0;

  return (
    <figure className="w-80 max-w-full" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {/* A shortcut for the pointer; the button below is the way in from the keyboard. */}
      <Face weather={weather} view={view} unit={unit} onOpen={canExpand ? () => setExpanded(true) : undefined} />
      <figcaption className="mt-2 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <Attribution weather={weather} />
        <span className="flex shrink-0 items-center gap-1">
          <Segmented label="Temperature unit" value={unit} onChange={setTemperatureUnit} options={TEMPERATURE_UNITS} />
          {canExpand && (
            <Button variant="ghost" size="icon-sm" aria-label="Expand weather" title="Expand weather" onClick={() => setExpanded(true)}>
              <MaximizeIcon />
            </Button>
          )}
        </span>
      </figcaption>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        {expanded && <Expanded weather={weather} view={view} unit={unit} />}
      </Dialog>
    </figure>
  );
}
