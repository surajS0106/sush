// Sush's mascot: a pixel-art nigiri (salmon on rice, a teal nori band) that
// stands on the composer. Its eyes follow the pointer (and drop to the input
// while you type), it breathes, blinks, wanders along the composer's edge now
// and then, runs in place while a run is working, and falls asleep when the
// app is left alone. Clicking it hops and pops a heart; three quick clicks do
// a backflip. Purely decorative.

import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

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

const HEART = ["HH.HH", "HHHHH", ".HHH.", "..H.."];
const ZED = ["ZZZ", ".Z.", "ZZZ"];

const COLORS: Record<string, string> = {
  S: "#f0533f", // salmon
  s: "#ff8f73", // salmon stripe
  N: "#0f5e5c", // nori
  R: "#fff8ee", // rice
  r: "#e3d1b8", // rice shade
  E: "#2b2b2b", // eyes
  P: "#f7a39b", // blush
  L: "#3d3d3d", // legs
  H: "#f0533f", // heart
  Z: "currentColor", // sleep z
};

const PX = 2.5;
const WIDTH = SPRITE[0].length;
const HEIGHT = SPRITE.length + 1;

/** Each eye's top-left pixel when looking straight ahead; eyes are 2×2. */
const EYES = [3, 11];
const EYE_Y = 5;

/** How far left of its spot it may wander, in CSS px, and how fast it walks. */
const WANDER = 72;
const WALK_SPEED = 28;
const SLEEP_AFTER = 60_000;

type Run = { x: number; y: number; w: number; fill: string };

/** Horizontal runs of one colour, so each row is a few rects rather than sixteen. */
function runs(rows: string[], y0 = 0) {
  const out: Run[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let w = 1;
      while (row[x + w] === c) w++;
      if (c !== ".") out.push({ x, y: y + y0, w, fill: COLORS[c] });
      x += w;
    }
  });
  return out;
}

const BODY = runs(SPRITE);
const LEGS = LEG_FRAMES.map((row) => runs([row], SPRITE.length));

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

export function Mascot({ busy, draft, className }: { busy: boolean; draft: string; className?: string }) {
  const reduceMotion = useReducedMotion();
  const hopControls = useAnimationControls();
  const rootRef = useRef<HTMLDivElement>(null);

  const [blink, setBlink] = useState(false);
  const [pointerLook, setPointerLook] = useState<Look>({ x: 0, y: 0 });
  const [typing, setTyping] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [legFrame, setLegFrame] = useState(0);
  const [x, setX] = useState(0);
  const [walking, setWalking] = useState(false);
  const [hearts, setHearts] = useState<number[]>([]);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  const sleepingRef = useRef(sleeping);
  sleepingRef.current = sleeping;
  const lastActivity = useRef(Date.now());
  const clicks = useRef<number[]>([]);

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
      if (!busyRef.current && !sleepingRef.current && Date.now() - lastActivity.current > SLEEP_AFTER) setSleeping(true);
    }, 5000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(idle);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [reduceMotion, hopControls]);

  // Watch the input while the user is typing.
  useEffect(() => {
    if (!draft) return setTyping(false);
    setTyping(true);
    const t = setTimeout(() => setTyping(false), 1000);
    return () => clearTimeout(t);
  }, [draft]);

  // Run in place while a run is working.
  useEffect(() => {
    if (reduceMotion) return;
    if (busy) {
      setSleeping(false);
      void hopControls.start({
        y: [0, -5, 0],
        scaleY: [0.92, 1.06, 0.94],
        scaleX: [1.06, 0.96, 1.04],
        transition: { duration: 0.45, repeat: Infinity, repeatDelay: 0.15, ease: "easeOut" },
      });
    } else void hopControls.start({ y: 0, scaleX: 1, scaleY: 1, transition: { duration: 0.2 } });
  }, [busy, reduceMotion, hopControls]);

  // Pitter-patter legs while walking or working.
  const moving = walking || busy;
  useEffect(() => {
    if (reduceMotion || !moving) return setLegFrame(0);
    const id = setInterval(() => setLegFrame((f) => (f + 1) % LEGS.length), busy ? 90 : 150);
    return () => clearInterval(id);
  }, [moving, busy, reduceMotion]);

  // Every so often, stroll somewhere along the composer's edge (or back home).
  useEffect(() => {
    if (reduceMotion || walking || busy || sleeping) return;
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
  }, [reduceMotion, walking, busy, sleeping, x]);

  const [walkFrom, setWalkFrom] = useState(0);
  useEffect(() => {
    if (!walking) setWalkFrom(x);
  }, [walking, x]);
  const walkDir = sign(x - walkFrom, 0);

  const onClick = () => {
    if (reduceMotion) return;
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 900), now];
    setHearts((h) => [...h, now]);
    if (busy) return;
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

  const closed = sleeping || blink;
  const look: Look = sleeping
    ? { x: 0, y: 1 }
    : walking
      ? { x: walkDir, y: 0 }
      : typing
        ? { x: -1, y: 1 }
        : pointerLook;

  return (
    <motion.div
      ref={rootRef}
      aria-hidden
      animate={{ x }}
      transition={{ duration: Math.max(0.3, Math.abs(x - walkFrom) / WALK_SPEED), ease: "linear" }}
      onAnimationComplete={() => setWalking(false)}
      onClick={onClick}
      className={cn("relative cursor-pointer select-none", className)}
    >
      {hearts.map((id) => (
        <motion.div
          key={id}
          className="pointer-events-none absolute left-1/2 -top-2 -ml-[5px]"
          initial={{ y: 0, opacity: 1, scale: 0.6 }}
          animate={{ y: -22, x: (id % 3) * 4 - 4, opacity: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          onAnimationComplete={() => setHearts((h) => h.filter((v) => v !== id))}
        >
          <Glyph rows={HEART} />
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
      <motion.div animate={hopControls} style={{ transformOrigin: "50% 100%" }}>
        <motion.svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width={WIDTH * PX}
          height={HEIGHT * PX}
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
          <Pixels runs={BODY} />
          {EYES.map((ex) => (
            <rect
              key={ex}
              x={ex + look.x}
              y={EYE_Y + look.y + (closed ? 1 : 0)}
              width={2}
              height={closed ? 1 : 2}
              fill={COLORS.E}
            />
          ))}
          <Pixels runs={LEGS[legFrame]} />
        </motion.svg>
      </motion.div>
    </motion.div>
  );
}
