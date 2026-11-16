// Shown while `image_generate` makes a picture: an 80s wood-grain CRT set,
// rabbit ears and all, drawn on Sushi's pixel grid. On screen Sushi stands at
// an easel flicking paint at a canvas until a picture fills in (a sunset, then
// a self-portrait), admires it, and starts the next.
//
// The easter egg: click the TV (or focus it and press Enter) and it changes
// channel to Pong. You are Sushi, the paddle at the bottom, moved with the
// mouse or the arrow keys; a pair of chopsticks plays the top and the ball is
// an ikura pearl. More pearls drift down to catch for a sparkle. No score is
// kept. Click again or press Escape to go back to the painting.
//
// The set clicks on with a CRT line, the glass has scanlines and a faint
// flicker (`tv-*` in index.css). With reduced motion the painting rests
// finished; the game still runs once someone starts it.

import { useReducedMotion } from "motion/react";
import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { PixelRows, SUSHI_ROWS, SushiPixels } from "@/components/mascot";
import { cn } from "@/lib/utils";

// --- the set, in sprite pixels ---------------------------------------------------

const W = 92;
const H = 79;
/** The glass: where the scenes are drawn. */
const SCREEN = { x: 9, y: 21, w: 62, h: 45 };

const TV = {
  wood: "#b0703f",
  woodLight: "#cf8f5a",
  grain: "#9a5d33",
  woodDark: "#7a4526",
  bezel: "#2a272b",
  bezelLip: "#433f45",
  panel: "#c9ced6",
  panelEdge: "#7d8590",
  knob: "#3d3d3d",
  knobMark: "#fff8ee",
  antenna: "#9aa3ad",
  tip: "#f0533f",
  glass: "#0e1f1c",
  net: "#24423c",
};

const GAME = {
  C: "#e6c590", // chopstick
  c: "#b98a4e", // chopstick shade
  O: "#ff7a2f", // ikura
  h: "#ffd3ad", // ikura shine
  Y: "#f6c945", // sparkle
};

const CHOPSTICKS = ["CCCCCCCCCCCc", "............", "CCCCCCCCCCCc"];
const IKURA = [".O.", "hOO", ".O."];
const PEARL = ["hO", "OO"];
const STAR = [".Y.", "YYY", ".Y."];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const approach = (from: number, to: number, max: number) => from + clamp(to - from, -max, max);
const px = (n: number) => Math.round(n);

/** Sushi stands on the bottom of the screen: 10 rows of body and 1 of legs, a pixel above the bezel. */
const SUSHI_W = 16;
const SUSHI_TOP = SCREEN.h - 12;

// --- painting, in screen pixels --------------------------------------------------

/** The canvas on the easel: its frame, and the 20×16 picture inside. */
const CANVAS = { x: 30, y: 14, w: 22, h: 18 };
const PIC = { x: CANVAS.x + 1, y: CANVAS.y + 1, w: 20, h: 16 };
/** Paint lands in 2×2 dabs, painted in strokes along each row, back and forth. */
const DAB = 2;
const DABS_X = PIC.w / DAB;
const DABS = DABS_X * (PIC.h / DAB);
const DAB_ORDER = Array.from({ length: DABS }, (_, i) => {
  const row = Math.floor(i / DABS_X);
  const col = i % DABS_X;
  return row * DABS_X + (row % 2 ? DABS_X - 1 - col : col);
});
const FLICK_EVERY = 0.09;
const FLIGHT = 0.35;
const ADMIRE = 1.8;
const PAINTER_X = 7;
/** Where the brush tip is when flicking, and so where each fleck of paint starts. */
const BRUSH_TIP = { x: 26, y: 33 };

const PAINT: Record<string, string> = {
  "1": "#ffe2b8", // pale sky
  "2": "#ffb38a", // peach
  "3": "#ff8f73", // salmon sky
  "4": "#fff3b0", // sun
  "5": "#0f5e5c", // sea
  "6": "#3fa39b", // wave
  "7": "#fff8ee", // canvas
  "8": "#d9eef0", // portrait backdrop
};

const SUNSET = [
  "11111111111111111111",
  "11111111111111111111",
  "11111111111111111111",
  "22222222222222222222",
  "22222222444422222222",
  "22222224444442222222",
  "33333344444444333333",
  "33333344444444333333",
  "33333333333333333333",
  "55555556666665555555",
  "55556665555556665555",
  "55555555555555555555",
  "55665555555555556655",
  "55555555555555555555",
  "55555566665555555555",
  "55555555555555555555",
];

/** Sushi painting itself: its body rows on a backdrop, eyes open, legs under it. */
const PORTRAIT = (() => {
  const blank = "8".repeat(PIC.w);
  const pad = (row: string) => `88${row.replace(/\./g, "8")}88`;
  const body = SUSHI_ROWS.map(pad);
  // Eyes go where the body has rice (see mascot.tsx): two 2×2 blocks on row 5.
  for (const y of [5, 6]) body[y] = body[y].slice(0, 5) + "EE" + body[y].slice(7, 13) + "EE" + body[y].slice(15);
  return [blank, blank, blank, ...body, pad("...L..L....L..L."), blank, blank];
})();

const PICTURES = [SUNSET, PORTRAIT];

interface Paint {
  t: number;
  pic: number;
  /** Dabs launched so far, and how many have landed (they land in the order they left). */
  launched: number;
  landed: number;
  launchIn: number;
  flecks: { n: number; age: number }[];
  /** Seconds left admiring the finished picture. */
  admire: number;
  brushUp: number;
}

const newPaint = (): Paint => ({ t: 0, pic: 0, launched: 0, landed: 0, launchIn: 0.4, flecks: [], admire: 0, brushUp: 0 });

const dabAt = (n: number) => {
  const d = DAB_ORDER[n];
  return { x: (d % DABS_X) * DAB, y: Math.floor(d / DABS_X) * DAB };
};

/** Sushi's own colours, for the portrait (mascot.tsx's palette). */
const SUSHI_COLORS: Record<string, string> = {
  S: "#f0533f",
  s: "#ff8f73",
  N: "#0f5e5c",
  R: "#fff8ee",
  r: "#e3d1b8",
  P: "#f7a39b",
  E: "#2b2b2b",
  L: "#3d3d3d",
};

const colorOf = (c: string) => PAINT[c] ?? SUSHI_COLORS[c] ?? PAINT["7"];

const dabColor = (pic: number, n: number) => {
  const { x, y } = dabAt(n);
  return colorOf(PICTURES[pic][y][x]);
};

function stepPaint(p: Paint, dt: number) {
  p.t += dt;
  p.brushUp = Math.max(0, p.brushUp - dt);
  if (p.admire > 0) {
    p.admire -= dt;
    if (p.admire <= 0) Object.assign(p, newPaint(), { t: p.t, pic: (p.pic + 1) % PICTURES.length, launchIn: 0.3 });
    return;
  }
  p.launchIn -= dt;
  if (p.launchIn <= 0 && p.launched < DABS) {
    p.flecks.push({ n: p.launched++, age: 0 });
    p.launchIn = FLICK_EVERY;
    p.brushUp = 0.05;
  }
  p.flecks = p.flecks.filter((f) => {
    f.age += dt;
    if (f.age < FLIGHT) return true;
    p.landed = Math.max(p.landed, f.n + 1);
    return false;
  });
  if (p.landed >= DABS) p.admire = ADMIRE;
}

/** The picture so far: only redrawn when a dab lands. */
const Picture = memo(function Picture({ pic, landed }: { pic: number; landed: number }) {
  return (
    <g transform={`translate(${PIC.x} ${PIC.y})`}>
      <rect width={PIC.w} height={PIC.h} fill={PAINT["7"]} />
      {Array.from({ length: landed }, (_, n) => {
        const { x, y } = dabAt(n);
        return [0, 1].flatMap((dy) =>
          [0, 1].map((dx) => {
            const fill = colorOf(PICTURES[pic][y + dy][x + dx]);
            return <rect key={`${n}-${dx}${dy}`} x={x + dx} y={y + dy} width={1} height={1} fill={fill} />;
          }),
        );
      })}
    </g>
  );
});

function Painting({ p, still }: { p: Paint; still: boolean }) {
  const landed = still ? DABS : p.landed;
  const admiring = still || p.admire > 0;
  const blink = p.t % 3.4 < 0.12;
  const hop = !still && admiring && Math.floor(p.t / 0.25) % 2 === 0;
  const lastColor = p.launched ? dabColor(p.pic, p.launched - 1) : PAINT["3"];
  const wood = TV.wood;
  return (
    <>
      <rect width={SCREEN.w} height={SCREEN.h} fill={TV.glass} />
      <rect y={SCREEN.h - 1} width={SCREEN.w} height={1} fill={TV.net} />

      {/* The easel: a peg, the canvas, a ledge and three legs. */}
      <rect x={40} y={12} width={2} height={2} fill={wood} />
      <rect x={41} y={32} width={1} height={12} fill={TV.woodDark} />
      <g fill={wood}>
        <rect x={33} y={32} width={1} height={4} />
        <rect x={32} y={36} width={1} height={4} />
        <rect x={31} y={40} width={1} height={4} />
        <rect x={48} y={32} width={1} height={4} />
        <rect x={49} y={36} width={1} height={4} />
        <rect x={50} y={40} width={1} height={4} />
      </g>
      <rect x={CANVAS.x} y={CANVAS.y} width={CANVAS.w} height={CANVAS.h} fill={TV.woodDark} />
      <Picture pic={p.pic} landed={landed} />
      <rect x={CANVAS.x - 1} y={CANVAS.y + CANVAS.h} width={CANVAS.w + 2} height={1} fill={TV.woodLight} />

      {/* Sushi with its brush, flicking paint up at the canvas. */}
      <g transform={`translate(${PAINTER_X} ${SUSHI_TOP - (hop ? 1 : 0)})`}>
        {blink ? <SushiPixels legs={0} /> : <SushiPixels look={{ x: 1, y: admiring ? 0 : -1 }} legs={hop ? 1 : 0} />}
      </g>
      {!admiring && p.brushUp > 0 ? (
        <g>
          <rect x={23} y={37} width={1} height={1} fill={TV.woodLight} />
          <rect x={24} y={36} width={1} height={1} fill={TV.woodLight} />
          <rect x={25} y={35} width={1} height={1} fill={TV.woodLight} />
          <rect x={BRUSH_TIP.x} y={BRUSH_TIP.y} width={1} height={2} fill={lastColor} />
        </g>
      ) : (
        <g>
          <rect x={23} y={38} width={3} height={1} fill={TV.woodLight} />
          <rect x={26} y={38} width={2} height={1} fill={lastColor} />
        </g>
      )}

      {/* Paint in flight: an arc from the brush to its spot on the canvas. */}
      {p.flecks.map((f) => {
        const k = f.age / FLIGHT;
        const to = dabAt(f.n);
        const x = BRUSH_TIP.x + (PIC.x + to.x + 1 - BRUSH_TIP.x) * k;
        const y = BRUSH_TIP.y + (PIC.y + to.y + 1 - BRUSH_TIP.y) * k - Math.sin(Math.PI * k) * 8;
        return <rect key={f.n} x={px(x)} y={px(y)} width={1} height={1} fill={dabColor(p.pic, f.n)} />;
      })}

      {/* Admiring the finished picture: sparkles at its corners, in turn. */}
      {admiring && !still && (
        <g transform={Math.floor(p.t / 0.3) % 2 ? `translate(${CANVAS.x - 2} ${CANVAS.y - 2})` : `translate(${CANVAS.x + CANVAS.w - 1} ${CANVAS.y + 3})`}>
          <PixelRows rows={STAR} colors={GAME} />
        </g>
      )}
    </>
  );
}

// --- Pong, in screen pixels ------------------------------------------------------

const STICKS_Y = 6;
const STICKS_W = CHOPSTICKS[0].length;
const BALL = 3;
const BALL_TOP = STICKS_Y + CHOPSTICKS.length;
const BALL_SPEED = 26;
const KEY_SPEED = 52;
const POINTER_SPEED = 90;
const STICKS_SPEED = 30;
const PEARL_FALL = 10;
const MAX_PEARLS = 2;

interface Game {
  t: number;
  ball: { x: number; y: number; vx: number; vy: number; missed: boolean };
  trail: { x: number; y: number }[];
  /** Seconds until the next serve after a miss; 0 while the ball is in play. */
  serveIn: number;
  sushi: { x: number; step: number; walk: number; hop: number };
  /** The player's input: a pointer's x on the screen, or a held arrow key. */
  input: { target: number | null; dir: number };
  sticks: number;
  pearls: { id: number; x: number; y: number }[];
  spawnIn: number;
  pops: { id: number; x: number; y: number; life: number }[];
  nextId: number;
}

function newGame(): Game {
  return {
    t: 0,
    ball: { x: SCREEN.w / 2, y: BALL_TOP, vx: rand(-10, 10), vy: BALL_SPEED * 0.8, missed: false },
    trail: [],
    serveIn: 0,
    sushi: { x: (SCREEN.w - SUSHI_W) / 2, step: 0, walk: 0, hop: 0 },
    input: { target: null, dir: 0 },
    sticks: (SCREEN.w - STICKS_W) / 2,
    pearls: [],
    spawnIn: 2,
    pops: [],
    nextId: 0,
  };
}

/** Bounce off a paddle: the further from its middle, the sharper the angle. */
const deflect = (ballCx: number, paddleCx: number, half: number) =>
  clamp(((ballCx - paddleCx) / half) * 24 + rand(-4, 4), -30, 30);

function stepGame(g: Game, dt: number) {
  g.t += dt;
  const b = g.ball;
  const s = g.sushi;

  // Sushi goes where the player says.
  const before = s.x;
  if (g.input.dir) s.x += g.input.dir * KEY_SPEED * dt;
  else if (g.input.target !== null) s.x = approach(s.x, g.input.target - SUSHI_W / 2, POINTER_SPEED * dt);
  s.x = clamp(s.x, 0, SCREEN.w - SUSHI_W);
  if (Math.abs(s.x - before) > 0.05) {
    s.walk += dt;
    if (s.walk > 0.1) [s.walk, s.step] = [0, s.step + 1];
  }
  s.hop = Math.max(0, s.hop - dt);

  // After a miss, the chopsticks serve again.
  if (g.serveIn > 0) {
    g.serveIn -= dt;
    if (g.serveIn <= 0) {
      g.serveIn = 0;
      Object.assign(b, { x: g.sticks + STICKS_W / 2 - 1, y: BALL_TOP, vx: rand(-12, 12), vy: BALL_SPEED * 0.8, missed: false });
      g.trail = [];
    }
  } else {
    g.trail = [{ x: b.x, y: b.y }, ...g.trail].slice(0, 3);
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < 1) [b.x, b.vx] = [1, Math.abs(b.vx)];
    if (b.x > SCREEN.w - 1 - BALL) [b.x, b.vx] = [SCREEN.w - 1 - BALL, -Math.abs(b.vx)];
    const bcx = b.x + BALL / 2;

    if (b.vy < 0 && b.y <= BALL_TOP) {
      b.y = BALL_TOP;
      b.vy = BALL_SPEED;
      b.vx = deflect(bcx, g.sticks + STICKS_W / 2, STICKS_W / 2);
    }
    if (!b.missed && b.vy > 0 && b.y + BALL >= SUSHI_TOP) {
      if (bcx >= s.x - 1 && bcx <= s.x + SUSHI_W + 1) {
        b.y = SUSHI_TOP - BALL;
        b.vy = -BALL_SPEED;
        b.vx = deflect(bcx, s.x + SUSHI_W / 2, SUSHI_W / 2);
        s.hop = 0.14;
      } else b.missed = true;
    }
    if (b.y > SCREEN.h) g.serveIn = 0.8;
  }

  // Chopsticks: chase the pearl on its way up, idle back to the middle otherwise.
  const sticksTo = g.serveIn === 0 && b.vy < 0 ? b.x + BALL / 2 - STICKS_W / 2 : (SCREEN.w - STICKS_W) / 2;
  g.sticks = clamp(approach(g.sticks, sticksTo, STICKS_SPEED * dt), 1, SCREEN.w - 1 - STICKS_W);

  // Pearls drift down; catching one pops a sparkle.
  g.spawnIn -= dt;
  if (g.spawnIn <= 0 && g.pearls.length < MAX_PEARLS) {
    g.pearls.push({ id: g.nextId++, x: Math.round(rand(3, SCREEN.w - 5)), y: BALL_TOP + 1 });
    g.spawnIn = rand(1.6, 2.8);
  }
  g.pearls = g.pearls.filter((p) => {
    p.y += PEARL_FALL * dt;
    if (p.y + 2 >= SUSHI_TOP + 1 && p.x + 2 > s.x + 1 && p.x < s.x + SUSHI_W - 1) {
      g.pops.push({ id: g.nextId++, x: p.x - 1, y: SUSHI_TOP - 5, life: 0.5 });
      return false;
    }
    return p.y < SCREEN.h;
  });
  g.pops = g.pops.filter((p) => (p.life -= dt) > 0);
}

function Sprite({ rows, x, y, opacity }: { rows: string[]; x: number; y: number; opacity?: number }) {
  return (
    <g transform={`translate(${px(x)} ${px(y)})`} opacity={opacity}>
      <PixelRows rows={rows} colors={GAME} />
    </g>
  );
}

function Pong({ g }: { g: Game }) {
  const s = g.sushi;
  const b = g.ball;
  const dx = b.x + BALL / 2 - (s.x + SUSHI_W / 2);
  const look = { x: dx < -4 ? -1 : dx > 4 ? 1 : 0, y: b.y < SUSHI_TOP - 14 ? -1 : 0 };
  const blink = g.t % 3.4 < 0.12;
  return (
    <>
      <rect width={SCREEN.w} height={SCREEN.h} fill={TV.glass} />
      {Array.from({ length: Math.floor(SCREEN.w / 4) }, (_, i) => (
        <rect key={i} x={i * 4 + 1} y={21} width={2} height={1} fill={TV.net} />
      ))}
      <Sprite rows={CHOPSTICKS} x={g.sticks} y={STICKS_Y} />
      {g.pearls.map((p) => (
        <Sprite key={p.id} rows={PEARL} x={p.x} y={p.y} />
      ))}
      {g.serveIn === 0 && (
        <>
          {g.trail.map((t, i) => (
            <Sprite key={i} rows={IKURA} x={t.x} y={t.y} opacity={0.25 - i * 0.07} />
          ))}
          <Sprite rows={IKURA} x={b.x} y={b.y} />
        </>
      )}
      <g transform={`translate(${px(s.x)} ${SUSHI_TOP - (s.hop > 0 ? 1 : 0)})`}>
        {blink ? <SushiPixels legs={s.step} /> : <SushiPixels look={look} legs={s.step} />}
      </g>
      {g.pops.map((p) => (
        <Sprite key={p.id} rows={STAR} x={p.x} y={p.y - (0.5 - p.life) * 8} opacity={Math.min(1, p.life * 4)} />
      ))}
    </>
  );
}

// --- the set ---------------------------------------------------------------------

function Cabinet({ channel }: { channel: number }) {
  const antenna = Array.from({ length: 11 }, (_, i) => i);
  return (
    <>
      {/* Rabbit ears. */}
      {antenna.map((i) => (
        <g key={i} fill={TV.antenna}>
          <rect x={45 - i} y={11 - i} width={1} height={1} />
          <rect x={46 + i} y={11 - i} width={1} height={1} />
        </g>
      ))}
      <rect x={34} y={0} width={2} height={2} fill={TV.tip} />
      <rect x={56} y={0} width={2} height={2} fill={TV.tip} />
      <rect x={40} y={11} width={12} height={3} fill={TV.bezelLip} />
      <rect x={41} y={11} width={10} height={1} fill={TV.panelEdge} />

      {/* Wood-grain case with stepped corners. */}
      <rect x={3} y={14} width={86} height={60} fill={TV.wood} />
      <rect x={2} y={15} width={88} height={58} fill={TV.wood} />
      <rect x={3} y={14} width={86} height={1} fill={TV.woodLight} />
      <rect x={2} y={15} width={1} height={58} fill={TV.woodLight} />
      <rect x={3} y={73} width={86} height={1} fill={TV.woodDark} />
      <rect x={89} y={15} width={1} height={58} fill={TV.woodDark} />
      {[
        [4, 16, 30],
        [44, 17, 40],
        [12, 70, 26],
        [52, 71, 30],
        [3, 40, 2],
        [3, 55, 2],
        [75, 30, 1],
        [87, 50, 1],
      ].map(([x, y, w]) => (
        <rect key={`${x},${y}`} x={x} y={y} width={w} height={1} fill={TV.grain} />
      ))}

      {/* The bezel round the glass. */}
      <rect x={7} y={18} width={66} height={51} fill={TV.bezel} />
      <rect x={6} y={19} width={68} height={49} fill={TV.bezel} />
      <rect x={8} y={20} width={64} height={1} fill={TV.bezelLip} />
      <rect x={8} y={66} width={64} height={1} fill={TV.bezelLip} />

      {/* Control panel: the channel knob (it turns when the channel changes), volume, a power light, the speaker. */}
      <rect x={77} y={18} width={10} height={51} fill={TV.panelEdge} />
      <rect x={78} y={19} width={8} height={49} fill={TV.panel} />
      {[22, 31].map((y, k) => (
        <g key={y}>
          <rect x={80} y={y} width={4} height={6} fill={TV.knob} />
          <rect x={79} y={y + 1} width={6} height={4} fill={TV.knob} />
          {k === 0 && channel ? (
            <rect x={82} y={y + 2} width={2} height={1} fill={TV.knobMark} />
          ) : (
            <rect x={k ? 82 : 81} y={y + 1} width={1} height={2} fill={TV.knobMark} />
          )}
        </g>
      ))}
      <rect x={81} y={39} width={2} height={1} fill={TV.tip} className="tv-led" />
      {Array.from({ length: 11 }, (_, i) => (
        <rect key={i} x={79} y={43 + i * 2} width={6} height={1} fill={TV.panelEdge} />
      ))}

      {/* Feet. */}
      <rect x={10} y={74} width={6} height={4} fill={TV.woodDark} />
      <rect x={76} y={74} width={6} height={4} fill={TV.woodDark} />
      <rect x={10} y={78} width={6} height={1} fill={TV.bezel} />
      <rect x={76} y={78} width={6} height={1} fill={TV.bezel} />
    </>
  );
}

type Mode = "paint" | "play";

const LEFT = new Set(["ArrowLeft", "a", "A"]);
const RIGHT = new Set(["ArrowRight", "d", "D"]);

/**
 * The image loader: Sushi's TV, painting until the picture is ready, or
 * playing Pong once clicked. `caption` sits right under the set.
 */
export function ImageTV({ scale = 3, caption, className }: { scale?: number; caption?: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion() ?? false;
  // Two loaders at once (two images in a step) each need their own clip.
  const clipId = `image-tv-glass-${useId().replace(/:/g, "")}`;
  const [mode, setMode] = useState<Mode>("paint");
  const paint = useRef<Paint | null>(null);
  paint.current ??= newPaint();
  const game = useRef<Game | null>(null);
  game.current ??= newGame();
  const [, setFrame] = useState(0);

  useEffect(() => {
    if (mode === "paint" && reduceMotion) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // A long gap (hidden window, a stall) resumes rather than leaping ahead.
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (mode === "play") stepGame(game.current!, dt);
      else stepPaint(paint.current!, dt);
      setFrame((f) => f + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, reduceMotion]);

  const toggle = () =>
    setMode((m) => {
      if (m === "play") return "paint";
      game.current = newGame();
      return "play";
    });

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (mode !== "play") return;
    const r = e.currentTarget.getBoundingClientRect();
    game.current!.input = { target: ((e.clientX - r.left) / r.width) * W - SCREEN.x, dir: 0 };
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    } else if (e.key === "Escape" && mode === "play") {
      e.preventDefault();
      setMode("paint");
    } else if (mode === "play" && (LEFT.has(e.key) || RIGHT.has(e.key))) {
      e.preventDefault();
      game.current!.input = { target: null, dir: LEFT.has(e.key) ? -1 : 1 };
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    const input = game.current!.input;
    if ((input.dir < 0 && LEFT.has(e.key)) || (input.dir > 0 && RIGHT.has(e.key))) input.dir = 0;
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div className={cn("flex w-fit flex-col items-center gap-2", className)}>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={mode === "play"}
        aria-label={mode === "play" ? "Stop playing Pong" : "Sushi's TV: play Pong while you wait"}
        onClick={toggle}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerMove={onPointerMove}
        onBlur={() => (game.current!.input.dir = 0)}
        className="relative shrink-0 cursor-pointer outline-none select-none [-webkit-tap-highlight-color:transparent]"
        style={{ width: W * scale, height: H * scale }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} width={W * scale} height={H * scale} shapeRendering="crispEdges" className="block" aria-hidden>
          <defs>
            <clipPath id={clipId}>
              <rect width={SCREEN.w} height={SCREEN.h} rx={3} />
            </clipPath>
          </defs>
          <Cabinet channel={mode === "play" ? 1 : 0} />
          <g transform={`translate(${SCREEN.x} ${SCREEN.y})`}>
            <g clipPath={`url(#${clipId})`}>
              {/* Keyed by channel so changing it replays the CRT's switch-on. */}
              <g key={mode} className="tv-screen-on">
                {mode === "play" ? <Pong g={game.current!} /> : <Painting p={paint.current} still={reduceMotion} />}
              </g>
            </g>
          </g>
        </svg>
        {/* Scanlines, a curved-glass vignette and a little flicker over the picture. */}
        <div
          className="tv-glass pointer-events-none absolute"
          style={{
            left: pct(SCREEN.x, W),
            top: pct(SCREEN.y, H),
            width: pct(SCREEN.w, W),
            height: pct(SCREEN.h, H),
            borderRadius: 3 * scale,
          }}
        />
      </div>
      {caption}
      {mode === "play" && (
        <p className="text-xs text-muted-foreground">Move Sushi with your mouse or the arrow keys. Click the TV to stop.</p>
      )}
    </div>
  );
}
