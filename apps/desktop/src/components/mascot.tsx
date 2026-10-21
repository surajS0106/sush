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
// pops the new one in with a puff of sparkles. Purely decorative.

import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { AVATARS, avatarPalette, type AvatarDef } from "@/lib/avatars";
import { DEFAULT_MASCOT, mascotSounds, useMascot } from "@/lib/mascot";
import { audio, fallSounds } from "@/lib/sfx";
import { cn } from "@/lib/utils";

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
};

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

type Run = { x: number; y: number; w: number; fill: string };

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
interface Character {
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

function characterFor(key: string): Character {
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

function Pixels({ runs }: { runs: Run[] }) {
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

/** What a running reply is doing right now; each one has its own act. */
export type MascotStage = "thinking" | "tools" | "writing";

type Mood = "idle" | MascotStage;

interface MascotProps {
  busy: boolean;
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

const SPARKS = [
  { x: -18, y: -14 },
  { x: 18, y: -16 },
  { x: -22, y: 2 },
  { x: 22, y: 0 },
  { x: 0, y: -24 },
];

function MascotBody({
  busy,
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
  const reduceMotion = useReducedMotion();
  const hopControls = useAnimationControls();
  const rootRef = useRef<HTMLDivElement>(null);

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

  const busyRef = useRef(busy);
  busyRef.current = busy;
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
    if (reduceMotion || sleeping) return;
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
  }, [reduceMotion, sleeping]);

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
      if (!still && !busyRef.current && !sleepingRef.current && !dizzyRef.current && Date.now() - lastActivity.current > SLEEP_AFTER) setSleeping(true);
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

  // While thinking, the eyes drift up to one side, then the other.
  useEffect(() => {
    if (reduceMotion || mood !== "thinking") return;
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
  }, [mood, reduceMotion]);

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
  const moving = walking || laptopOut || dizzy !== null;
  const frameMs = dizzy === "reeling" ? 80 : dizzy === "down" ? 130 : walking ? 150 : mood === "writing" ? 90 : 120;
  useEffect(() => {
    if (reduceMotion || !moving) return setFrame(0);
    const id = setInterval(() => setFrame((f) => f + 1), frameMs);
    return () => clearInterval(id);
  }, [moving, frameMs, reduceMotion]);

  // Every so often, stroll somewhere along the composer's edge (or back home).
  useEffect(() => {
    if (reduceMotion || still || walking || busy || sleeping || dizzy) return;
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
  }, [reduceMotion, still, walking, busy, sleeping, dizzy, x]);

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
    if (busy) return;
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

  const closed = !dizzy && (sleeping || blink);
  const look: Look = dizzy
    ? EYE_ROLL[frame % EYE_ROLL.length]
    : sleeping
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

  return (
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
      {sleeping &&
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
      <motion.div animate={hopControls} style={{ transformOrigin: "50% 100%", transformPerspective: 160 }}>
        <motion.svg
          viewBox={`0 0 ${width} ${height}`}
          width={width * px}
          height={height * px}
          shapeRendering="crispEdges"
          style={{ transformOrigin: "50% 100%" }}
          animate={reduceMotion || moving ? { scaleY: 1 } : { scaleY: sleeping ? [1, 1.05, 1] : [1, 1.03, 1] }}
          transition={
            reduceMotion || moving
              ? { duration: 0.2 }
              : { duration: sleeping ? 3.6 : 2.8, repeat: Infinity, ease: "easeInOut" }
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
            {mood !== "idle" && glasses.lenses.length > 0 && (
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
          <Pixels runs={legs[walking ? frame % legs.length : 0]} />
          <AnimatePresence>
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
    </motion.div>
  );
}
