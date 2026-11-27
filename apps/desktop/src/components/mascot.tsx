// Sushi, Sush's mascot: a pixel-art nigiri (salmon on rice, a teal nori band)
// who stands on the composer, or any built-in avatar picked in Settings →
// Sushi. Its eyes follow the pointer (and drop to the input while you type),
// it breathes, blinks, wanders along the composer's edge now and then, and
// falls asleep when the app is left alone. While a run is going it slides on a
// pair of glasses, and acts out the stage the reply is at: thinking (eyes up,
// head rocking, a thought bubble), using tools (a laptop, typing away, the
// screen lighting its face) and writing the answer (typing faster, a glint
// sweeping the lenses). When the reply is done the glasses lift off with a
// little hop. Clicking it hops
// and pops a heart; three quick clicks do a backflip, and a whole flurry of
// them leaves it dizzy: it reels, eyes rolling, falls flat on its back with a
// "whoa" and a thud (`lib/sfx.ts`) and lies there seeing stars to birdsong,
// then springs back up. Switching characters
// pops the new one in with a puff of sparkles. Between replies it can also act
// out an activity on request (`act`, from Settings → Sushi): a coffee break (a
// machine beside it fills a mug, then it sips), reading a book in its glasses,
// dancing with music notes, a nap, a workout with a dumbbell, juggling,
// meditating in a floating glow, or a handheld game. Purely decorative.

import { AnimatePresence, motion, MotionConfig, MotionConfigContext, useAnimationControls, useInView, usePageInView, useReducedMotion, type TargetAndTransition } from "motion/react";
import { useContext, useEffect, useRef, useState } from "react";

import { AVATARS, avatarPalette, type AvatarDef } from "@/lib/avatars";
import { DEFAULT_MASCOT, mascotSounds, useMascot } from "@/lib/mascot";
import { audio, fallSounds } from "@/lib/sfx";
import { cn, isMobile } from "@/lib/utils";

// One character per pixel; "." is transparent. Eyes and legs are drawn
// separately so they can move: the body below has rice where the eyes go.
const SPRITE = [
  "...SSSSSSSSSS...",
  "..SsSSSNNSSSsS..",
  ".SSSsSSNNSSsSSS.",
  ".RRRRRRNNRRRRRR.",
  "rRRRRRRNNRRRRRRr",
  "rRRRRRRNNRRRRRRr",
  "rRRRRRRNNRRRRRRr",
  "rRPRRRRNNRRRRPRr",
  ".rRRRRRNNRRRRRr.",
  "..rrrrrrrrrrrr..",
];

/** Sushi's body rows (rice where the eyes go), for scenes that paint it (`image-tv.tsx`). */
export const SUSHI_ROWS = SPRITE;

// Walk cycle: legs apart, then feet together.
const LEG_FRAMES = ["...L..L....L..L.", "....LL......LL.."];

// The laptop's lid seen from behind (a little nigiri logo), resting on the
// ground in front of the character, in Sushi's pixels; on Sushi its top edge
// sits just under the eyes.
const LAPTOP = [
  "...KKKKKKKKKK...",
  "...KkkkOOkkkK...",
  "...KkkkkkkkkK...",
  "..BBBBBBBBBBBB..",
];
const LAPTOP_W = LAPTOP[0].length;

// Typing hands either side of the lid, tapping in turn: [left row, right row].
const HAND_X = [1, 14];
const HAND_FRAMES = [
  [2, 1],
  [1, 2],
];

const HEART = ["HH.HH", "HHHHH", ".HHH.", "..H.."];
// A thought bubble trailing down-left towards the head; its three dots are drawn on top.
const BUBBLE = [
  "..bbbbbbbbb.",
  ".bWWWWWWWWWb",
  ".bWWWWWWWWWb",
  ".bWWWWWWWWWb",
  "..bbbbbbbbb.",
  "..bb........",
  "b...........",
];
const BUBBLE_DOTS = [4, 6, 8];
const ZED = ["ZZZ", ".Z.", "ZZZ"];
const STAR = [".Y.", "YYY", ".Y."];
const NOTE = [".ZZ", ".Z.", "ZZ.", "ZZ."];
const DROP = [".w.", "www", ".w."];

// A dumbbell pressed up from the chest past the eyes and back down.
const DUMBBELL = ["II........II", "IIiiiiiiiiII", "II........II"];
const DUMBBELL_W = DUMBBELL[0].length;
/** One press, up or down, in ms. */
const REP_MS = 650;

// A handheld game console held like the book: d-pad left, buttons right.
const CONSOLE = ["VVVVVVVVVVVV", "VVxVnnnnVoVV", "VxxxnnnnVVoV", "VVxVVVVVVVVV"];
const CONSOLE_W = CONSOLE[0].length;

// Juggling balls, each its own colour, looping over the head out of phase.
const BALLS = ["#f0533f", "#f6c945", "#5b8def"];

// A coffee break: a little machine stands beside the character (in Sushi's
// pixels, its feet level with the character's) and fills a mug, which then
// goes in the character's hands for sips. The machine's mug gap is x 2–7,
// rows 6–9, under the nozzle.
const MACHINE = [
  "DDDDDDDDD",
  "DdddddddD",
  "DdAdddgdD",
  "DDDDDDDDD",
  "DD..BB..D",
  "DD......D",
  "DD......D",
  "DD......D",
  "DD......D",
  "DD......D",
  "DDDDDDDDD",
];
const MUG = ["MeeeM.", "MMMMMm", "MMMMMm", ".MMM.."];
const MUG_W = MUG[0].length;
/** How long the machine takes to fill the mug. */
const BREW_MS = 3200;

// A book held up in front of the face, cover towards us.
const BOOK = ["UUUUUuUUUUU", "UvvvUuUUUUU", "UUUUUuUUUUU", "UvvUUuUUUUU"];
const BOOK_W = BOOK[0].length;

// A whiteboard on legs, standing beside the character at Sushi's pixel size: lines get
// written across it, sticky notes go up, then it's wiped for the next round.
const WHITEBOARD = [
  "kkkkkkkkkkkkkk",
  "kWWWWWWWWWWWWk",
  "kWWWWWWWWWWWWk",
  "kWWWWWWWWWWWWk",
  "kWWWWWWWWWWWWk",
  "kWWWWWWWWWWWWk",
  "kWWWWWWWWWWWWk",
  "kkkkkkkkkkkkkk",
  "..B........B..",
  "..B........B..",
  ".BBB......BBB.",
];
/** One round at the whiteboard, in seconds. */
const BOARD_S = 6;
/** The lines written, and when each goes on, as fractions of a round. */
const BOARD_LINES = [
  { x: 2, y: 2, w: 7, fill: "#5b8def", from: 0.05, to: 0.25 },
  { x: 2, y: 4, w: 5, fill: "#f0533f", from: 0.3, to: 0.45 },
];
const STICKIES = [
  { x: 10, y: 1, fill: "#f6c945", at: 0.52 },
  { x: 10, y: 4, fill: "#ff8fb1", at: 0.62 },
];
/** The marker following the tip of each line as it's written, then resting in the corner. */
const MARKER = { times: [0, 0.05, 0.25, 0.3, 0.45, 0.52, 1], x: [12, 2, 9, 2, 7, 12, 12], y: [5, 0, 0, 2, 2, 5, 5] };

// An open notebook held under the eyes: lines get written down the right-hand page with a
// pencil, then the page turns.
const NOTEBOOK = ["WWWWWbWWWWW", "WWWWWbWWWWW", "WWWWWbWWWWW", "UUUUUUUUUUU"];
const NOTEBOOK_W = NOTEBOOK[0].length;
/** One page, in seconds. */
const PAGE_S = 3.6;
const PAGE_LINES = [
  { y: 0, w: 4, from: 0.05, to: 0.3 },
  { y: 1, w: 3, from: 0.35, to: 0.55 },
  { y: 2, w: 4, from: 0.6, to: 0.8 },
];
const PENCIL = { times: [0, 0.05, 0.3, 0.35, 0.55, 0.6, 0.8, 0.9, 1], x: [6, 6, 10, 6, 9, 6, 10, 10, 6], y: [0, 0, 0, 1, 1, 2, 2, 2, 0] };

// A briefcase carried beside a character in a suit, at Sushi's pixel size.
const BRIEFCASE = ["..hh..", ".h..h.", "CCCCCC", "CCggCC", "CCCCCC"];
const SUIT = { jacket: "#2f3640", shirt: "#ffffff", tie: "#c8283c" };

// Studying late: a desk in front of the character with an open book lying on it, and a night
// lamp on the desk to its right lighting the page. Drawn in Sushi's pixels.
// A desk lamp, its shade tipped towards the book on the left.
const LAMP = ["..NNN", ".NNNN", "NNNN.", "..i..", "...i.", "...i.", "...i.", "..iii"];
/** The bulb, under the shade's lower lip. */
const BULB = { x: 1, y: 3 };
const LAMP_W = LAMP[0].length;
const DESK = { top: "#a8743f", front: "#7a4f27" };
/** A crescent moon and the stars around it, over a night-time study. */
const MOON = [".qq", "qq.", "qq.", ".qq"];
const NIGHT_STARS = [
  { x: -6, y: -14, delay: 0 },
  { x: 14, y: -30, delay: 0.8 },
  { x: 34, y: -20, delay: 1.6 },
  { x: 52, y: -32, delay: 2.2 },
];

/** Friends who come over to say hi: one first, then two more. */
const FRIENDS = ["salmon", "tamago", "kappa-maki"];
/** One get-together, in seconds. */
const MEET_S = 8;

const COLORS: Record<string, string> = {
  S: "#f0533f", // salmon
  s: "#ff8f73", // salmon stripe
  N: "#0f5e5c", // nori
  R: "#fff8ee", // rice
  r: "#e3d1b8", // rice shade
  E: "#2b2b2b", // eyes
  P: "#f7a39b", // blush
  L: "#3d3d3d", // legs
  K: "#c9ced6", // laptop lid edge
  k: "#aeb5bf", // laptop lid
  O: "#f0533f", // laptop logo
  B: "#7d8590", // laptop base
  H: "#f0533f", // heart
  Y: "#f6c945", // sparkle
  Z: "currentColor", // sleep z
  G: "#2b2b2b", // glasses frame
  W: "#ffffff", // thought bubble
  b: "#c9ced6", // thought bubble edge
  D: "#4a4f57", // coffee machine
  d: "#6b727c", // coffee machine panel
  A: "#f0533f", // coffee machine light
  g: "#7ee0a1", // coffee machine ready light
  M: "#5b8def", // mug
  m: "#3f6fc9", // mug handle
  e: "#2f4f8f", // inside of the mug
  c: "#6b3e26", // coffee
  U: "#3b6fd8", // book cover
  u: "#2a4fa0", // book spine
  v: "#f6c945", // book title
  w: "#7cc7ff", // sweat
  I: "#3d3d3d", // dumbbell plates
  i: "#aeb5bf", // dumbbell bar
  V: "#8a6fd1", // game console
  x: "#2b2b2b", // d-pad
  o: "#f0533f", // console buttons
  n: "#7ee0a1", // console screen
  h: "#3d3d3d", // briefcase handle
  q: "#ffe7a3", // moon
  C: "#8b5a2b", // briefcase
};

const MACHINE_RUNS = runs(MACHINE);
const MUG_RUNS = runs(MUG);
const BOOK_RUNS = runs(BOOK);
const DUMBBELL_RUNS = runs(DUMBBELL);
const CONSOLE_RUNS = runs(CONSOLE);
const WHITEBOARD_RUNS = runs(WHITEBOARD);
const NOTEBOOK_RUNS = runs(NOTEBOOK);
const BRIEFCASE_RUNS = runs(BRIEFCASE, { ...COLORS, g: "#f6c945" });
const LAMP_RUNS = runs(LAMP);

/** How far left of its spot it may wander, in CSS px, and how fast it walks. */
const WANDER = 72;
const WALK_SPEED = 28;
const SLEEP_AFTER = 60_000;
/** This many clicks within DIZZY_WINDOW ms make it dizzy. */
const DIZZY_CLICKS = 8;
const DIZZY_WINDOW = 3000;
/** Eyes rolling round while dizzy, one step per frame. */
const EYE_ROLL: Look[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];
/** Points round an ellipse for the stars circling its head. */
const ORBIT = Array.from({ length: 13 }, (_, i) => (i / 12) * Math.PI * 2);

export type Run = { x: number; y: number; w: number; fill: string };

/** Horizontal runs of one colour, so each row is a few rects rather than sixteen. */
function runs(rows: string[], colors = COLORS, y0 = 0) {
  const out: Run[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let w = 1;
      while (row[x + w] === c) w++;
      if (c !== ".") out.push({ x, y: y + y0, w, fill: colors[c] });
      x += w;
    }
  });
  return out;
}

/** Everything the mascot needs to draw one character. Eyes are 2×2 and drawn on top of the body. */
export interface Character {
  width: number;
  height: number;
  /** CSS px per sprite pixel. */
  px: number;
  body: Run[];
  eyes: { x: number; y: number }[];
  eyeColor: string;
  legs: Run[][];
  /** Where the laptop goes while working, in sprite pixels, and the screen's glow on the face, if any. */
  laptop: { x: number; y: number; scale: number; glow?: { x: number; y: number; w: number; h: number } };
}

const LAPTOP_RUNS = runs(LAPTOP);

const SUSHI: Character = {
  width: SPRITE[0].length,
  height: SPRITE.length + 1,
  px: 2.5,
  body: runs(SPRITE),
  eyes: [3, 11].map((x) => ({ x, y: 5 })),
  eyeColor: COLORS.E,
  legs: LEG_FRAMES.map((row) => runs([row], COLORS, SPRITE.length)),
  laptop: { x: 0, y: 7, scale: 1, glow: { x: 1, y: 3, w: 14, h: 4 } },
};

/**
 * An avatar as a mascot. Its sprite is drawn at double resolution so the
 * eyes (one pixel in the avatar) become 2×2 and can glance and blink half a
 * pixel at a time like Sushi's. The eye pixels are painted over with their
 * neighbour, blank rows trimmed, and legs added under its bottom row: two
 * pairs under a wide base, one pair under a narrow one.
 */
function avatarCharacter(avatar: AvatarDef): Character {
  const palette: Record<string, string> = { ...avatarPalette(avatar), L: COLORS.L };
  const isEye = (c: string | undefined) => c === "E" || c === "W";
  const blank = (row: string) => !/[^.]/.test(row);

  let rows = avatar.sprite;
  while (rows.length && blank(rows[0])) rows = rows.slice(1);
  while (rows.length && blank(rows[rows.length - 1])) rows = rows.slice(0, -1);

  const eyes: { x: number; y: number }[] = [];
  let eyeColor = palette.E;
  const body = rows.map((row, y) =>
    [...row]
      .map((c, x) => {
        if (!isEye(c)) return c;
        eyes.push({ x: x * 2, y: y * 2 });
        eyeColor = palette[c];
        return [row[x - 1], row[x + 1]].find((n) => n && n !== "." && !isEye(n)) ?? ".";
      })
      .join(""),
  );
  const big = body.flatMap((row) => {
    const doubled = [...row].map((c) => c + c).join("");
    return [doubled, doubled];
  });

  const width = big[0].length;
  const bottom = big[big.length - 1];
  const left = bottom.search(/[^.]/);
  const right = bottom.length - [...bottom].reverse().join("").search(/[^.]/);
  const span = right - left;
  const feet = span >= 14 ? [left + span / 4, left + (span * 3) / 4] : [left + span / 2];
  // Each leg is 2×2: apart (a gap between them), then together.
  const legRow = (offsets: number[]) => {
    const row = Array<string>(width).fill(".");
    for (const c of feet)
      for (const o of offsets)
        for (const i of [0, 1]) {
          const x = Math.round(c + o) + i;
          if (x >= 0 && x < width) row[x] = "L";
        }
    return row.join("");
  };
  const legs = [legRow([-3, 1]), legRow([-2, 0])].map((row) => runs([row, row], palette, big.length));

  const px = 1.5;
  // The laptop at Sushi's size, centred, its top just under the eyes.
  const scale = SUSHI.px / px;
  const eyeBottom = Math.max(...eyes.map((e) => e.y + 2), 0);
  const laptop = {
    x: (width - LAPTOP_W * scale) / 2,
    y: Math.min(eyeBottom, big.length + 2 - LAPTOP.length * scale),
    scale,
  };

  return { width, height: big.length + 2, px, body: runs(big, palette), eyes, eyeColor, legs, laptop };
}

const characters = new Map<string, Character>([[DEFAULT_MASCOT, SUSHI]]);

export function characterFor(key: string): Character {
  let c = characters.get(key);
  if (!c) {
    const avatar = AVATARS.find((a) => a.key === key);
    if (!avatar) return SUSHI;
    c = avatarCharacter(avatar);
    characters.set(key, c);
  }
  return c;
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Glasses fitted to a character's eyes: a square lens around each eye, big
 * enough for the eye to glance a pixel any way inside it (smaller when the eyes
 * sit close), a bridge between neighbouring lenses and a stub of each arm.
 * One eye gets a monocle.
 */
function glassesFor(c: Character): { frame: Run[]; lenses: Rect[] } {
  const eyes = [...c.eyes].sort((a, b) => a.x - b.x);
  const closest = Math.min(7, ...eyes.slice(1).map((e, i) => e.x - eyes[i].x));
  const r = Math.max(2, Math.min(3, Math.floor((closest - 1) / 2)));
  const lenses = eyes.map((e) => ({ x: e.x + 1 - r, y: e.y + 1 - r, w: 2 * r, h: 2 * r }));
  const frame: Run[] = [];
  const fill = COLORS.G;
  for (const l of lenses) {
    frame.push({ x: l.x, y: l.y, w: l.w, fill }, { x: l.x, y: l.y + l.h - 1, w: l.w, fill });
    for (let y = l.y + 1; y < l.y + l.h - 1; y++) frame.push({ x: l.x, y, w: 1, fill }, { x: l.x + l.w - 1, y, w: 1, fill });
  }
  lenses.slice(1).forEach((l, i) => {
    const gap = l.x - (lenses[i].x + lenses[i].w);
    if (gap > 0) frame.push({ x: lenses[i].x + lenses[i].w, y: l.y + 1, w: gap, fill });
  });
  const first = lenses[0];
  const last = lenses[lenses.length - 1];
  if (first && first.x > 0) frame.push({ x: first.x - 1, y: first.y + 1, w: 1, fill });
  if (last && last.x + last.w < c.width) frame.push({ x: last.x + last.w, y: last.y + 1, w: 1, fill });
  return { frame, lenses };
}

const glassesCache = new WeakMap<Character, ReturnType<typeof glassesFor>>();
function glassesOf(c: Character) {
  let g = glassesCache.get(c);
  if (!g) glassesCache.set(c, (g = glassesFor(c)));
  return g;
}

/** Where a character's body ends and its legs begin, in its sprite pixels. */
const legTop = (c: Character) => Math.min(...c.legs[0].map((r) => r.y));

/**
 * A suit fitted to a character: the bottom of its body in a dark jacket, with a white shirt
 * collar and a red tie down the middle. Sized in Sushi's pixels, so an avatar's is as big.
 */
function suitFor(c: Character): Run[] {
  const s = Math.max(1, Math.round(SUSHI.px / c.px));
  const bottom = legTop(c) - 1;
  const top = bottom - 3 * s + 1;
  const out: Run[] = c.body.filter((r) => r.y >= top && r.y <= bottom).map((r) => ({ ...r, fill: SUIT.jacket }));
  const cx = Math.round(c.width / 2);
  // [x from the middle, row, width, colour], in Sushi pixels.
  const parts: [number, number, number, string][] = [
    [-3, 0, 6, SUIT.shirt],
    [-2, 1, 1, SUIT.shirt],
    [1, 1, 1, SUIT.shirt],
    [-1, 0, 2, SUIT.tie],
    [-1, 1, 2, SUIT.tie],
    [-1, 2, 2, SUIT.tie],
  ];
  for (const [dx, row, w, fill] of parts)
    for (let i = 0; i < s; i++) out.push({ x: cx + dx * s, y: top + row * s + i, w: w * s, fill });
  return out;
}
const suitCache = new WeakMap<Character, Run[]>();
function suitOf(c: Character) {
  let suit = suitCache.get(c);
  if (!suit) suitCache.set(c, (suit = suitFor(c)));
  return suit;
}

/** A ghost's wavy hem in place of legs: every other pixel along its bottom edge, shifting each frame. */
function ghostHem(c: Character, frame: number): Run[] {
  const bottom = legTop(c) - 1;
  const out: Run[] = [];
  for (const r of c.body.filter((b) => b.y === bottom))
    for (let x = r.x; x < r.x + r.w; x++) {
      if ((x + frame) % 2 === 0) out.push({ x, y: bottom + 1, w: 1, fill: r.fill });
      if ((x + frame) % 4 === 0) out.push({ x, y: bottom + 2, w: 1, fill: r.fill });
    }
  return out;
}

export function Pixels({ runs }: { runs: Run[] }) {
  return runs.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />);
}

/** A small pixel sprite (heart, z) drawn at the given pixel size. */
function Glyph({ rows, px = 2, className }: { rows: string[]; px?: number; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${rows[0].length} ${rows.length}`}
      width={rows[0].length * px}
      height={rows.length * px}
      shapeRendering="crispEdges"
      className={className}
    >
      <Pixels runs={runs(rows)} />
    </svg>
  );
}

type Look = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

const sign = (d: number, dead: number): -1 | 0 | 1 => (d < -dead ? -1 : d > dead ? 1 : 0);

/** A character standing still, eyes front, e.g. for the picker in Settings. */
export function MascotSprite({ kind, scale = 1, closed, className }: { kind: string; scale?: number; closed?: boolean; className?: string }) {
  const c = characterFor(kind);
  return (
    <svg
      viewBox={`0 0 ${c.width} ${c.height}`}
      width={c.width * c.px * scale}
      height={c.height * c.px * scale}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      <Pixels runs={c.body} />
      {c.eyes.map((e) => (
        <rect key={`${e.x},${e.y}`} x={e.x} y={e.y + (closed ? 1 : 0)} width={2} height={closed ? 1 : 2} fill={c.eyeColor} />
      ))}
      <Pixels runs={c.legs[0]} />
    </svg>
  );
}

/**
 * Sushi's body in sprite pixels, for scenes drawn elsewhere (`compact-sushi.tsx`,
 * `image-tv.tsx`). Happy closed eyes unless `look` opens them, glancing that way
 * by a pixel; `legs` adds the walk cycle's frame under it.
 */
export function SushiPixels({ look, legs }: { look?: { x: number; y: number }; legs?: number } = {}) {
  return (
    <>
      <Pixels runs={SUSHI.body} />
      {SUSHI.eyes.map((e) =>
        look ? (
          <rect key={e.x} x={e.x + look.x} y={e.y + look.y} width={2} height={2} fill={COLORS.E} />
        ) : (
          <rect key={e.x} x={e.x} y={e.y + 1} width={2} height={1} fill={COLORS.E} />
        ),
      )}
      {legs !== undefined && <Pixels runs={SUSHI.legs[legs % SUSHI.legs.length]} />}
    </>
  );
}

/** Rows of pixel characters as rects, with Sushi's palette plus any extra colours. */
export function PixelRows({ rows, colors, y = 0 }: { rows: string[]; colors?: Record<string, string>; y?: number }) {
  return <Pixels runs={runs(rows, colors ? { ...COLORS, ...colors } : COLORS, y)} />;
}

/** What a running reply is doing right now; each one has its own act. */
export type MascotStage = "thinking" | "tools" | "writing";

type Mood = "idle" | MascotStage;

/** Something to do between replies, played on request (Settings → Sushi). */
export type MascotAct =
  | "coffee"
  | "read"
  | "dance"
  | "nap"
  | "workout"
  | "juggle"
  | "meditate"
  | "game"
  // Scenes for Home's tiles on a phone (`phone.tsx`), not offered in Settings → Sushi.
  | "whiteboard"
  | "notebook"
  | "suit"
  | "ghost"
  | "friends"
  | "study";

interface MascotProps {
  busy: boolean;
  /** An activity to act out while idle; a running reply takes over. */
  act?: MascotAct;
  /** The stage of the running reply; just "tools" (the laptop) when left out. */
  stage?: MascotStage;
  draft: string;
  /** Which character; the one picked in Settings when left out. */
  kind?: string;
  /** Stays on its spot and awake, e.g. as a node in the sub-agent graph. */
  still?: boolean;
  className?: string;
}

export function Mascot({ kind, ...props }: MascotProps) {
  const picked = useMascot();
  const key = kind ?? picked;
  // Celebrate a switch, but not the first appearance (or a remount when the composer's menus close).
  const [shown, setShown] = useState(key);
  const [switched, setSwitched] = useState(false);
  if (shown !== key) {
    setShown(key);
    setSwitched(true);
  }
  return <MascotBody key={key} character={characterFor(key)} entrance={switched} {...props} />;
}

/**
 * The desk in front of a studying character (`width` CSS px wide, its eyes `eyesFromFloor` CSS px
 * up): the desktop a Sushi pixel under its eyes with an open book lying on it, legs to the floor,
 * and a night lamp at the right-hand end shining a flickering cone of light onto the page.
 */
function StudyDesk({ width, eyesFromFloor, reduceMotion }: { width: number; eyesFromFloor: number; reduceMotion: boolean }) {
  const u = SUSHI.px;
  const body = Math.ceil(width / u);
  const w = body + 2 + LAMP_W + 1;
  // Rows of desk under the book: from a pixel below the eyes down to the floor.
  const deskRows = Math.max(2, Math.round(eyesFromFloor / u) - 2);
  const top = LAMP.length; // the desktop's row, under the lamp's base
  const rows = top + deskRows;
  const lampX = w - LAMP_W;
  const book = { x: 1 + Math.max(0, Math.round(body / 2) - 3), w: 7 };
  const bulb = { x: lampX + BULB.x, y: BULB.y };
  return (
    <svg
      viewBox={`0 0 ${w} ${rows}`}
      width={w * u}
      height={rows * u}
      shapeRendering="crispEdges"
      className="pointer-events-none absolute bottom-0"
      style={{ left: -u }}
      aria-hidden
    >
      {/* The light falling from the bulb onto the book. */}
      <motion.polygon
        points={`${bulb.x},${bulb.y + 1} ${bulb.x + 1},${bulb.y + 1} ${book.x + book.w + 1},${top} ${book.x - 1},${top}`}
        fill="rgb(255 214 110)"
        shapeRendering="auto"
        animate={reduceMotion ? { opacity: 0.35 } : { opacity: [0.3, 0.42, 0.34, 0.45, 0.3] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* The desk: its top, the apron under it, and two legs. */}
      <rect x={0} y={top} width={w} height={1} fill={DESK.top} />
      <rect x={0} y={top + 1} width={w} height={1} fill={DESK.front} />
      <rect x={1} y={top + 2} width={1} height={deskRows - 2} fill={DESK.front} />
      <rect x={w - 2} y={top + 2} width={1} height={deskRows - 2} fill={DESK.front} />
      {/* The open book lying on it, lines of text on its pages, a page turning now and then. */}
      <rect x={book.x} y={top - 1} width={book.w} height={1} fill={COLORS.W} />
      <rect x={book.x + 1} y={top - 1} width={1} height={1} fill={COLORS.k} />
      <rect x={book.x + 3} y={top - 1} width={1} height={1} fill={COLORS.B} />
      <rect x={book.x + 5} y={top - 1} width={1} height={1} fill={COLORS.k} />
      <rect x={book.x - 1} y={top - 1} width={1} height={1} fill={COLORS.U} />
      <rect x={book.x + book.w} y={top - 1} width={1} height={1} fill={COLORS.U} />
      {!reduceMotion && (
        <motion.rect
          y={top - 2}
          width={1}
          height={1}
          fill={COLORS.W}
          initial={{ x: book.x + book.w - 1, opacity: 0 }}
          animate={{ x: [book.x + book.w - 1, book.x + 3, book.x], y: [top - 1, top - 2, top - 1], opacity: [0, 1, 0] }}
          transition={{ duration: 0.6, repeat: Infinity, repeatDelay: 4, ease: "easeInOut" }}
        />
      )}
      <g transform={`translate(${lampX} 0)`}>
        <Pixels runs={LAMP_RUNS} />
      </g>
      {/* The bulb, glowing under the shade. */}
      <motion.rect
        x={bulb.x}
        y={bulb.y}
        width={1}
        height={1}
        fill="#fff3c4"
        animate={reduceMotion ? { opacity: 1 } : { opacity: [1, 0.75, 1, 0.9, 1] }}
        transition={{ duration: 3, repeat: Infinity }}
      />
    </svg>
  );
}

const SPARKS = [
  { x: -18, y: -14 },
  { x: 18, y: -16 },
  { x: -22, y: 2 },
  { x: 22, y: 0 },
  { x: 0, y: -24 },
];

function MascotBody({
  busy,
  act,
  stage,
  draft,
  still,
  className,
  character,
  entrance,
}: Omit<MascotProps, "kind"> & { character: Character; entrance: boolean }) {
  const { width, height, px, body, eyes, eyeColor, legs, laptop } = character;
  const glasses = glassesOf(character);
  const mood: Mood = busy ? (stage ?? "tools") : "idle";
  const laptopOut = mood === "tools" || mood === "writing";
  const activity = busy ? null : (act ?? null);
  const dancing = activity === "dance";
  const rootRef = useRef<HTMLDivElement>(null);
  // Off screen (a Home tile scrolled away) or in the background, Sushi holds still: its loops
  // and frame timers otherwise run for nothing, and on a phone keep the CPU and screen busy.
  const inView = useInView(rootRef, { initial: true });
  const pageVisible = usePageInView();
  const paused = !inView || !pageVisible;
  const reduceMotion = useReducedMotion() || paused;
  const motionConfig = useContext(MotionConfigContext).reducedMotion;
  const hopControls = useAnimationControls();

  const [blink, setBlink] = useState(false);
  const [pointerLook, setPointerLook] = useState<Look>({ x: 0, y: 0 });
  const [typing, setTyping] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [frame, setFrame] = useState(0);
  const [glance, setGlance] = useState(false);
  const [x, setX] = useState(0);
  const [walking, setWalking] = useState(false);
  const [hearts, setHearts] = useState<number[]>([]);
  const [sparks, setSparks] = useState(entrance && !reduceMotion);
  const [ponder, setPonder] = useState(false);
  const [dizzy, setDizzy] = useState<"reeling" | "down" | null>(null);
  const [coffee, setCoffee] = useState<"brew" | "drink" | null>(null);
  const [sip, setSip] = useState(false);
  const asleep = sleeping || activity === "nap";
  // Workout: up on true, down on false.
  const [lift, setLift] = useState(false);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const prevMood = useRef<Mood>(mood);
  const sleepingRef = useRef(sleeping);
  sleepingRef.current = sleeping;
  const lastActivity = useRef(Date.now());
  const clicks = useRef<number[]>([]);
  const pokes = useRef<number[]>([]);
  // Bumped to call off a dizzy spell in progress; set while one is going.
  const dizzyRun = useRef(0);
  const dizzyRef = useRef(false);
  useEffect(
    () => () => {
      dizzyRun.current++;
    },
    [],
  );

  // Blink every few seconds, at slightly random intervals, sometimes twice.
  useEffect(() => {
    if (reduceMotion || asleep) return;
    let timer: ReturnType<typeof setTimeout>;
    const blinkOnce = (then: () => void) => {
      setBlink(true);
      timer = setTimeout(() => {
        setBlink(false);
        then();
      }, 140);
    };
    const next = () => {
      timer = setTimeout(
        () => blinkOnce(() => (Math.random() < 0.2 ? (timer = setTimeout(() => blinkOnce(next), 120)) : next())),
        2500 + Math.random() * 3500,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [reduceMotion, asleep]);

  // Follow the pointer with the eyes; any activity resets the sleep clock and wakes it.
  useEffect(() => {
    if (reduceMotion) return;
    let frame = 0;
    const wake = () => {
      lastActivity.current = Date.now();
      if (sleepingRef.current) {
        setSleeping(false);
        void hopControls.start({ y: [0, -7, 0], transition: { duration: 0.3, ease: "easeOut" } });
      }
    };
    const onMove = (e: PointerEvent) => {
      wake();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        const look: Look = {
          x: sign(e.clientX - (rect.left + rect.width / 2), 24),
          y: sign(e.clientY - (rect.top + rect.height / 2), 24),
        };
        setPointerLook((prev) => (prev.x === look.x && prev.y === look.y ? prev : look));
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    const idle = setInterval(() => {
      if (!still && !busyRef.current && !activityRef.current && !sleepingRef.current && !dizzyRef.current && Date.now() - lastActivity.current > SLEEP_AFTER) setSleeping(true);
    }, 5000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(idle);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [reduceMotion, hopControls, still]);

  // Watch the input while the user is typing.
  useEffect(() => {
    if (!draft) return setTyping(false);
    setTyping(true);
    const t = setTimeout(() => setTyping(false), 1000);
    return () => clearTimeout(t);
  }, [draft]);

  // Each stage gets its own motion. Thinking: a little hop as the glasses go
  // on, then the head rocks side to side. Tools and writing: a hop as the
  // laptop comes up, then a gentle bob in time with the typing (quicker while
  // writing). Done: a small satisfied hop as the glasses come off.
  useEffect(() => {
    const from = prevMood.current;
    prevMood.current = mood;
    if (busy) setSleeping(false);
    if (reduceMotion) return;
    const settle = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, rotateX: 0 };
    if (mood === "idle") {
      if (entrance && from === "idle") {
        // Pop in: drop from a little above, squash on landing, wobble upright.
        void hopControls.start({
          y: [-18, 0, -4, 0],
          scaleX: [0.6, 1.2, 0.95, 1],
          scaleY: [1.3, 0.8, 1.05, 1],
          rotate: [0, -8, 4, 0],
          opacity: [0, 1, 1, 1],
          transition: { duration: 0.55, times: [0, 0.45, 0.75, 1], ease: "easeOut" },
        });
      } else if (from !== "idle") {
        void hopControls.start({
          ...settle,
          y: [0, -6, 0, -2, 0],
          transition: { duration: 0.5, times: [0, 0.3, 0.6, 0.8, 1], ease: "easeOut" },
        });
      } else void hopControls.start({ ...settle, transition: { duration: 0.2 } });
      return;
    }
    // Pull up the laptop (or put on the glasses) with a hop, unless already at it.
    const hop = from === "idle" || laptopOut !== (from === "tools" || from === "writing");
    const intro = hop
      ? hopControls.start({ ...settle, y: [0, -5, 0], transition: { duration: 0.3, ease: "easeOut" } })
      : Promise.resolve();
    void intro.then(() => {
      if (moodRef.current !== mood) return;
      void hopControls.start(
        mood === "thinking"
          ? {
              y: 0,
              scaleX: 1,
              scaleY: 1,
              rotate: [0, -4, 0, 4, 0],
              transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" },
            }
          : {
              rotate: 0,
              y: [0, 0.5, 0],
              scaleY: [1, 0.97, 1],
              scaleX: [1, 1.015, 1],
              transition: { duration: mood === "writing" ? 0.36 : 0.5, repeat: Infinity, ease: "easeInOut" },
            },
      );
    });
  }, [mood, busy, laptopOut, reduceMotion, hopControls, entrance]);

  // While thinking, the eyes drift up to one side, then the other; while
  // reading, they run along the lines the same way.
  const scanning =
    mood === "thinking" || activity === "read" || activity === "juggle" || activity === "notebook" || activity === "study";
  useEffect(() => {
    if (reduceMotion || !scanning) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          setPonder((p) => !p);
          next();
        },
        1200 + Math.random() * 1400,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [scanning, reduceMotion]);

  // A coffee break: the machine fills the mug while the character watches,
  // then a hop as it takes the mug, and sips every few seconds after that.
  useEffect(() => {
    if (activity !== "coffee") return setCoffee(null);
    setCoffee("brew");
    const t = setTimeout(
      () => {
        setCoffee("drink");
        if (!reduceMotion) void hopControls.start({ y: [0, -6, 0], transition: { duration: 0.3, ease: "easeOut" } });
      },
      reduceMotion ? 0 : BREW_MS,
    );
    return () => clearTimeout(t);
  }, [activity, reduceMotion, hopControls]);

  useEffect(() => {
    if (reduceMotion || coffee !== "drink") return setSip(false);
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          setSip(true);
          timer = setTimeout(() => {
            setSip(false);
            next();
          }, 1100);
        },
        1400 + Math.random() * 1400,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [coffee, reduceMotion]);

  // Dancing sways side to side on the beat; reading rocks gently. Both settle
  // when they stop (a reply starting puts on its own motion after this).
  useEffect(() => {
    if (reduceMotion || !activity || activity === "coffee" || activity === "nap" || activity === "workout") return;
    const loops: Record<typeof activity, TargetAndTransition> = {
      dance: {
        x: [0, -3, 0, 3, 0],
        y: [0, -3, 0, -3, 0],
        rotate: [0, -8, 0, 8, 0],
        scaleY: [1, 0.94, 1, 0.94, 1],
        transition: { duration: 1, repeat: Infinity, ease: "easeInOut" },
      },
      read: { rotate: [0, -2, 0, 2, 0], transition: { duration: 5, repeat: Infinity, ease: "easeInOut" } },
      // A little bounce in time with the throws.
      juggle: { y: [0, 1, 0], scaleY: [1, 0.96, 1], transition: { duration: 0.4, repeat: Infinity, ease: "easeInOut" } },
      // Floating off the ground, rising and sinking with the breath.
      meditate: { y: [-4, -9, -4], rotate: 0, transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" } },
      // Leaning into the game, button-mashing.
      game: { y: [0, 0.5, 0], rotate: [0, -3, 0, 3, 0], transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" } },
      // Leaning towards the board as it writes.
      whiteboard: { rotate: [0, 3, 1, 3, 0], transition: { duration: 1.5, repeat: Infinity, ease: "easeInOut" } },
      // A little nod with each word.
      notebook: { y: [0, 0.5, 0], transition: { duration: 0.6, repeat: Infinity, ease: "easeInOut" } },
      // Walking to work, briefcase in hand.
      suit: { y: [0, -1, 0], transition: { duration: 0.3, repeat: Infinity, ease: "easeInOut" } },
      // Floating, and fading nearly out of sight now and then.
      ghost: { y: [-2, -6, -2], opacity: [0.8, 0.8, 0.3, 0.8], transition: { duration: 3.6, repeat: Infinity, ease: "easeInOut" } },
      // Swaying a little over the book, late at night.
      study: { rotate: [0, -1.5, 0, 1.5, 0], transition: { duration: 6, repeat: Infinity, ease: "easeInOut" } },
      // Two hops for joy once everyone's arrived.
      friends: {
        y: [0, 0, -5, 0, -5, 0, 0],
        transition: { duration: MEET_S, times: [0, 0.6, 0.64, 0.68, 0.72, 0.76, 1], repeat: Infinity, ease: "easeOut" },
      },
    };
    void hopControls.start(loops[activity]);
    return () => {
      void hopControls.start({ x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, opacity: 1, transition: { duration: 0.25 } });
    };
  }, [activity, reduceMotion, hopControls]);

  // Workout: press the dumbbell up and down, squashing with the effort.
  useEffect(() => {
    if (reduceMotion || activity !== "workout") return setLift(false);
    const id = setInterval(() => setLift((l) => !l), REP_MS);
    return () => {
      clearInterval(id);
      void hopControls.start({ scaleX: 1, scaleY: 1, transition: { duration: 0.2 } });
    };
  }, [activity, reduceMotion, hopControls]);
  useEffect(() => {
    if (reduceMotion || activity !== "workout") return;
    void hopControls.start(
      lift
        ? { scaleY: 0.92, scaleX: 1.05, y: 0, rotate: 0, transition: { duration: REP_MS / 2000, ease: "easeOut" } }
        : { scaleY: 1, scaleX: 1, y: 0, rotate: 0, transition: { duration: REP_MS / 2000, ease: "easeOut" } },
    );
  }, [lift, activity, reduceMotion, hopControls]);

  // Gaming: every few seconds it wins a level and sparkles go off.
  useEffect(() => {
    if (reduceMotion || activity !== "game") return;
    const id = setInterval(() => setSparks(true), 5000);
    return () => clearInterval(id);
  }, [activity, reduceMotion]);

  // Every few seconds at the laptop, glance up from the screen for a moment.
  useEffect(() => {
    if (reduceMotion || !laptopOut) return setGlance(false);
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          setGlance(true);
          timer = setTimeout(() => {
            setGlance(false);
            next();
          }, 700);
        },
        3000 + Math.random() * 3000,
      );
    };
    next();
    return () => clearTimeout(timer);
  }, [laptopOut, reduceMotion]);

  // One frame counter drives the walking legs, the typing hands and the rolling eyes.
  const gaming = activity === "game";
  const ghost = activity === "ghost";
  const commuting = activity === "suit";
  const moving = walking || laptopOut || dancing || gaming || ghost || commuting || dizzy !== null;
  const frameMs =
    dizzy === "reeling"
      ? 80
      : dizzy === "down"
        ? 130
        : walking || commuting
          ? 150
          : dancing
            ? 250
            : ghost
              ? 300
              : gaming
                ? 140
                : mood === "writing"
                  ? 90
                  : 120;
  useEffect(() => {
    if (reduceMotion || !moving) return setFrame(0);
    const id = setInterval(() => setFrame((f) => f + 1), frameMs);
    return () => clearInterval(id);
  }, [moving, frameMs, reduceMotion]);

  // Every so often, stroll somewhere along the composer's edge (or back home).
  useEffect(() => {
    if (reduceMotion || still || walking || busy || activity || sleeping || dizzy) return;
    const t = setTimeout(
      () => {
        let target = x !== 0 && Math.random() < 0.6 ? 0 : -Math.round(Math.random() * WANDER);
        if (Math.abs(target - x) < 12) target = x === 0 ? -WANDER / 2 : 0;
        setWalking(true);
        setX(target);
      },
      9000 + Math.random() * 12000,
    );
    return () => clearTimeout(t);
  }, [reduceMotion, still, walking, busy, activity, sleeping, dizzy, x]);

  const [walkFrom, setWalkFrom] = useState(0);
  useEffect(() => {
    if (!walking) setWalkFrom(x);
  }, [walking, x]);
  const walkDir = sign(x - walkFrom, 0);

  // Once the last heart has floated off: reel with the eyes rolling, fall flat
  // on its back with a "whoa" and a thud, lie there seeing stars (birds
  // tweeting), then spring back up and shake it off. Called off (the pose
  // settled by the mood effect, the sounds cut) if a run starts.
  const getDizzy = async () => {
    const run = ++dizzyRun.current;
    const on = () => dizzyRun.current === run && !busyRef.current;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sounds = mascotSounds() ? fallSounds() : null;
    dizzyRef.current = true;
    try {
      await wait(700);
      if (!on()) return;
      setDizzy("reeling");
      await hopControls.start({
        x: [0, -3, 3, -4, 2, 0],
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotate: [0, -10, 9, -14, 8, -18],
        transition: { duration: 1.5, ease: "easeInOut" },
      });
      if (!on()) return;
      setDizzy("down");
      // Stiff as a board, tipping back about its feet (the top going away
      // into the screen), bouncing once on landing.
      sounds?.whoa();
      const fall = hopControls.start({
        x: 0,
        rotate: [-18, 0, 0, 0, 0],
        rotateX: [0, -12, 82, 68, 78],
        y: [0, -4, 0, -3, 0],
        transition: { duration: 0.75, times: [0, 0.2, 0.6, 0.8, 1], ease: ["easeOut", "easeIn", "easeOut", "easeIn"] },
      });
      const landed = setTimeout(() => on() && sounds?.thud(), 450);
      await fall;
      clearTimeout(landed);
      if (!on()) return;
      sounds?.tweets(2.8);
      await wait(2800);
      if (!on()) return;
      setDizzy(null);
      await hopControls.start({
        rotateX: [78, 0, 0, 0],
        y: [0, -12, 0, 0],
        scaleY: [1, 1.1, 0.85, 1],
        transition: { duration: 0.6, times: [0, 0.45, 0.75, 1], ease: "easeOut" },
      });
      if (!on()) return;
      await hopControls.start({ rotate: [0, -7, 7, -4, 4, 0], transition: { duration: 0.5, ease: "easeInOut" } });
    } finally {
      sounds?.stop();
      if (dizzyRun.current === run) {
        dizzyRef.current = false;
        setDizzy(null);
      }
    }
  };

  const onClick = () => {
    if (reduceMotion || dizzyRef.current) return;
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 900), now];
    pokes.current = [...pokes.current.filter((t) => now - t < DIZZY_WINDOW), now];
    setHearts((h) => [...h, now]);
    // Busy with a reply or an activity: a heart, but no hop to break the act.
    if (busy || activity) return;
    if (pokes.current.length >= DIZZY_CLICKS) {
      pokes.current = [];
      clicks.current = [];
      if (mascotSounds()) audio(); // unlocked by this click, ready when the fall begins
      void getDizzy();
    }
    if (clicks.current.length >= 3) {
      clicks.current = [];
      void hopControls.start({
        y: [0, -16, 0],
        rotate: [0, -360],
        transition: { duration: 0.6, ease: [0.3, 0, 0.3, 1] },
      });
    } else {
      void hopControls.start({
        y: [0, 1, -10, 0],
        scaleY: [1, 0.82, 1.12, 1],
        scaleX: [1, 1.14, 0.92, 1],
        rotate: [0, 0, -6, 0],
        transition: { duration: 0.45, times: [0, 0.15, 0.55, 1], ease: "easeOut" },
      });
    }
  };

  // Happy closed eyes while sipping, dancing and meditating; a squint on each press.
  const closed = !dizzy && (asleep || blink || sip || dancing || activity === "meditate" || (activity === "workout" && lift));
  const look: Look = dizzy
    ? EYE_ROLL[frame % EYE_ROLL.length]
    : asleep
    ? { x: 0, y: 1 }
    : coffee === "brew"
    ? { x: 1, y: 0 }
    : coffee === "drink"
    ? { x: 0, y: 1 }
    : activity === "read"
    ? { x: ponder ? 1 : -1, y: 1 }
    : activity === "juggle"
    ? { x: ponder ? 1 : -1, y: -1 }
    : activity === "workout"
    ? { x: 0, y: lift ? -1 : 0 }
    : activity === "notebook"
    ? { x: ponder ? 1 : 0, y: 1 }
    : activity === "study"
    ? { x: ponder ? 1 : -1, y: 1 }
    : activity === "whiteboard" || activity === "friends"
    ? { x: 1, y: 0 }
    : gaming
    ? { x: 0, y: 1 }
    : walking
      ? { x: walkDir, y: 0 }
      : mood === "thinking"
        ? { x: ponder ? 1 : -1, y: -1 }
        : laptopOut
          ? glance
            ? { x: 1, y: -1 }
            : { x: 0, y: 0 }
          : typing
          ? { x: -1, y: 1 }
          : pointerLook;
  const hands = HAND_FRAMES[frame % HAND_FRAMES.length];
  /** Where a prop `w` Sushi-pixels wide sits when held, centred where the laptop goes. */
  const heldAt = (w: number) => ({ x: laptop.x + ((LAPTOP_W - w) * laptop.scale) / 2 });

  return (
    // Paused, the props' own loops (a whiteboard's marker, a lamp's flicker) stop moving too.
    <MotionConfig reducedMotion={paused ? "always" : motionConfig}>
    <motion.div
      ref={rootRef}
      aria-hidden
      title="Sushi"
      animate={{ x }}
      transition={{ duration: Math.max(0.3, Math.abs(x - walkFrom) / WALK_SPEED), ease: "linear" }}
      onAnimationComplete={() => setWalking(false)}
      onClick={onClick}
      className={cn("relative cursor-pointer select-none", className)}
    >
      {hearts.map((id) => (
        <motion.div
          key={id}
          className="pointer-events-none absolute left-1/2 -top-2 -ml-1.25"
          initial={{ y: 0, opacity: 1, scale: 0.6 }}
          animate={{ y: -22, x: (id % 3) * 4 - 4, opacity: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          onAnimationComplete={() => setHearts((h) => h.filter((v) => v !== id))}
        >
          <Glyph rows={HEART} />
        </motion.div>
      ))}
      {sparks &&
        SPARKS.map((s, i) => (
          <motion.div
            key={i}
            className="pointer-events-none absolute top-1/2 left-1/2 -mt-0.75 -ml-0.75"
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4, rotate: 0 }}
            animate={{ x: s.x, y: s.y, opacity: [0, 1, 0], scale: [0.4, 1.2, 0.6], rotate: 90 }}
            transition={{ duration: 0.7, delay: 0.15 + i * 0.03, ease: "easeOut" }}
            onAnimationComplete={() => i === SPARKS.length - 1 && setSparks(false)}
          >
            <Glyph rows={STAR} />
          </motion.div>
        ))}
      {dancing &&
        !reduceMotion &&
        [0, 1].map((i) => (
          <motion.div
            key={`note${i}`}
            className={cn("pointer-events-none absolute -top-1 text-brand", i ? "left-0" : "right-0")}
            initial={{ opacity: 0 }}
            animate={{ x: i ? [0, -4, -8] : [0, 4, 8], y: [0, -10, -22], opacity: [0, 1, 0], rotate: i ? [0, -15] : [0, 15] }}
            transition={{ duration: 1.8, delay: i * 0.9, repeat: Infinity, ease: "easeOut" }}
          >
            <Glyph rows={NOTE} px={2} />
          </motion.div>
        ))}
      {activity === "workout" &&
        !reduceMotion &&
        [0, 1].map((i) => (
          // Sweat flying off either side of the head.
          <motion.div
            key={`drop${i}`}
            className={cn("pointer-events-none absolute top-0", i ? "left-0" : "right-0")}
            initial={{ opacity: 0 }}
            animate={{ x: i ? [0, -6, -10] : [0, 6, 10], y: [0, -6, 2], opacity: [0, 1, 0] }}
            transition={{ duration: 0.9, delay: i * 0.65, repeat: Infinity, repeatDelay: 0.4, ease: "easeOut" }}
          >
            <Glyph rows={DROP} px={1.5} />
          </motion.div>
        ))}
      {activity === "juggle" &&
        BALLS.map((color, i) => (
          // Each ball loops up over the head from one hand to the other and back low, a third of a cycle apart.
          <motion.div
            key={color}
            className="pointer-events-none absolute left-1/2 -ml-1 size-2"
            style={{ top: height * px * 0.45, background: color }}
            initial={{ opacity: 0 }}
            animate={
              reduceMotion
                ? { opacity: 1, x: (i - 1) * 10, y: -18 }
                : { opacity: 1, x: [-12, -6, 0, 6, 12, 0, -12], y: [0, -24, -30, -24, 0, 4, 0] }
            }
            transition={reduceMotion ? { duration: 0.2 } : { duration: 1.5, delay: (i * 1.5) / 3, repeat: Infinity, ease: "linear" }}
          />
        ))}
      {activity === "meditate" &&
        !reduceMotion &&
        [0, 1].map((i) => (
          // A calm glow breathing out behind it.
          <motion.div
            key={`aura${i}`}
            className="pointer-events-none absolute left-1/2 rounded-full border-2 border-brand/40"
            style={{ width: width * px, height: width * px, marginLeft: (-width * px) / 2, bottom: 0 }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: [0, 0.8, 0], scale: [0.6, 1.4] }}
            transition={{ duration: 3.2, delay: i * 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        ))}
      {activity === "study" && (
        <>
          {/* The lamp's warm glow behind it, breathing a little. */}
          <motion.div
            className="pointer-events-none absolute rounded-full"
            style={{
              width: width * px * 2.6,
              height: width * px * 2.6,
              left: width * px * 0.75 - width * px * 1.3,
              bottom: -width * px * 0.7,
              background: "radial-gradient(circle, rgb(255 210 120 / 0.45), transparent 65%)",
            }}
            animate={reduceMotion ? { opacity: 0.8 } : { opacity: [0.7, 1, 0.8, 1, 0.7] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          />
          <div className="pointer-events-none absolute" style={{ left: -2, top: -24 }}>
            <Glyph rows={MOON} px={2.5} />
          </div>
          {NIGHT_STARS.map((st) => (
            <motion.div
              key={st.x}
              className="pointer-events-none absolute"
              style={{ left: st.x, top: st.y }}
              animate={reduceMotion ? { opacity: 0.8 } : { opacity: [0.2, 1, 0.2], scale: [0.7, 1, 0.7] }}
              transition={{ duration: 2.4, delay: st.delay, repeat: Infinity, ease: "easeInOut" }}
            >
              <Glyph rows={STAR} px={1} />
            </motion.div>
          ))}
        </>
      )}
      {activity === "whiteboard" && (
        // The whiteboard beside it: two lines written with the marker, two sticky notes, wiped.
        <svg
          viewBox={`0 0 ${WHITEBOARD[0].length} ${WHITEBOARD.length}`}
          width={WHITEBOARD[0].length * SUSHI.px}
          height={WHITEBOARD.length * SUSHI.px}
          shapeRendering="crispEdges"
          className="pointer-events-none absolute bottom-0 left-full ml-1"
        >
          <Pixels runs={WHITEBOARD_RUNS} />
          {BOARD_LINES.map((l) => (
            <motion.rect
              key={l.y}
              x={l.x}
              y={l.y}
              height={1}
              fill={l.fill}
              initial={{ width: reduceMotion ? l.w : 0 }}
              animate={reduceMotion ? { width: l.w } : { width: [0, 0, l.w, l.w, 0, 0] }}
              transition={reduceMotion ? { duration: 0 } : { duration: BOARD_S, times: [0, l.from, l.to, 0.88, 0.95, 1], repeat: Infinity, ease: "linear" }}
            />
          ))}
          {STICKIES.map((n) => (
            <motion.rect
              key={n.y}
              x={n.x}
              y={n.y}
              width={2}
              height={2}
              fill={n.fill}
              initial={{ opacity: reduceMotion ? 1 : 0 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: [0, 0, 1, 1, 0, 0] }}
              transition={reduceMotion ? { duration: 0 } : { duration: BOARD_S, times: [0, n.at, n.at + 0.02, 0.88, 0.95, 1], repeat: Infinity }}
            />
          ))}
          {!reduceMotion && (
            <motion.g
              initial={{ x: MARKER.x[0], y: MARKER.y[0] }}
              animate={{ x: MARKER.x, y: MARKER.y }}
              transition={{ duration: BOARD_S, times: MARKER.times, repeat: Infinity, ease: "easeInOut" }}
            >
              <rect width={1} height={1} fill="#5b8def" />
              <rect y={1} width={1} height={1} fill={COLORS.E} />
            </motion.g>
          )}
        </svg>
      )}
      {commuting && (
        // The briefcase in hand, swinging as it walks.
        <motion.svg
          viewBox={`0 0 ${BRIEFCASE[0].length} ${BRIEFCASE.length}`}
          width={BRIEFCASE[0].length * SUSHI.px}
          height={BRIEFCASE.length * SUSHI.px}
          shapeRendering="crispEdges"
          className="pointer-events-none absolute left-full"
          style={{ bottom: SUSHI.px, transformOrigin: "50% 0%" }}
          animate={reduceMotion ? { rotate: 0 } : { rotate: [-8, 8, -8] }}
          transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
        >
          <Pixels runs={BRIEFCASE_RUNS} />
        </motion.svg>
      )}
      {activity === "friends" && (
        // A friend walks over and they say hi; two more come running; everyone hops; they head off.
        <div className="pointer-events-none absolute bottom-0 left-full ml-1 flex items-end">
          {!reduceMotion && (
            <motion.div
              className="absolute -top-3 -left-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0, 1, 1, 0, 0], y: [0, 0, 0, -6, -10, -10] }}
              transition={{ duration: MEET_S, times: [0, 0.18, 0.2, 0.3, 0.36, 1], repeat: Infinity }}
            >
              <Glyph rows={HEART} px={1.5} />
            </motion.div>
          )}
          {FRIENDS.map((kind, i) => {
            const arrive = i === 0 ? 0.06 : 0.36 + i * 0.05;
            return (
              <motion.div
                key={kind}
                className={cn(i > 0 && "-ml-1")}
                initial={{ opacity: reduceMotion ? 1 : 0 }}
                animate={
                  reduceMotion
                    ? { opacity: 1 }
                    : {
                        x: [36, 36, 0, 0, 0, 0, 0, 0, 0, 36],
                        y: [0, 0, 0, 0, -5, 0, -5, 0, 0, 0],
                        opacity: [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
                      }
                }
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { duration: MEET_S, times: [0, arrive, arrive + 0.1, 0.6, 0.64, 0.68, 0.72, 0.76, 0.92, 1], repeat: Infinity, ease: "easeOut" }
                }
              >
                <MascotSprite kind={kind} scale={i === 0 ? 0.7 : 0.55} />
              </motion.div>
            );
          })}
        </div>
      )}
      <AnimatePresence>
        {activity === "coffee" && (
          // The coffee machine, standing beside the character at Sushi's pixel size.
          <motion.svg
            key="machine"
            viewBox={`0 0 ${MACHINE[0].length} ${MACHINE.length}`}
            width={MACHINE[0].length * SUSHI.px}
            height={MACHINE.length * SUSHI.px}
            shapeRendering="crispEdges"
            className="pointer-events-none absolute bottom-0 left-full ml-1"
            style={{ transformOrigin: "50% 100%" }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.4, y: 4 }}
            animate={{ opacity: 1, scaleY: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.4, y: 4, transition: { duration: 0.25 } }}
          >
            <Pixels runs={MACHINE_RUNS} />
            {coffee === "brew" && (
              <>
                {/* The light blinks while it brews. */}
                <motion.rect
                  x={2}
                  y={2}
                  width={1}
                  height={1}
                  fill="#ffd1c9"
                  animate={reduceMotion ? { opacity: 0 } : { opacity: [0, 1, 0] }}
                  transition={{ duration: 0.6, repeat: Infinity }}
                />
                {!reduceMotion &&
                  [0, 1].map((i) => (
                    <motion.rect
                      key={i}
                      x={4 + i}
                      width={1}
                      height={1}
                      fill={COLORS.c}
                      initial={{ y: 5, opacity: 0 }}
                      animate={{ y: [5, 6], opacity: [1, 0.6] }}
                      transition={{ duration: 0.35, delay: i * 0.17, repeat: Infinity, ease: "easeIn" }}
                    />
                  ))}
                <g transform="translate(2 6)">
                  <Pixels runs={MUG_RUNS} />
                  <motion.rect
                    x={1}
                    y={0}
                    width={3}
                    height={1}
                    fill={COLORS.c}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: reduceMotion ? 0 : BREW_MS / 1000, ease: "easeIn" }}
                  />
                </g>
              </>
            )}
          </motion.svg>
        )}
      </AnimatePresence>
      {asleep &&
        !reduceMotion &&
        [0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="pointer-events-none absolute -top-1 right-0 text-muted-foreground"
            initial={{ opacity: 0 }}
            animate={{ x: [0, 5, 10], y: [0, -10, -20], opacity: [0, 1, 0], scale: [0.6, 1, 1.2] }}
            transition={{ duration: 2.4, delay: i * 0.8, repeat: Infinity, ease: "easeOut" }}
          >
            <Glyph rows={ZED} px={1.5} />
          </motion.div>
        ))}
      <AnimatePresence>
        {dizzy === "down" && (
          // Stars circling just above it as it lies on its back, nearer ones bigger.
          <motion.div
            key="stars"
            className="pointer-events-none absolute left-1/2"
            style={{ top: height * px * 0.8 - 8 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.5, duration: 0.2 } }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
          >
            {[0, 1, 2].map((i) => {
              const phase = (i / 3) * Math.PI * 2;
              const rx = Math.min(width * px * 0.3, 14);
              return (
                <motion.div
                  key={i}
                  className="absolute -mt-0.75 -ml-0.75"
                  animate={{
                    x: ORBIT.map((a) => Math.cos(a + phase) * rx),
                    y: ORBIT.map((a) => Math.sin(a + phase) * 4),
                    scale: ORBIT.map((a) => 0.8 + Math.sin(a + phase) * 0.3),
                  }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
                >
                  <Glyph rows={STAR} />
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {mood === "thinking" && (
          <motion.div
            key="thought"
            className="pointer-events-none absolute -top-4 -right-5"
            style={{ transformOrigin: "0% 100%" }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { delay: 0.2, duration: 0.25, ease: "easeOut" } }}
            exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.15 } }}
          >
            <svg
              viewBox={`0 0 ${BUBBLE[0].length} ${BUBBLE.length}`}
              width={BUBBLE[0].length * 2}
              height={BUBBLE.length * 2}
              shapeRendering="crispEdges"
            >
              <Pixels runs={runs(BUBBLE)} />
              {BUBBLE_DOTS.map((dx, i) => (
                <motion.rect
                  key={dx}
                  x={dx}
                  y={2}
                  width={1}
                  height={1}
                  fill={COLORS.G}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.2, delay: i * 0.2, repeat: Infinity, ease: "easeInOut" }}
                />
              ))}
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div
        animate={hopControls}
        style={{ transformOrigin: "50% 100%", transformPerspective: 160 }}
        // A ghost: pale, see-through and glowing.
        className={cn(ghost && "brightness-125 grayscale drop-shadow-[0_0_3px_rgb(150_190_255/0.8)]")}
      >
        <motion.svg
          viewBox={`0 0 ${width} ${height}`}
          width={width * px}
          height={height * px}
          shapeRendering="crispEdges"
          style={{ transformOrigin: "50% 100%" }}
          // No endless breathing on a phone: a loop that never stops keeps the screen at its
          // highest refresh rate for as long as the chat is open.
          animate={reduceMotion || moving || isMobile ? { scaleY: 1 } : { scaleY: asleep ? [1, 1.05, 1] : [1, 1.03, 1] }}
          transition={
            reduceMotion || moving || isMobile
              ? { duration: 0.2 }
              : { duration: asleep ? 3.6 : 2.8, repeat: Infinity, ease: "easeInOut" }
          }
          className="drop-shadow-[0_1px_0_rgb(0_0_0/0.08)]"
        >
          <Pixels runs={body} />
          {eyes.map((e) => (
            <rect
              key={`${e.x},${e.y}`}
              x={e.x + look.x}
              y={e.y + look.y + (closed ? 1 : 0)}
              width={2}
              height={closed ? 1 : 2}
              fill={eyeColor}
            />
          ))}
          <AnimatePresence>
            {(mood !== "idle" || activity === "read") && glasses.lenses.length > 0 && (
              // Slid down from the forehead onto the eyes; lifted back up when done.
              <motion.g
                key="glasses"
                initial={reduceMotion ? { opacity: 0 } : { y: -4, opacity: 0 }}
                animate={{ y: 0, opacity: 1, transition: { duration: 0.25, ease: "easeOut" } }}
                exit={reduceMotion ? { opacity: 0 } : { y: -5, opacity: 0, transition: { duration: 0.35, ease: "easeIn" } }}
              >
                {glasses.lenses.map((l) => (
                  <g key={`${l.x},${l.y}`}>
                    <rect x={l.x + 1} y={l.y + 1} width={l.w - 2} height={l.h - 2} fill="#9fdcff" opacity={0.28} />
                    {/* A glint sweeping across the lens while writing; a still highlight otherwise. */}
                    {mood === "writing" && !reduceMotion ? (
                      <motion.rect
                        y={l.y + 1}
                        width={1}
                        height={l.h - 2}
                        fill="#ffffff"
                        initial={{ x: l.x + 1, opacity: 0 }}
                        animate={{ x: [l.x + 1, l.x + l.w - 2], opacity: [0, 0.85, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 1.6, ease: "easeInOut" }}
                      />
                    ) : (
                      <rect x={l.x + 1} y={l.y + 1} width={1} height={1} fill="#ffffff" opacity={0.7} />
                    )}
                  </g>
                ))}
                <Pixels runs={glasses.frame} />
              </motion.g>
            )}
          </AnimatePresence>
          {activity === "suit" && <Pixels runs={suitOf(character)} />}
          {ghost ? <Pixels runs={ghostHem(character, frame)} /> : <Pixels runs={legs[walking || dancing || commuting ? frame % legs.length : 0]} />}
          <AnimatePresence>
            {coffee === "drink" && (
              // The mug in both hands under the face, steaming; a sip lifts and tips it.
              <motion.g key="mug">
                <g transform={`translate(${heldAt(MUG_W).x} ${laptop.y}) scale(${laptop.scale})`}>
                <motion.g
                  style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, x: 6 }}
                  animate={{
                    opacity: 1,
                    x: 0,
                    y: sip ? -1.5 : 0,
                    rotate: sip ? -18 : 0,
                    transition: { duration: sip ? 0.35 : 0.3, ease: "easeOut" },
                  }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, transition: { duration: 0.2 } }}
                >
                  {!reduceMotion &&
                    [1, 3].map((sx, i) => (
                      <motion.rect
                        key={sx}
                        x={sx}
                        width={1}
                        height={1}
                        fill="#c9ced6"
                        initial={{ y: -1, opacity: 0 }}
                        animate={{ y: [-1, -3, -5], x: [0, 0.5, 0], opacity: [0, 0.8, 0] }}
                        transition={{ duration: 1.6, delay: i * 0.8, repeat: Infinity, ease: "easeOut" }}
                      />
                    ))}
                  <Pixels runs={MUG_RUNS} />
                  <rect x={1} y={0} width={3} height={1} fill={COLORS.c} />
                  <rect x={-1} y={1} width={1} height={2} fill={COLORS.R} />
                  <rect x={MUG_W} y={1} width={1} height={2} fill={COLORS.R} />
                </motion.g>
                </g>
              </motion.g>
            )}
            {activity === "read" && (
              // A book held up under the eyes; a page turns every few seconds.
              <motion.g key="book">
                <g transform={`translate(${heldAt(BOOK_W).x} ${laptop.y}) scale(${laptop.scale})`}>
                <motion.g
                  style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4, scaleY: 0.3 }}
                  animate={{ opacity: 1, y: 0, scaleY: 1, transition: { delay: 0.1, duration: 0.25, ease: "easeOut" } }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, scaleY: 0.2, transition: { duration: 0.2 } }}
                >
                  <Pixels runs={BOOK_RUNS} />
                  {!reduceMotion && (
                    <motion.rect
                      y={0}
                      width={1}
                      height={BOOK.length - 1}
                      fill={COLORS.W}
                      initial={{ x: BOOK_W - 2, opacity: 0 }}
                      animate={{ x: [BOOK_W - 2, BOOK_W / 2, 1], opacity: [0, 1, 0] }}
                      transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 3.5, ease: "easeInOut" }}
                    />
                  )}
                  <rect x={-1} y={1} width={1} height={1} fill={COLORS.R} />
                  <rect x={BOOK_W} y={1} width={1} height={1} fill={COLORS.R} />
                </motion.g>
                </g>
              </motion.g>
            )}
            {activity === "notebook" && (
              // An open notebook under the eyes; the pencil writes lines down the right-hand page.
              <motion.g key="notebook">
                <g transform={`translate(${heldAt(NOTEBOOK_W).x} ${laptop.y}) scale(${laptop.scale})`}>
                  <motion.g
                    style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4, scaleY: 0.3 }}
                    animate={{ opacity: 1, y: 0, scaleY: 1, transition: { delay: 0.1, duration: 0.25, ease: "easeOut" } }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, scaleY: 0.2, transition: { duration: 0.2 } }}
                  >
                    <Pixels runs={NOTEBOOK_RUNS} />
                    {/* The left-hand page, already written. */}
                    <rect x={1} y={0} width={3} height={1} fill="#aeb5bf" />
                    <rect x={1} y={1} width={2} height={1} fill="#aeb5bf" />
                    <rect x={1} y={2} width={3} height={1} fill="#aeb5bf" />
                    {PAGE_LINES.map((l) => (
                      <motion.rect
                        key={l.y}
                        x={6}
                        y={l.y}
                        height={1}
                        fill="#5b6472"
                        initial={{ width: reduceMotion ? l.w : 0 }}
                        animate={reduceMotion ? { width: l.w } : { width: [0, 0, l.w, l.w, 0, 0] }}
                        transition={reduceMotion ? { duration: 0 } : { duration: PAGE_S, times: [0, l.from, l.to, 0.9, 0.92, 1], repeat: Infinity, ease: "linear" }}
                      />
                    ))}
                    <rect x={-1} y={1} width={1} height={1} fill={COLORS.R} />
                    {/* The pencil, its point on the line being written, held in the right hand. */}
                    {!reduceMotion && (
                      <motion.g
                        initial={{ x: PENCIL.x[0], y: PENCIL.y[0] }}
                        animate={{ x: PENCIL.x, y: PENCIL.y }}
                        transition={{ duration: PAGE_S, times: PENCIL.times, repeat: Infinity, ease: "linear" }}
                      >
                        <rect width={1} height={1} fill={COLORS.E} />
                        <rect x={1} y={-1} width={1} height={1} fill="#f6c945" />
                        <rect x={2} y={-2} width={1} height={1} fill="#f6c945" />
                        <rect x={3} y={-3} width={1} height={1} fill="#ff8fb1" />
                        <rect x={1} y={0} width={1} height={1} fill={COLORS.R} />
                      </motion.g>
                    )}
                  </motion.g>
                </g>
              </motion.g>
            )}
            {activity === "workout" && (
              // The dumbbell, pressed from the chest up past the eyes on each rep.
              <motion.g key="dumbbell">
                <g transform={`translate(${heldAt(DUMBBELL_W).x} ${laptop.y}) scale(${laptop.scale})`}>
                  <motion.g
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, y: lift ? -5 : 0, transition: { duration: REP_MS / 1000 - 0.1, ease: "easeInOut" } }}
                    exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  >
                    <Pixels runs={DUMBBELL_RUNS} />
                    <rect x={2} y={2} width={1} height={1} fill={COLORS.R} />
                    <rect x={DUMBBELL_W - 3} y={2} width={1} height={1} fill={COLORS.R} />
                  </motion.g>
                </g>
              </motion.g>
            )}
            {gaming && (
              // A handheld console under the eyes; thumbs tapping, the screen flickering.
              <motion.g key="console">
                <g transform={`translate(${heldAt(CONSOLE_W).x} ${laptop.y}) scale(${laptop.scale})`}>
                  <motion.g
                    style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4, scaleY: 0.3 }}
                    animate={{ opacity: 1, y: 0, scaleY: 1, transition: { delay: 0.1, duration: 0.25, ease: "easeOut" } }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, scaleY: 0.2, transition: { duration: 0.2 } }}
                  >
                    <Pixels runs={CONSOLE_RUNS} />
                    <rect x={4 + (frame % 4)} y={1 + (frame % 2)} width={1} height={1} fill={COLORS.W} opacity={0.8} />
                    <rect x={2} y={hands[0]} width={1} height={1} fill={COLORS.R} />
                    <rect x={CONSOLE_W - 2} y={hands[1]} width={1} height={1} fill={COLORS.R} />
                  </motion.g>
                </g>
              </motion.g>
            )}
            {laptopOut && (
              <motion.g key="laptop">
                {/* Screen light flickering on the face. */}
                {laptop.glow && (
                  <motion.rect
                    x={laptop.glow.x}
                    y={laptop.glow.y}
                    width={laptop.glow.w}
                    height={laptop.glow.h}
                    fill="#9fdcff"
                    initial={{ opacity: 0 }}
                    animate={
                      reduceMotion
                        ? { opacity: 0.15 }
                        : { opacity: [0.1, 0.22, 0.14, 0.26, 0.12], transition: { duration: 2.2, repeat: Infinity } }
                    }
                    exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  />
                )}
                <g transform={`translate(${laptop.x} ${laptop.y}) scale(${laptop.scale})`}>
                  <motion.g
                    style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                    initial={reduceMotion ? { opacity: 0 } : { y: 4, scaleY: 0.3, opacity: 0 }}
                    animate={{ y: 0, scaleY: 1, opacity: 1, transition: { delay: 0.12, duration: 0.25, ease: "easeOut" } }}
                    exit={reduceMotion ? { opacity: 0 } : { scaleY: 0.2, y: 3, opacity: 0, transition: { duration: 0.25 } }}
                  >
                    <Pixels runs={LAPTOP_RUNS} />
                    {HAND_X.map((hx, i) => (
                      <rect key={hx} x={hx} y={hands[i]} width={1} height={1} fill={COLORS.R} />
                    ))}
                  </motion.g>
                </g>
              </motion.g>
            )}
          </AnimatePresence>
        </motion.svg>
      </motion.div>
      {activity === "study" && <StudyDesk width={width * px} eyesFromFloor={(height - laptop.y) * px} reduceMotion={!!reduceMotion} />}
    </motion.div>
    </MotionConfig>
  );
}
