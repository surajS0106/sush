"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { SparkleIcon as PhSparkle, CaretDownIcon as PhCaretDown, ArrowClockwiseIcon as PhArrowClockwise } from "@phosphor-icons/react";

interface ThoughtStep {
  label: string;
  detail?: string;
  /** Duration this step stays active, in ms. Defaults to 1100. */
  duration?: number;
}

function SparkleIcon() {
  return <PhSparkle size={13} weight="fill" aria-hidden />;
}

function ChevronIcon() {
  return <PhCaretDown size={14} weight="bold" aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <motion.path
        d="M20 6 9 17l-5-5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}

function formatElapsed(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function StepIndicator({ status, shouldReduceMotion }: { status: "pending" | "active" | "done"; shouldReduceMotion: boolean | null }) {
  if (status === "done") {
    return (
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white">
        <CheckIcon />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-emerald-400/25 border-t-emerald-500"
          animate={shouldReduceMotion ? undefined : { rotate: 360 }}
          transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
        />
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
    );
  }
  return <span className="h-6 w-6 shrink-0 rounded-full border-2 border-stone-200 dark:border-stone-700" />;
}

export function ChainOfThought({
  steps,
  autoPlay = true,
  onComplete,
}: {
  steps: ThoughtStep[];
  autoPlay?: boolean;
  onComplete?: () => void;
}) {
  const [playId, setPlayId] = useState(0);
  return (
    <ChainOfThoughtRun
      key={playId}
      steps={steps}
      autoPlay={autoPlay}
      onComplete={onComplete}
      onReplay={() => setPlayId((id) => id + 1)}
    />
  );
}

function ChainOfThoughtRun({
  steps,
  autoPlay,
  onComplete,
  onReplay,
}: {
  steps: ThoughtStep[];
  autoPlay: boolean;
  onComplete?: () => void;
  onReplay: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [finished, setFinished] = useState(!autoPlay);
  const [collapsed, setCollapsed] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef(0);
  const userToggledRef = useRef(false);
  const shouldReduceMotion = useReducedMotion();
  const panelId = "chain-of-thought-panel";

  useEffect(() => {
    if (!autoPlay) return;
    startRef.current = performance.now();
    let cumulative = 0;
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    steps.forEach((step, i) => {
      const d = shouldReduceMotion ? 60 : (step.duration ?? 1100);
      cumulative += d;
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return;
          if (i === steps.length - 1) {
            setFinished(true);
            onComplete?.();
          } else {
            setCurrentIndex(i + 1);
          }
        }, cumulative)
      );
    });

    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, shouldReduceMotion]);

  useEffect(() => {
    if (finished) return;
    let raf: number;
    const tick = () => {
      setElapsedMs(performance.now() - startRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [finished]);

  useEffect(() => {
    if (!finished) return;
    const id = setTimeout(() => {
      if (!userToggledRef.current) setCollapsed(true);
    }, 650);
    return () => clearTimeout(id);
  }, [finished]);

  const toggle = () => {
    userToggledRef.current = true;
    setCollapsed((c) => !c);
  };

  const elapsedFormatted = formatElapsed(elapsedMs);
  const statusOf = (i: number): "pending" | "active" | "done" =>
    i < currentIndex || (i === currentIndex && finished) ? "done" : i === currentIndex ? "active" : "pending";

  return (
    <div className="relative w-full max-w-md">
      {!finished && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-4 rounded-2xl opacity-30 blur-2xl"
          style={{ background: "radial-gradient(circle at 30% 30%, rgba(5,150,105,0.45), rgba(5,150,105,0) 65%)" }}
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
                animate={shouldReduceMotion || finished ? undefined : { rotate: [0, 15, -10, 0] }}
                transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
              >
                <SparkleIcon />
              </motion.span>
            </span>
            <span className="flex-1 text-sm font-medium text-stone-800 dark:text-stone-100">
              {finished ? `Thought for ${elapsedFormatted}` : "Thinking"}
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
              onClick={onReplay}
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
              aria-label="Reasoning steps"
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
                className="px-3 pb-2 pt-2"
              >
                {steps.map((step, i) => {
                  const status = statusOf(i);
                  const reached = i <= currentIndex || finished;
                  return (
                    <div key={step.label} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <StepIndicator status={status} shouldReduceMotion={shouldReduceMotion} />
                        {i < steps.length - 1 && (
                          <span className="relative my-1 w-px flex-1 bg-stone-200 dark:bg-stone-700">
                            <motion.span
                              aria-hidden
                              className="absolute inset-0 origin-top bg-emerald-500"
                              initial={{ scaleY: 0 }}
                              animate={{ scaleY: status === "done" ? 1 : 0 }}
                              transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                            />
                          </span>
                        )}
                      </div>
                      <div className="flex-1 pb-4 last:pb-0">
                        <p
                          className={`pt-0.5 text-sm font-medium transition-colors ${
                            status === "pending"
                              ? "text-stone-400 dark:text-stone-600"
                              : "text-stone-800 dark:text-stone-100"
                          }`}
                        >
                          {step.label}
                        </p>
                        <AnimatePresence>
                          {step.detail && reached && (
                            <motion.p
                              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                              className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-500"
                            >
                              {step.detail}
                            </motion.p>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <span className="sr-only" aria-live="polite">
          {finished ? `Finished thinking in ${elapsedFormatted}` : `Thinking: step ${currentIndex + 1} of ${steps.length}, ${steps[currentIndex].label}`}
        </span>
      </div>
    </div>
  );
}