// The weather card's backdrop: a small pixel landscape on a canvas, with the weather in it
// and its colours set by where the sun is at the place: light by day and at sunrise, dark
// at night and at sunset. The sky, sun or moon and hills are dithered once into a buffer; each frame lays the weather over it (clouds, rain, snow, fog, lightning).
// Drawn at a low resolution and scaled up by CSS (`image-rendering: pixelated`).

import type { Phase } from "@/lib/tauri";

export type Sky = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

/** WMO codes, grouped as `sush_core::weather` words them. */
export function skyFor(code: number): Sky {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "cloudy";
}

export const SCENE_SIZE = 108;
/** Where the mascot stands: the flat top of the near hill, in scene pixels from the top. */
export const SCENE_GROUND = 66;
/** The middle of that flat top. */
const MOUND = 92;

const RICE = "#fff8ee";
const SALMON = "#e94a35";
const STRIPE = "#ff8f73";

type Rgb = [number, number, number];

const rgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = ([r, g, b]: Rgb, alpha = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;

/** A stable pseudo-random 0–1, so the scene looks scattered but never reshuffles. */
const noise = (n: number) => {
  const v = Math.sin(n * 12.9898 + 4.1) * 43758.5453;
  return v - Math.floor(v);
};

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const threshold = (x: number, y: number) => (BAYER[y & 3][x & 3] + 0.5) / 16;

interface Palette {
  top: string;
  bottom: string;
  far: string;
  near: string;
  ground: string;
  deep: string;
  drop: string;
}

// Day: bright skies, pale enough for dark type. The ground gets lighter toward the foot.
const WATER = "#2f7f9a";
const DAY: Record<Sky, Palette> = {
  clear: { top: "#6fc6ee", bottom: "#dff5fb", far: "#8fd3c4", near: "#55b58f", ground: "#7dcba6", deep: "#a3dfbf", drop: WATER },
  partly: { top: "#86cdf0", bottom: "#e6f6fb", far: "#8fd3c4", near: "#55b58f", ground: "#7dcba6", deep: "#a3dfbf", drop: WATER },
  cloudy: { top: "#a9c4d6", bottom: "#e3ecf1", far: "#a6c2c4", near: "#7fa9a0", ground: "#97bfb2", deep: "#b0d2c6", drop: WATER },
  fog: { top: "#c3d3d6", bottom: "#eaf0ef", far: "#c9d8d5", near: "#a7bfb9", ground: "#b7cdc6", deep: "#cbded7", drop: WATER },
  drizzle: { top: "#9cc0d2", bottom: "#d9e9ef", far: "#94bcc0", near: "#6fa59f", ground: "#8abcb1", deep: "#a8d0c5", drop: WATER },
  rain: { top: "#7ea6bd", bottom: "#bcd4de", far: "#7fa8b0", near: "#5f9490", ground: "#78aca6", deep: "#94c2ba", drop: WATER },
  snow: { top: "#b3d8ee", bottom: "#eef8fc", far: "#d3e6ee", near: "#b3d0dc", ground: "#c6dee7", deep: "#dcecf2", drop: RICE },
  storm: { top: "#6f8aa3", bottom: "#a9bfcc", far: "#5f7f8f", near: "#4d7478", ground: "#65908f", deep: "#7fa8a3", drop: WATER },
};

// Night: midnight blues for light type. The ground gets darker toward the foot.
const MOONLIT = "#a9d4e8";
const NIGHT: Record<Sky, Palette> = {
  clear: { top: "#0a1430", bottom: "#1f4a6e", far: "#173a55", near: "#0e2b3e", ground: "#0a2030", deep: "#071725", drop: RICE },
  partly: { top: "#0c1836", bottom: "#245073", far: "#173a55", near: "#0e2b3e", ground: "#0a2030", deep: "#071725", drop: RICE },
  cloudy: { top: "#14243c", bottom: "#34546e", far: "#27475c", near: "#193648", ground: "#122a3a", deep: "#0d202e", drop: RICE },
  fog: { top: "#2a3f4f", bottom: "#5f7d88", far: "#476673", near: "#324f5b", ground: "#253e48", deep: "#1c3039", drop: RICE },
  drizzle: { top: "#12293f", bottom: "#335a76", far: "#264a60", near: "#1a394c", ground: "#132b3a", deep: "#0e212d", drop: MOONLIT },
  rain: { top: "#0d2134", bottom: "#27496a", far: "#1c3d55", near: "#153042", ground: "#0f2433", deep: "#0a1a26", drop: MOONLIT },
  snow: { top: "#1f3a58", bottom: "#5e86a8", far: "#55799a", near: "#3d5f7d", ground: "#2e4c66", deep: "#233d54", drop: RICE },
  storm: { top: "#0a1622", bottom: "#243a4c", far: "#18303f", near: "#112632", ground: "#0c1c26", deep: "#081520", drop: MOONLIT },
};

// Sunrise is soft and pale: pink over peach and gold, leading into a light day.
// Sunset is rich and deep: wine over ember and orange, leading into a dark night.
const DAWN: Palette = { top: "#f7a8b8", bottom: "#ffe2a8", far: "#e995a0", near: "#6fae9f", ground: "#8cc4b4", deep: "#a9d8c8", drop: RICE };
const DUSK: Palette = { top: "#7a2b3e", bottom: "#ffa14f", far: "#8c3b3f", near: "#2a3a4a", ground: "#1f2c3a", deep: "#16202c", drop: RICE };
/** Holds a sunset's deep colour behind the type, with the orange lower down. */
const SUNSET_CURVE = 2;

/** How much a sky's weather greys out the colour of dawn or dusk. */
const GLOOM: Record<Sky, number> = { clear: 0, partly: 0.1, cloudy: 0.4, fog: 0.45, drizzle: 0.4, rain: 0.5, snow: 0.4, storm: 0.6 };

const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const toward = (hex: string, target: string, t: number) => toHex(mix(rgb(hex), rgb(target), t));

export const isLightPhase = (phase: Phase) => phase === "day" || phase === "dawn";

function paletteFor(sky: Sky, phase: Phase): Palette {
  if (phase === "day") return DAY[sky];
  if (phase === "night") return NIGHT[sky];
  const glow = phase === "dawn" ? DAWN : DUSK;
  const weather = (phase === "dawn" ? DAY : NIGHT)[sky];
  const blend = (key: "top" | "bottom" | "far" | "near" | "ground" | "deep") => toward(glow[key], weather[key], GLOOM[sky]);
  return { top: blend("top"), bottom: blend("bottom"), far: blend("far"), near: blend("near"), ground: blend("ground"), deep: blend("deep"), drop: weather.drop };
}

const farHill = (x: number) => 54 + 5 * Math.sin(x * 0.09 + 1.2) + 3 * Math.sin(x * 0.23 + 2);

/** Rolling, then easing into the flat top the mascot stands on. */
function nearHill(x: number) {
  const roll = 69 + 3 * Math.sin(x * 0.07 + 0.4) + 1.5 * Math.sin(x * 0.31);
  const flat = Math.max(0, 1 - Math.max(0, Math.abs(x - MOUND) - 12) / 12);
  return roll + (SCENE_GROUND - roll) * flat;
}

/** Sun or moon: where it sits, and how it's coloured. */
function bodyFor(sky: Sky, phase: Phase): { x: number; y: number; r: number; core: Rgb; halo: Rgb; craters?: boolean } | null {
  if (sky !== "clear" && sky !== "partly") return null;
  const big = sky === "clear";
  if (phase === "night") return { x: 84, y: 22, r: 9, core: rgb("#efe6d2"), halo: rgb("#6fb7d9"), craters: true };
  // High in the sky by day; low on the hills, half hidden, at either end of it.
  if (phase === "day") return { x: 84, y: 22, r: big ? 10 : 8, core: rgb("#ffd166"), halo: rgb("#fff0b8") };
  if (phase === "dusk") return { x: 80, y: 44, r: big ? 14 : 12, core: rgb("#ffe08a"), halo: rgb("#ffb35c") };
  return { x: 80, y: 44, r: big ? 13 : 11, core: rgb("#ff9d5c"), halo: rgb("#ffd08a") };
}

function background(sky: Sky, phase: Phase): HTMLCanvasElement {
  const p = paletteFor(sky, phase);
  const [top, bottom, far, near, ground, deep] = [p.top, p.bottom, p.far, p.near, p.ground, p.deep].map(rgb);
  const body = bodyFor(sky, phase);
  const snowy = sky === "snow";
  // Snow lying on the ridges, soft enough that type crossing it stays readable.
  const cap = mix(rgb(RICE), top, 0.25);
  const image = new ImageData(SCENE_SIZE, SCENE_SIZE);
  const LEVELS = 7;
  for (let y = 0; y < SCENE_SIZE; y++) {
    for (let x = 0; x < SCENE_SIZE; x++) {
      const dither = threshold(x, y);
      // The sky in a few flat bands, dithered where they meet.
      const band = Math.floor((y / SCENE_GROUND) * LEVELS + dither) / LEVELS;
      let c = mix(top, bottom, Math.min(1, phase === "dusk" ? band ** SUNSET_CURVE : band));
      if (body) {
        const d = Math.hypot(x - body.x, y - body.y);
        if (d <= body.r) c = body.core;
        else if (d <= body.r + 6 && dither > 0.35 + (d - body.r) / 8) c = mix(c, body.halo, 0.55);
        if (body.craters && d <= body.r && ((Math.hypot(x - body.x + 3, y - body.y + 2) < 2) || Math.hypot(x - body.x - 3, y - body.y - 3) < 1.6)) c = mix(body.core, top, 0.3);
      }
      const farTop = Math.round(farHill(x));
      if (y >= farTop) c = snowy && (y - farTop) / 5 < dither ? cap : far;
      const nearTop = Math.round(nearHill(x));
      if (y >= nearTop) {
        // Grass tufts break the ridge's line; below it, the ground shades toward the foot.
        c = y === nearTop && noise(x) > 0.6 ? mix(near, rgb(RICE), 0.16) : near;
        const down = (y - nearTop) / (SCENE_SIZE - nearTop);
        if (y > nearTop + 2) c = down + dither * 0.3 > 0.6 ? deep : down + dither * 0.3 > 0.22 ? ground : near;
        if (snowy && (y - nearTop) / 6 < dither) c = cap;
      }
      const i = (y * SCENE_SIZE + x) * 4;
      image.data[i] = c[0];
      image.data[i + 1] = c[1];
      image.data[i + 2] = c[2];
      image.data[i + 3] = 255;
    }
  }
  const buffer = document.createElement("canvas");
  buffer.width = buffer.height = SCENE_SIZE;
  buffer.getContext("2d")!.putImageData(image, 0, 0);
  return buffer;
}

interface Tones {
  light: string;
  mid: string;
  shade: string;
}

function sprite(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** A billowy cloud: overlapping puffs on a flat base, each lit from the upper left. */
function cloudSprite(width: number, height: number, seed: number, tones: Tones) {
  const { canvas, ctx } = sprite(width, height);
  const count = Math.max(3, Math.round(width / 7));
  const puffs = Array.from({ length: count }, (_, i) => {
    const along = (i + 0.5) / count;
    const r = (0.4 + 0.6 * Math.sin(Math.PI * along)) * height * 0.5 * (0.85 + 0.3 * noise(seed + i));
    return { x: r + along * (width - 2 * r), y: height - r * 0.75, r };
  }).sort((a, b) => b.y - a.y); // Lower puffs sit in front, so they're found first.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const puff = puffs.find((c) => Math.hypot(x - c.x, y - c.y) <= c.r);
      if (!puff) continue;
      const dither = threshold(x, y);
      const lit = (y - puff.y + (x - puff.x) * 0.35) / puff.r + (dither - 0.5) * 0.5;
      ctx.fillStyle = lit < -0.15 ? tones.light : lit < 0.45 && y < height - 2 ? tones.mid : tones.shade;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

const DECK_WIDTH = SCENE_SIZE * 2;

/** A ceiling of cloud with a scalloped underside. Its pattern repeats, so it can scroll forever. */
function deckSprite(base: number, tones: Tones) {
  const { canvas, ctx } = sprite(DECK_WIDTH, base + 8);
  for (let x = 0; x < DECK_WIDTH; x++) {
    const bottom = base + Math.round(5 * Math.abs(Math.sin((x * Math.PI) / 18)) + 2 * Math.sin((x * 2 * Math.PI) / SCENE_SIZE));
    for (let y = 0; y < bottom; y++) {
      const depth = bottom - y + threshold(x, y) * 2;
      ctx.fillStyle = depth < 3 ? tones.shade : depth < 7 ? tones.mid : tones.light;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

/** Back to front: where each cloud starts, its size, and its drift in pixels a frame. */
const CLOUD_LAYOUTS: Partial<Record<Sky, { w: number; h: number; x: number; y: number; speed: number }[]>> = {
  // Open sky, with one big cloud starting across the foot of the sun or moon, all clear of the type at first.
  partly: [
    { w: 26, h: 9, x: 44, y: 2, speed: 0.03 },
    { w: 30, h: 11, x: 62, y: 38, speed: 0.04 },
    { w: 44, h: 16, x: 50, y: 21, speed: 0.025 },
  ],
  // Overcast: the clouds overlap until there's hardly any sky left.
  cloudy: [
    { w: 56, h: 22, x: 44, y: 12, speed: 0.03 },
    { w: 50, h: 20, x: -6, y: 14, speed: 0.035 },
    { w: 44, h: 16, x: 72, y: 30, speed: 0.05 },
    { w: 46, h: 18, x: 22, y: 30, speed: 0.045 },
  ],
  drizzle: [
    { w: 46, h: 14, x: 8, y: 10, speed: 0.04 },
    { w: 46, h: 14, x: 62, y: 12, speed: 0.05 },
  ],
  rain: [
    { w: 50, h: 15, x: 2, y: 12, speed: 0.05 },
    { w: 50, h: 15, x: 58, y: 14, speed: 0.06 },
  ],
  storm: [
    { w: 52, h: 17, x: -4, y: 14, speed: 0.07 },
    { w: 44, h: 15, x: 34, y: 18, speed: 0.09 },
    { w: 52, h: 17, x: 70, y: 14, speed: 0.08 },
  ],
  snow: [
    { w: 46, h: 14, x: 6, y: 8, speed: 0.03 },
    { w: 46, h: 14, x: 64, y: 10, speed: 0.035 },
  ],
};

/** How far the cloud ceiling reaches down, in skies that have one. */
const DECK_BASE: Partial<Record<Sky, number>> = { cloudy: 10, drizzle: 9, rain: 12, storm: 16, snow: 7 };

/** How much rice is in a cloud's light, middle and shaded parts. Muted so type over them stays readable. */
const CLOUD_TONES: Partial<Record<Sky, [number, number, number]>> = {
  partly: [0.42, 0.3, 0.18],
  cloudy: [0.32, 0.24, 0.15],
  drizzle: [0.28, 0.2, 0.11],
  rain: [0.22, 0.15, 0.08],
  storm: [0.14, 0.09, 0.04],
  snow: [0.36, 0.26, 0.15],
};

/** Clouds by day, light, middle and shaded: white on fair days, slate in a storm. */
const DAY_CLOUD_TONES: Partial<Record<Sky, [string, string, string]>> = {
  partly: ["#ffffff", "#f1f9fc", "#d3e7f0"],
  cloudy: ["#f6f9fb", "#e0e9ef", "#bfd0da"],
  drizzle: ["#dfe9ef", "#c6d7e0", "#a6bdc9"],
  rain: ["#bfd0da", "#a6bcc8", "#88a4b3"],
  storm: ["#8fa5b4", "#7b93a4", "#657f90"],
  snow: ["#f9fcfe", "#e6f0f6", "#c9dce8"],
};

function toneSet(sky: Sky, phase: Phase, top: Rgb): Tones | null {
  const amounts = CLOUD_TONES[sky];
  if (!amounts) return null;
  if (isLightPhase(phase)) {
    const hexes = DAY_CLOUD_TONES[sky]!;
    // Blushing pink as the sun comes up.
    const tone = (hex: string) => (phase === "dawn" ? toward(hex, "#ffc2c0", 0.45) : hex);
    return { light: tone(hexes[0]), mid: tone(hexes[1]), shade: tone(hexes[2]) };
  }
  // Lit orange at sunset, moonlit at night.
  const tone = (amount: number) => css(phase === "dusk" ? mix(top, rgb("#ffb88a"), amount * 1.2) : mix(top, rgb(RICE), amount * 0.6));
  return { light: tone(amounts[0]), mid: tone(amounts[1]), shade: tone(amounts[2]) };
}

function cloudsFor(sky: Sky, phase: Phase, top: Rgb) {
  const tones = toneSet(sky, phase, top);
  if (!tones) return { clouds: [], deck: null };
  const clouds = (CLOUD_LAYOUTS[sky] ?? []).map((c, i) => ({ ...c, canvas: cloudSprite(c.w, c.h, i * 17 + 3, tones) }));
  const base = DECK_BASE[sky];
  return { clouds, deck: base === undefined ? null : deckSprite(base, tones) };
}

const FLOCK = [
  ["#.#", ".#."],
  ["...", "###"],
];

/** Returns a function that draws frame `n` (frames come about eight times a second). */
export function createScene(sky: Sky, phase: Phase) {
  const buffer = background(sky, phase);
  const p = paletteFor(sky, phase);
  const light = isLightPhase(phase);
  const open = sky === "clear" || sky === "partly";
  const top = rgb(p.top);
  const riceRgb = rgb(RICE);
  const { clouds, deck } = cloudsFor(sky, phase, top);
  // Rain starts from under the ceiling, not in front of it.
  const rainFrom = (DECK_BASE[sky] ?? 0) + 4;
  const drops = { drizzle: 26, rain: 64, storm: 84 }[sky as "drizzle" | "rain" | "storm"] ?? 0;
  // The first few stars are out at sunset, high up.
  const stars = !open ? 0 : phase === "night" ? 34 : phase === "dusk" ? 10 : 0;
  const starDepth = phase === "dusk" ? 16 : 48;

  return (ctx: CanvasRenderingContext2D, frame: number) => {
    ctx.drawImage(buffer, 0, 0);

    for (let i = 0; i < stars; i++) {
      const x = Math.floor(noise(i + 40) * SCENE_SIZE);
      const y = Math.floor(noise(i + 90) * starDepth);
      // Each star dips now and then, on its own beat.
      const lit = Math.floor(frame / 5 + noise(i + 7) * 11) % 11 !== 0;
      ctx.fillStyle = css(riceRgb, lit ? 0.3 + noise(i + 3) * 0.7 : 0.12);
      ctx.fillRect(x, y, 1, 1);
    }

    for (const c of clouds) {
      const span = SCENE_SIZE + c.w;
      ctx.drawImage(c.canvas, Math.floor(((c.x + c.w + frame * c.speed) % span) - c.w), c.y);
    }
    if (deck) {
      const x = Math.floor((frame * 0.03) % DECK_WIDTH);
      ctx.drawImage(deck, -x, 0);
      ctx.drawImage(deck, DECK_WIDTH - x, 0);
    }

    if (phase !== "night" && open) {
      // A pair of birds crossing now and then.
      const x = SCENE_SIZE + 8 - ((frame * 0.5) % (SCENE_SIZE + 160));
      const wings = FLOCK[Math.floor(frame / 3) % 2];
      ctx.fillStyle = css(rgb("#0b2f30"), 0.85);
      for (const [dx, dy] of [[0, 0], [6, 3]]) {
        wings.forEach((row, ry) => [...row].forEach((c, rx) => c === "#" && ctx.fillRect(Math.floor(x + dx + rx), 34 + dy + ry, 1, 1)));
      }
    }

    if (sky === "fog") {
      ctx.fillStyle = css(riceRgb, light ? 0.5 : 0.3);
      for (let band = 0; band < 4; band++) {
        const y0 = 26 + band * 14;
        const drift = Math.floor(frame * (0.08 + band * 0.03));
        for (let x = 0; x < SCENE_SIZE; x++) {
          // Each wisp swells and thins along its length, so it has no edges of its own.
          const wave = Math.sin((x + drift) * 0.09 + band * 2) + 0.4 * Math.sin((x + drift) * 0.23 + band);
          const reach = Math.round(wave * 4);
          for (let y = y0 - reach; y <= y0 + reach; y++) {
            if (reach > 0 && (x + y + drift) % 2 === 0) ctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }

    if (drops) {
      ctx.fillStyle = css(rgb(p.drop), sky === "drizzle" ? 0.4 : 0.55);
      const length = sky === "drizzle" ? 2 : 3;
      const fall = sky === "drizzle" ? 2 : 4;
      for (let i = 0; i < drops; i++) {
        const span = SCENE_GROUND + 12;
        const y = (noise(i + 11) * span + frame * (fall + noise(i) * 2)) % span;
        // Blown a little sideways as they fall.
        const x = Math.floor((noise(i + 23) * SCENE_SIZE + SCENE_SIZE - y * 0.15) % SCENE_SIZE);
        // They land on the hills, which keeps the forecast below clear of them.
        const land = Math.round(nearHill(x));
        if (y < rainFrom) continue;
        if (y < land) ctx.fillRect(x, Math.floor(y) - 4, 1, length);
        else if (y < land + 2) ctx.fillRect(x - 1, land, 3, 1);
      }
    }

    if (sky === "snow") {
      for (let i = 0; i < 56; i++) {
        const span = SCENE_GROUND + 6;
        const y = (noise(i + 11) * span + frame * (0.35 + noise(i) * 0.4)) % span;
        const x = Math.floor((noise(i + 23) * SCENE_SIZE + Math.sin((y + i * 9) * 0.2) * 2 + SCENE_SIZE) % SCENE_SIZE);
        if (y >= nearHill(x) || y < rainFrom) continue;
        const big = i % 5 === 0;
        ctx.fillStyle = css(riceRgb, big ? 0.55 : 0.7);
        ctx.fillRect(x, Math.floor(y) - 2, big ? 2 : 1, big ? 2 : 1);
      }
    }

    if (sky === "storm") {
      // A strike every six seconds or so, with an after-flicker. The sky lifts only slightly.
      const beat = frame % 48;
      const strike = Math.floor(frame / 48);
      if (frame > 0 && (beat < 2 || beat === 4)) {
        ctx.fillStyle = css(riceRgb, 0.14);
        ctx.fillRect(0, 0, SCENE_SIZE, SCENE_SIZE);
        ctx.fillStyle = beat === 4 ? STRIPE : SALMON;
        // To the right of the type, so the words stay readable through a strike.
        let x = 66 + Math.floor(noise(strike + 5) * 22);
        for (let y = 6; y < 60; y += 4) {
          ctx.fillRect(x, y, 2, 4);
          x += Math.floor(noise(strike * 13 + y) * 5) - 2;
        }
      }
    }
  };
}
