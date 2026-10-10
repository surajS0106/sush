"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, steps, useReducedMotion } from "framer-motion";
import { TerminalIcon as PhTerminal, ArrowClockwiseIcon as PhArrowClockwise } from "@phosphor-icons/react";

interface OutputLine {
  text: string;
  tone?: "success";
}

interface Command {
  cmd: string;
  output: OutputLine[];
}

const CHAR_MS = 18;
const LINE_MS = 260;
const POST_TYPE_PAUSE = 220;
const POST_OUTPUT_PAUSE = 180;

interface Snapshot {
  cmdIndex: number;
  typedLen: number;
  outputRevealed: number;
  phase: "typing" | "output";
}

interface ScheduleStep {
  delay: number;
  snapshot: Snapshot;
}

function buildSchedule(commands: Command[]): ScheduleStep[] {
  const steps: ScheduleStep[] = [];
  let t = 0;
  commands.forEach((c, ci) => {
    for (let i = 1; i <= c.cmd.length; i++) {
      t += CHAR_MS;
      steps.push({ delay: t, snapshot: { cmdIndex: ci, typedLen: i, outputRevealed: 0, phase: "typing" } });
    }
    t += POST_TYPE_PAUSE;
    c.output.forEach((_, oi) => {
      t += LINE_MS;
      steps.push({ delay: t, snapshot: { cmdIndex: ci, typedLen: c.cmd.length, outputRevealed: oi + 1, phase: "output" } });
    });
    t += POST_OUTPUT_PAUSE;
  });
  return steps;
}

function TerminalIcon() {
  return <PhTerminal size={13} aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function Cursor({ shouldReduceMotion }: { shouldReduceMotion: boolean | null }) {
  return (
    <motion.span
      aria-hidden
      className="ml-0.5 inline-block h-3.5 w-[7px] translate-y-0.5 bg-emerald-600 dark:bg-emerald-500"
      animate={shouldReduceMotion ? undefined : { opacity: [1, 0, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: steps(2) }}
    />
  );
}

export function Terminal({ commands, autoPlay = true }: { commands: Command[]; autoPlay?: boolean }) {
  const [playId, setPlayId] = useState(0);
  return <TerminalRun key={playId} commands={commands} autoPlay={autoPlay} onReplay={() => setPlayId((id) => id + 1)} />;
}

function TerminalRun({
  commands,
  autoPlay,
  onReplay,
}: {
  commands: Command[];
  autoPlay: boolean;
  onReplay: () => void;
}) {
  const schedule = useMemo(() => buildSchedule(commands), [commands]);
  const [stepIndex, setStepIndex] = useState(autoPlay ? -1 : schedule.length - 1);
  const [finished, setFinished] = useState(!autoPlay);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (!autoPlay) return;
    let cancelled = false;

    if (shouldReduceMotion) {
      const t = setTimeout(() => {
        if (cancelled) return;
        setStepIndex(schedule.length - 1);
        setFinished(true);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }

    const timeouts = schedule.map((s, i) =>
      setTimeout(() => {
        if (!cancelled) setStepIndex(i);
      }, s.delay)
    );
    const finishDelay = (schedule[schedule.length - 1]?.delay ?? 0) + 200;
    timeouts.push(
      setTimeout(() => {
        if (!cancelled) setFinished(true);
      }, finishDelay)
    );

    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
  }, [schedule, autoPlay, shouldReduceMotion]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [stepIndex]);

  const snapshot = stepIndex >= 0 ? schedule[stepIndex]?.snapshot ?? null : null;

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_25px_60px_-25px_rgba(0,0,0,0.15)] dark:border-white/10 dark:bg-stone-900 dark:shadow-[0_25px_60px_-25px_rgba(0,0,0,0.6)]">
      <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2.5 dark:border-white/10 dark:bg-white/[0.02]">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
          <TerminalIcon />
        </span>
        <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Terminal</span>
        {finished && autoPlay && (
          <button
            type="button"
            onClick={onReplay}
            aria-label="Replay commands"
            className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-emerald-400"
          >
            <ReplayIcon />
          </button>
        )}
      </div>

      <div ref={scrollRef} data-lenis-prevent className="max-h-64 overflow-y-auto overscroll-contain px-4 py-3 font-mono text-[13px] leading-relaxed scrollbar-hide">
        {commands.map((c, ci) => {
          if (!snapshot || ci > snapshot.cmdIndex) return null;
          const isCurrent = ci === snapshot.cmdIndex;
          const typedLen = isCurrent ? snapshot.typedLen : c.cmd.length;
          const showingOutput = !isCurrent || snapshot.phase === "output";
          const outputCount = isCurrent ? snapshot.outputRevealed : c.output.length;
          const stillTyping = isCurrent && snapshot.phase === "typing";
          return (
            <div key={ci} className="mb-2 last:mb-0">
              <p className="text-stone-800 dark:text-stone-200">
                <span className="text-emerald-700 dark:text-emerald-500">$</span> {c.cmd.slice(0, typedLen)}
                {stillTyping && <Cursor shouldReduceMotion={shouldReduceMotion} />}
              </p>
              {showingOutput &&
                c.output.slice(0, outputCount).map((line, li) => (
                  <p key={li} className={`pl-3 ${line.tone === "success" ? "text-emerald-700 dark:text-emerald-400" : "text-stone-500 dark:text-stone-400"}`}>
                    {line.text}
                  </p>
                ))}
            </div>
          );
        })}
        {finished && (
          <p className="text-stone-800 dark:text-stone-200">
            <span className="text-emerald-700 dark:text-emerald-500">$</span> <Cursor shouldReduceMotion={shouldReduceMotion} />
          </p>
        )}
      </div>
    </div>
  );
}