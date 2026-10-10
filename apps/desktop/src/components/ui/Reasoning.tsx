"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { BrainIcon as PhBrain, CaretDownIcon as PhCaretDown, ArrowClockwiseIcon as PhArrowClockwise } from "@phosphor-icons/react";

function BrainMark() {
  return <PhBrain size={13} weight="fill" aria-hidden />;
}

function ChevronIcon() {
  return <PhCaretDown size={14} weight="bold" aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function formatElapsed(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const FADE_MASK = {
  WebkitMaskImage: "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
  maskImage: "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
};

export function Reasoning({
  text,
  autoPlay = true,
  onComplete,
}: {
  /** Reasoning prose. Separate paragraphs with a blank line ("\n\n"). */
  text: string;
  autoPlay?: boolean;
  onComplete?: () => void;
}) {
  const paragraphs = useMemo(() => text.split("\n\n").map((p) => p.split(" ")), [text]);
  const totalWords = useMemo(() => paragraphs.reduce((sum, p) => sum + p.length, 0), [paragraphs]);

  const [playId, setPlayId] = useState(0);
  const [revealed, setRevealed] = useState(autoPlay ? 0 : totalWords);
  const [finished, setFinished] = useState(!autoPlay);
  const [collapsed, setCollapsed] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef(0);
  const userToggledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const panelId = "reasoning-panel";

  const delays = useMemo(
    () => Array.from({ length: totalWords }, () => 35 + Math.round(Math.random() * 45)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playId, totalWords]
  );

  useEffect(() => {
    if (!autoPlay) return;
    setRevealed(0);
    setFinished(false);
    setCollapsed(false);
    setElapsedMs(0);
    userToggledRef.current = false;
    startRef.current = performance.now();

    if (shouldReduceMotion) {
      setRevealed(totalWords);
      setFinished(true);
      onComplete?.();
      return;
    }

    let cancelled = false;
    let i = 0;
    const step = () => {
      if (cancelled) return;
      i += 1;
      setRevealed(i);
      if (i >= totalWords) {
        setFinished(true);
        onComplete?.();
        return;
      }
      timeout = setTimeout(step, delays[i] ?? 45);
    };
    let timeout = setTimeout(step, delays[0] ?? 45);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playId, autoPlay, shouldReduceMotion, delays, totalWords]);

  useEffect(() => {
    if (finished) return;
    let raf: number;
    const tick = () => {
      setElapsedMs(performance.now() - startRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [finished, playId]);

  useEffect(() => {
    if (!finished) return;
    const id = setTimeout(() => {
      if (!userToggledRef.current) setCollapsed(true);
    }, 650);
    return () => clearTimeout(id);
  }, [finished]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [revealed]);

  const toggle = () => {
    userToggledRef.current = true;
    setCollapsed((c) => !c);
  };
  const replay = () => setPlayId((id) => id + 1);
  const elapsedFormatted = formatElapsed(elapsedMs);

  let counted = 0;

  return (
    <div className="relative w-full max-w-md">
      {!finished && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-4 rounded-2xl opacity-30 blur-2xl"
          style={{ background: "radial-gradient(circle at 70% 20%, rgba(5,150,105,0.4), rgba(5,150,105,0) 65%)" }}
          animate={shouldReduceMotion ? undefined : { opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      <div className="relative rounded-2xl border border-stone-200 bg-white p-2 dark:border-stone-800 dark:bg-stone-900">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={panelId}
            className="flex flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/5"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
              <motion.span
                animate={shouldReduceMotion || finished ? undefined : { opacity: [1, 0.4, 1] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              >
                <BrainMark />
              </motion.span>
            </span>
            <span className="flex-1 text-sm font-medium text-stone-800 dark:text-stone-100">
              {finished ? `Reasoned for ${elapsedFormatted}` : "Reasoning"}
            </span>
            {!finished && (
              <span className="shrink-0 text-xs tabular-nums text-stone-500 dark:text-stone-500">{elapsedFormatted}</span>
            )}
            <motion.span
              animate={{ rotate: collapsed ? 0 : 180 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="shrink-0 text-stone-500"
            >
              <ChevronIcon />
            </motion.span>
          </button>
          {finished && autoPlay && (
            <button
              type="button"
              onClick={replay}
              aria-label="Replay reasoning"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
            >
              <ReplayIcon />
            </button>
          )}
        </div>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              id={panelId}
              role="region"
              aria-label="Model reasoning"
              initial={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={shouldReduceMotion ? { duration: 0.15 } : { height: { duration: 0.45, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
              className="overflow-hidden"
            >
              <motion.div
                initial={shouldReduceMotion ? undefined : { y: -10 }}
                animate={{ y: 0 }}
                transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
              >
              <div ref={scrollRef} data-lenis-prevent style={FADE_MASK} className="max-h-40 overflow-y-auto px-3 py-2 scrollbar-hide">
                {paragraphs.map((words, pi) => {
                  const start = counted;
                  counted += words.length;
                  const visibleCount = Math.max(0, Math.min(words.length, revealed - start));
                  if (visibleCount === 0) return null;
                  const isLastVisibleParagraph = revealed > start && revealed <= start + words.length;
                  return (
                    <p key={pi} className="mb-3 text-[13px] leading-relaxed text-stone-500 last:mb-0 dark:text-stone-400">
                      {words.slice(0, visibleCount).join(" ")}
                      {!finished && isLastVisibleParagraph && (
                        <motion.span
                          aria-hidden
                          className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-emerald-500"
                          animate={shouldReduceMotion ? undefined : { opacity: [1, 0, 1] }}
                          transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
                        />
                      )}
                    </p>
                  );
                })}
              </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <span className="sr-only" aria-live="polite">
          {finished ? `Finished reasoning in ${elapsedFormatted}` : "Reasoning in progress"}
        </span>
      </div>
    </div>
  );
}