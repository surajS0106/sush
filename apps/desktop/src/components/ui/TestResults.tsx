"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CaretRightIcon as PhCaretRight, CheckIcon as PhCheck, XIcon as PhX, ArrowClockwiseIcon as PhArrowClockwise } from "@phosphor-icons/react";

type TestStatus = "pending" | "running" | "pass" | "fail";

interface TestCase {
  name: string;
  outcome: "pass" | "fail";
  message?: string;
  duration: number;
}

function ChevronIcon() {
  return <PhCaretRight size={12} weight="bold" aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={11} weight="bold" aria-hidden />;
}

function XIcon() {
  return <PhX size={11} weight="bold" aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function formatElapsed(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusIcon({ status, shouldReduceMotion }: { status: TestStatus; shouldReduceMotion: boolean | null }) {
  if (status === "pass") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-green-700 text-white">
        <CheckIcon />
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-white">
        <XIcon />
      </span>
    );
  }
  if (status === "running") {
    return (
      <motion.span
        aria-hidden
        className="h-4 w-4 shrink-0 rounded-full border-2 border-green-400/25 border-t-green-500"
        animate={shouldReduceMotion ? undefined : { rotate: 360 }}
        transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
      />
    );
  }
  return <span className="h-4 w-4 shrink-0 rounded-full border-2 border-stone-200 dark:border-stone-700" />;
}

export function TestResults({
  suite,
  tests,
  autoPlay = true,
}: {
  suite: string;
  tests: TestCase[];
  autoPlay?: boolean;
}) {
  const [playId, setPlayId] = useState(0);
  return <TestResultsRun key={playId} suite={suite} tests={tests} autoPlay={autoPlay} onReplay={() => setPlayId((id) => id + 1)} />;
}

function TestResultsRun({
  suite,
  tests,
  autoPlay,
  onReplay,
}: {
  suite: string;
  tests: TestCase[];
  autoPlay: boolean;
  onReplay: () => void;
}) {
  const [statuses, setStatuses] = useState<TestStatus[]>(() => (autoPlay ? tests.map(() => "pending") : tests.map((t) => t.outcome)));
  const [finished, setFinished] = useState(!autoPlay);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef(0);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (!autoPlay) return;
    startRef.current = performance.now();
    let cumulative = 0;
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    tests.forEach((test, i) => {
      const d = shouldReduceMotion ? 30 : test.duration;
      const startAt = cumulative;
      const endAt = cumulative + d;
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return;
          setStatuses((s) => s.map((v, idx) => (idx === i ? "running" : v)));
        }, startAt)
      );
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return;
          setStatuses((s) => s.map((v, idx) => (idx === i ? test.outcome : v)));
        }, endAt)
      );
      cumulative = endAt;
    });
    timeouts.push(
      setTimeout(() => {
        if (!cancelled) setFinished(true);
      }, cumulative + 150)
    );

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

  const passed = statuses.filter((s) => s === "pass").length;
  const failed = statuses.filter((s) => s === "fail").length;
  const total = tests.length;
  const passedPct = (passed / total) * 100;
  const failedPct = (failed / total) * 100;

  return (
    <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-1 flex items-center gap-2">
        <p className="truncate font-mono text-xs font-medium text-stone-500 dark:text-stone-400">{suite}</p>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-stone-500 dark:text-stone-500">
          {finished ? `Ran in ${formatElapsed(elapsedMs)}` : formatElapsed(elapsedMs)}
        </span>
        {finished && autoPlay && (
          <button
            type="button"
            onClick={onReplay}
            aria-label="Re-run tests"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
          >
            <ReplayIcon />
          </button>
        )}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100 dark:bg-white/10">
          <motion.span className="h-full bg-green-500" animate={{ width: `${passedPct}%` }} transition={{ duration: 0.25 }} />
          <motion.span className="h-full bg-red-500" animate={{ width: `${failedPct}%` }} transition={{ duration: 0.25 }} />
        </div>
        <p className="shrink-0 text-xs text-stone-500 dark:text-stone-500">
          <span className="font-medium text-green-600 dark:text-green-400">{passed} passed</span>
          {failed > 0 && (
            <>
              {" · "}
              <span className="font-medium text-red-600 dark:text-red-400">{failed} failed</span>
            </>
          )}
        </p>
      </div>

      <ul className="flex flex-col" role="list">
        {tests.map((test, i) => {
          const status = statuses[i];
          const resolved = status === "pass" || status === "fail";
          const canExpand = status === "fail";
          const isExpanded = expanded === i;
          return (
            <li key={test.name} className="border-t border-stone-100 first:border-t-0 dark:border-white/5">
              <button
                type="button"
                disabled={!canExpand}
                onClick={() => setExpanded((e) => (e === i ? null : i))}
                className="flex w-full items-center gap-2.5 py-2 text-left disabled:cursor-default"
              >
                <StatusIcon status={status} shouldReduceMotion={shouldReduceMotion} />
                <span className={`min-w-0 flex-1 truncate text-sm ${resolved ? "text-stone-700 dark:text-stone-200" : "text-stone-400 dark:text-stone-600"}`}>
                  {test.name}
                </span>
                {canExpand && (
                  <motion.span
                    animate={{ rotate: isExpanded ? 90 : 0 }}
                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                    className="shrink-0 text-stone-500"
                  >
                    <ChevronIcon />
                  </motion.span>
                )}
              </button>
              <AnimatePresence initial={false}>
                {canExpand && isExpanded && (
                  <motion.div
                    initial={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                    exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={shouldReduceMotion ? { duration: 0.15 } : { height: { duration: 0.4, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } }}
                    className="overflow-hidden"
                  >
                    <motion.p
                      initial={shouldReduceMotion ? undefined : { y: -8 }}
                      animate={{ y: 0 }}
                      transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
                      className="mb-2 ml-6 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs leading-relaxed text-red-700 dark:text-red-400"
                    >
                      {test.message}
                    </motion.p>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </div>
  );
}