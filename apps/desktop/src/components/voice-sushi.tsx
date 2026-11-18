// Sushi as the voice in a call, in place of the glass orb (Settings → Voice
// mode → "In a call"). The character picked in Settings → Sushi stands in a
// soft glow in the voice's own colours (the orb's hues), which swells with the
// voice being heard. While the answer plays its mouth moves with the sound and
// it bounces along; while you talk it leans in to listen; while thinking its
// eyes wander up under a thought bubble; muted, it closes its eyes. Loudness is
// read from refs every frame, and React re-renders only when the mouth changes
// shape. Tapping it cuts the answer short, like the orb.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { orbHues } from "@/components/glass-orb";
import { characterFor, Pixels, type Character } from "@/components/mascot";
import { useMascot } from "@/lib/mascot";
import type { VoiceConversation, VoiceStatus } from "@/lib/voice-session";

const TONGUE = "#f27a7a";
/** The figure's box, about the orb's size. */
const MAX_W = 96;
const MAX_H = 80;

type Look = { x: number; y: number };

/** Where the mouth goes: centred under the eyes, a row below them. */
function mouthOf(c: Character) {
  const xs = c.eyes.map((e) => e.x + 1);
  const cx = xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : Math.round(c.width / 2);
  const y = c.eyes.length ? Math.max(...c.eyes.map((e) => e.y)) + 2 : Math.round(c.height / 2);
  return { x: cx - 2, y };
}

export function VoiceSushi({ conversation, seed, status, muted }: { conversation: VoiceConversation; seed: string; status: VoiceStatus; muted: boolean }) {
  const c = characterFor(useMascot());
  const reduce = useReducedMotion();
  const px = Math.max(1, Math.min(Math.round(MAX_W / c.width), Math.round(MAX_H / c.height)));
  const mouth = mouthOf(c);
  const [a, b] = orbHues(seed);

  const glow = useRef<HTMLSpanElement>(null);
  const bounce = useRef<HTMLDivElement>(null);
  const live = useRef({ status, muted });
  live.current = { status, muted };
  // 0 closed, 1 a little open, 2 wide.
  const [open, setOpen] = useState(0);

  useEffect(() => {
    let frame = 0;
    let level = 0;
    let shape = 0;
    let changed = 0;
    const draw = (now: number) => {
      const { status, muted } = live.current;
      const { input, output } = conversation.levels();
      const speaking = status === "speaking";
      const target = speaking ? output : muted ? 0 : input;
      level += (target - level) * 0.25;
      if (glow.current) glow.current.style.transform = `scale(${(1 + (reduce ? 0 : level * 0.45)).toFixed(4)})`;
      if (bounce.current) {
        const lift = reduce || !speaking ? 0 : level * 7;
        const squash = reduce ? 0 : level * (speaking ? 0.07 : 0.04);
        bounce.current.style.transform = `translateY(${(-lift).toFixed(2)}px) scale(${(1 - squash / 2).toFixed(4)}, ${(1 + squash).toFixed(4)})`;
      }
      // The mouth follows the raw sound, not the smoothed level, so it flaps; held a beat so it doesn't flicker.
      const next = speaking ? (output > 0.3 ? 2 : output > 0.07 ? 1 : 0) : 0;
      if (next !== shape && now - changed > 70) {
        shape = next;
        changed = now;
        setOpen(next);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [conversation, reduce]);

  const busy = status === "thinking" || status === "connecting";
  const closed = muted || status === "error";
  const look = useLook(busy && !reduce);
  const blink = useBlink(!closed && !reduce);
  const leaning = status === "hearing" && !muted && !reduce;

  return (
    <button
      type="button"
      aria-label={status === "speaking" || status === "thinking" ? "Interrupt" : "Voice"}
      onClick={() => conversation.interrupt()}
      className="relative flex h-[104px] w-[128px] items-end justify-center rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      {/* The voice's glow, in the orb's colours. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-2 top-2 bottom-0 flex items-center justify-center transition-[filter,opacity] duration-500"
        style={{ filter: closed ? "grayscale(1)" : undefined, opacity: closed ? 0.45 : 1 }}
      >
        <span
          ref={glow}
          className="block size-24 rounded-full blur-2xl will-change-transform"
          style={{
            background: `radial-gradient(circle at 50% 35%, oklch(0.78 0.16 ${a} / 0.7), oklch(0.8 0.13 ${b} / 0.45) 55%, transparent 75%)`,
          }}
        />
      </span>

      <AnimatePresence>
        {busy && (
          <motion.span
            aria-hidden
            initial={{ opacity: 0, y: 4, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            className="absolute top-0 right-1 flex items-center gap-1 rounded-full border bg-background/90 px-2 py-1.5 shadow-xs"
          >
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="size-1.5 rounded-full bg-muted-foreground/70"
                animate={reduce ? undefined : { y: [0, -2, 0] }}
                transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
              />
            ))}
          </motion.span>
        )}
      </AnimatePresence>

      <motion.div
        className="relative mb-1"
        style={{ transformOrigin: "50% 100%" }}
        animate={reduce ? undefined : { rotate: leaning ? -5 : busy ? [0, -2, 0, 2, 0] : 0, x: leaning ? 2 : 0 }}
        transition={busy && !leaning ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" } : { type: "spring", stiffness: 260, damping: 18 }}
      >
        <div ref={bounce} className="will-change-transform" style={{ transformOrigin: "50% 100%" }}>
          <svg
            viewBox={`0 0 ${c.width} ${c.height}`}
            width={c.width * px}
            height={c.height * px}
            shapeRendering="crispEdges"
            className="block transition-[filter] duration-500"
            style={{ filter: closed ? "grayscale(0.6) opacity(0.8)" : undefined }}
            aria-hidden
          >
            <Pixels runs={c.body} />
            {c.eyes.map((e) =>
              closed || blink ? (
                <rect key={`${e.x},${e.y}`} x={e.x} y={e.y + 1} width={2} height={1} fill={c.eyeColor} />
              ) : (
                <rect key={`${e.x},${e.y}`} x={e.x + look.x} y={e.y + look.y} width={2} height={2} fill={c.eyeColor} />
              ),
            )}
            {open > 0 && <rect x={mouth.x} y={mouth.y} width={4} height={open} fill={c.eyeColor} />}
            {open > 1 && <rect x={mouth.x + 1} y={mouth.y + 1} width={2} height={1} fill={TONGUE} />}
            <Pixels runs={c.legs[0]} />
          </svg>
        </div>
      </motion.div>
    </button>
  );
}

/** Eyes front, or wandering up and side to side while it thinks. */
function useLook(wander: boolean): Look {
  const [look, setLook] = useState<Look>({ x: 0, y: 0 });
  useEffect(() => {
    if (!wander) {
      setLook({ x: 0, y: 0 });
      return;
    }
    const spots: Look[] = [
      { x: 1, y: -1 },
      { x: 0, y: -1 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
    ];
    let i = 0;
    setLook(spots[0]);
    const timer = setInterval(() => setLook(spots[++i % spots.length]), 700);
    return () => clearInterval(timer);
  }, [wander]);
  return look;
}

/** A blink every few seconds. */
function useBlink(active: boolean) {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(
        () => {
          setBlink(true);
          timer = setTimeout(() => {
            setBlink(false);
            next();
          }, 130);
        },
        2800 + Math.random() * 2400,
      );
    };
    next();
    return () => {
      clearTimeout(timer);
      setBlink(false);
    };
  }, [active]);
  return blink;
}
