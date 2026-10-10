"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition, type Transition } from "framer-motion";
import { CheckIcon as PhCheck, PlayIcon as PhPlay, StopIcon as PhStop, SmileyIcon as PhSmiley } from "@phosphor-icons/react";

type VoiceAvatar = { kind: "orb"; gradient: string; glow: string } | { kind: "image"; src: string; alt: string };

interface Voice {
  id: string;
  name: string;
  descriptor: string;
  avatar: VoiceAvatar;
}

// Default set: realistic TTS voice names paired with abstract gradient-orb
// avatars, the same "AI identity without a literal mascot" idea this
// library's own Persona card uses, so the default state reads as a real
// product surface rather than a themed demo.
const PRO_VOICES: Voice[] = [
  {
    id: "ember",
    name: "Ember",
    descriptor: "Warm, American",
    avatar: { kind: "orb", gradient: "radial-gradient(circle at 32% 28%, #fef3c7, #fbbf24 55%, #d97706 100%)", glow: "rgba(251,191,36,0.5)" },
  },
  {
    id: "sable",
    name: "Sable",
    descriptor: "Calm, British",
    avatar: { kind: "orb", gradient: "radial-gradient(circle at 32% 28%, #34d399, #047857 55%, #022c22 100%)", glow: "rgba(4,120,87,0.5)" },
  },
  {
    id: "flux",
    name: "Flux",
    descriptor: "Energetic, Australian",
    avatar: { kind: "orb", gradient: "radial-gradient(circle at 32% 28%, #fbbf24, #b45309 55%, #451a03 100%)", glow: "rgba(180,83,9,0.5)" },
  },
  {
    id: "vale",
    name: "Vale",
    descriptor: "Measured, Canadian",
    avatar: { kind: "orb", gradient: "radial-gradient(circle at 32% 28%, #d1fae5, #34d399 55%, #059669 100%)", glow: "rgba(52,211,153,0.5)" },
  },
];

// Second theme, switched in by the toggle below: illustrated animal GIFs with
// gender-neutral given names. Kept as an opt-in rather than the default so
// the avatar slot's playful end still exists without being the first thing a
// visitor sees on an otherwise professional "ai" block.
const FUN_VOICES: Voice[] = [
  { id: "axolotl", name: "River", descriptor: "Playful, bubbly", avatar: { kind: "image", src: "/ui-library/voice-selector/axolotl.gif", alt: "Axolotl" } },
  { id: "capybara", name: "Sage", descriptor: "Mellow, unbothered", avatar: { kind: "image", src: "/ui-library/voice-selector/capybara.gif", alt: "Capybara" } },
  { id: "koala", name: "Robin", descriptor: "Sleepy, soothing", avatar: { kind: "image", src: "/ui-library/voice-selector/koala.gif", alt: "Koala" } },
  { id: "raccoon", name: "Kit", descriptor: "Curious, quick", avatar: { kind: "image", src: "/ui-library/voice-selector/raccoon.gif", alt: "Raccoon" } },
];

const PREVIEW_MS = 1800;

function CheckIcon() {
  return <PhCheck size={9} weight="bold" aria-hidden />;
}

function PlayIcon() {
  return <PhPlay size={11} weight="fill" aria-hidden />;
}

function StopIcon() {
  return <PhStop size={9} weight="fill" aria-hidden />;
}

function SmileyMark() {
  return <PhSmiley size={10} weight="fill" aria-hidden />;
}

// Shared idle-bob / preview-wiggle motion so every avatar kind reads as the
// same "alive" family of cards, whether it's a gradient orb or a dropped-in
// illustration.
function useAvatarMotion(playing: boolean, blinkDelay: number): { animate?: TargetAndTransition; transition?: Transition } {
  const shouldReduceMotion = useReducedMotion();
  if (shouldReduceMotion) return {};
  return playing
    ? { animate: { scale: [1, 1.07, 1], rotate: [0, -2, 2, 0] }, transition: { duration: 0.55, repeat: Infinity, ease: "easeInOut" } }
    : { animate: { y: [0, -0.35, 0] }, transition: { duration: 3.6, repeat: Infinity, ease: "easeInOut", delay: blinkDelay * 0.3 } };
}

function OrbAvatar({
  gradient,
  glow,
  size = 52,
  playing,
  blinkDelay = 0,
}: {
  gradient: string;
  glow: string;
  size?: number;
  playing: boolean;
  blinkDelay?: number;
}) {
  const shouldReduceMotion = useReducedMotion();
  const motionProps = useAvatarMotion(playing, blinkDelay);
  return (
    <motion.div className="relative" style={{ width: size, height: size }} {...motionProps}>
      <motion.span
        aria-hidden
        className="absolute rounded-full blur-md"
        style={{ inset: -4, background: glow }}
        animate={shouldReduceMotion ? { opacity: 0.5 } : { opacity: playing ? [0.4, 0.85, 0.4] : [0.35, 0.55, 0.35] }}
        transition={{ duration: playing ? 0.8 : 3, repeat: Infinity, ease: "easeInOut" }}
      />
      <span className="relative block h-full w-full overflow-hidden rounded-full ring-1 ring-white/25" style={{ background: gradient }}>
        <span aria-hidden className="pointer-events-none absolute left-[20%] top-[14%] h-[30%] w-[30%] rounded-full bg-white/50 blur-[2px]" />
      </span>
    </motion.div>
  );
}

function GifAvatar({
  src,
  alt,
  size = 56,
  playing,
  blinkDelay = 0,
}: {
  src: string;
  alt: string;
  size?: number;
  playing: boolean;
  blinkDelay?: number;
}) {
  const motionProps = useAvatarMotion(playing, blinkDelay);
  return (
    <motion.div className="flex items-center justify-center" style={{ width: size, height: size }} {...motionProps}>
      {/* eslint-disable-next-line @next/next/no-img-element -- animated GIF; next/image re-encodes and drops animation frames */}
      <img src={src} alt={alt} className="h-full w-full object-contain" draggable={false} />
    </motion.div>
  );
}

function ThemeToggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5">
      <span className="flex items-center gap-1 text-[11px] font-medium text-stone-500 dark:text-stone-500">
        <SmileyMark />
        Fun avatars
      </span>
      <motion.button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label="Toggle illustrated animal avatars"
        onClick={onChange}
        whileTap={{ scale: 0.93 }}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
          checked ? "bg-emerald-600" : "bg-stone-300 dark:bg-stone-600"
        }`}
      >
        <motion.span
          animate={{ x: checked ? 16 : 2 }}
          transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 700, damping: 32 }}
          className="absolute top-0.5 block h-4 w-4 rounded-full bg-white shadow-sm"
        />
      </motion.button>
    </label>
  );
}

export function VoiceSelector({
  defaultSelectedId,
  onSelect,
}: {
  defaultSelectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [theme, setTheme] = useState<"pro" | "fun">("pro");
  const voices = theme === "pro" ? PRO_VOICES : FUN_VOICES;
  const [selectedId, setSelectedId] = useState(defaultSelectedId ?? PRO_VOICES[0].id);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const togglePreview = (id: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (previewingId === id) {
      setPreviewingId(null);
      return;
    }
    setPreviewingId(id);
    timeoutRef.current = setTimeout(() => setPreviewingId(null), PREVIEW_MS);
  };

  const toggleTheme = () => {
    const nextTheme = theme === "pro" ? "fun" : "pro";
    const nextVoices = nextTheme === "pro" ? PRO_VOICES : FUN_VOICES;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setPreviewingId(null);
    setTheme(nextTheme);
    setSelectedId(nextVoices[0].id);
  };

  const selected = voices.find((v) => v.id === selectedId) ?? voices[0];

  return (
    <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2 px-1 pb-2 pt-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">Voice</p>
        <div className="flex items-center gap-3">
          <ThemeToggle checked={theme === "fun"} onChange={toggleTheme} />
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{selected.name}</p>
        </div>
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={theme}
          role="radiogroup"
          aria-label="Select a voice"
          initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-2 gap-2"
        >
          {voices.map((v, i) => {
            const isSelected = v.id === selectedId;
            const isPlaying = previewingId === v.id;
            return (
              <div
                key={v.id}
                className={`relative rounded-xl border transition-colors ${
                  isSelected
                    ? "border-emerald-500/40 bg-emerald-500/8 dark:bg-emerald-400/10"
                    : "border-transparent hover:bg-black/[0.03] dark:hover:bg-white/5"
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => {
                    setSelectedId(v.id);
                    onSelect?.(v.id);
                  }}
                  className="flex w-full flex-col items-center gap-1 rounded-xl px-2 pb-2.5 pt-3 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
                >
                  <div className="relative">
                    <motion.div
                      animate={isSelected && !shouldReduceMotion ? { y: [0, -3, 0] } : undefined}
                      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {v.avatar.kind === "orb" ? (
                        <OrbAvatar gradient={v.avatar.gradient} glow={v.avatar.glow} playing={isPlaying} blinkDelay={i * 0.9} size={52} />
                      ) : (
                        <GifAvatar src={v.avatar.src} alt={v.avatar.alt} playing={isPlaying} blinkDelay={i * 0.9} size={60} />
                      )}
                    </motion.div>
                    <AnimatePresence>
                      {isSelected && (
                        <motion.span
                          aria-hidden
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{ type: "spring", stiffness: 500, damping: 24 }}
                          className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-700 text-white ring-2 ring-white dark:ring-stone-950"
                        >
                          <CheckIcon />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </div>
                  <span className="mt-0.5 block text-xs font-medium text-stone-800 dark:text-stone-100">{v.name}</span>
                  <span className="block text-[11px] text-stone-500 dark:text-stone-500">{v.descriptor}</span>
                </button>

                <button
                  type="button"
                  onClick={() => togglePreview(v.id)}
                  aria-label={isPlaying ? `Stop preview of ${v.name}` : `Preview ${v.name}`}
                  title={isPlaying ? "Stop preview" : "Preview voice"}
                  className={`absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
                    isPlaying
                      ? "bg-emerald-700 text-white"
                      : "bg-black/5 text-stone-500 hover:bg-black/10 hover:text-stone-700 dark:bg-white/10 dark:text-stone-400 dark:hover:bg-white/15 dark:hover:text-stone-200"
                  }`}
                >
                  {isPlaying && (
                    <motion.span
                      aria-hidden
                      className="absolute inset-[-3px] rounded-full border border-emerald-400/50"
                      animate={shouldReduceMotion ? undefined : { scale: [1, 1.3], opacity: [0.6, 0] }}
                      transition={{ duration: 1, repeat: Infinity, ease: "easeOut" }}
                    />
                  )}
                  {isPlaying ? <StopIcon /> : <PlayIcon />}
                </button>
              </div>
            );
          })}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
