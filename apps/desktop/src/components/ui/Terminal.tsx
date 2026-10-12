"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { motion, steps, useReducedMotion } from "framer-motion";
import { TerminalIcon as PhTerminal, ArrowClockwiseIcon as PhArrowClockwise } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

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
      className="ml-0.5 inline-block h-3.5 w-1.75 translate-y-0.5 bg-brand"
      animate={shouldReduceMotion ? undefined : { opacity: [1, 0, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: steps(2) }}
    />
  );
}

// The pieces below draw a live terminal in the same style: the card and its
// header, a button for the header, and a prompt line the user types at.

/** The card with the "Terminal" header; `children` is the scrolling body. */
export function TerminalFrame({
  title = "Terminal",
  meta,
  actions,
  className,
  children,
}: {
  title?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900",
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-200 bg-stone-50 pr-2 pl-4 dark:border-white/10 dark:bg-white/2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-brand/15 text-brand">
          <TerminalIcon />
        </span>
        <span className="shrink-0 text-xs font-medium text-stone-600 dark:text-stone-300">{title}</span>
        {meta && <span className="min-w-0 truncate text-xs text-stone-400 dark:text-stone-500">{meta}</span>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** An icon button styled for the terminal header (same look as Replay). */
export function TerminalHeaderButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-stone-200 [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

/** The `$` prompt, optionally after a short label such as the folder name. */
export function TerminalPrompt({ label, symbol = "$" }: { label?: string; symbol?: string }) {
  return (
    <span className="shrink-0 whitespace-pre">
      {label && <span className="text-stone-400 dark:text-stone-500">{label} </span>}
      <span className="text-brand">{symbol}</span>{" "}
    </span>
  );
}

/**
 * A prompt line to type at. The real input sits invisibly over a mirror of its
 * text, so the caret can be drawn as the blinking block (hollow when unfocused).
 */
export function TerminalInput({
  prompt,
  value,
  onValueChange,
  inputRef,
  placeholder,
  className,
  onFocus,
  onBlur,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange"> & {
  prompt?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const at = Math.min(caret, value.length);
  const mirror = useRef<HTMLSpanElement>(null);
  // Keep the mirror scrolled with the input once a long line overflows it.
  const sync = (el: HTMLInputElement) => {
    if (mirror.current) mirror.current.scrollLeft = el.scrollLeft;
  };
  const track = (el: HTMLInputElement) => {
    setCaret(el.selectionStart ?? el.value.length);
    requestAnimationFrame(() => sync(el));
  };

  const own = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) inputRef.current = el;
  };

  // Value set from outside (history, completion) moves the real caret, and
  // so does `setSelectionRange`; follow it either way.
  useLayoutEffect(() => {
    if (own.current) track(own.current);
  }, [value]);
  useEffect(() => {
    const onChange = () => {
      if (own.current && document.activeElement === own.current) track(own.current);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  return (
    <div className={cn("flex items-baseline", className)}>
      {prompt}
      <span className="relative min-w-0 flex-1">
        <span ref={mirror} aria-hidden className="block overflow-hidden whitespace-pre text-stone-800 dark:text-stone-200">
          {value.slice(0, at)}
          <span className="relative">
            <motion.span
              className={cn(
                "absolute top-0.5 left-0 h-3.5 w-1.75",
                focused ? "bg-brand/80" : "border border-brand/70",
              )}
              animate={focused && !shouldReduceMotion ? { opacity: [1, 0, 1] } : { opacity: 1 }}
              transition={focused && !shouldReduceMotion ? { duration: 1, repeat: Infinity, ease: steps(2) } : { duration: 0 }}
            />
          </span>
          {value.slice(at)}
          {!value && placeholder && <span className="pl-3 text-stone-400 dark:text-stone-500">{placeholder}</span>}
          {"​"}
        </span>
        <input
          ref={setRef}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
            track(e.currentTarget);
          }}
          onSelect={(e) => track(e.currentTarget)}
          onScroll={(e) => sync(e.currentTarget)}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          className="absolute inset-0 w-full border-0 bg-transparent p-0 font-[inherit] text-transparent caret-transparent outline-none selection:bg-brand/25 selection:text-transparent"
          {...props}
        />
      </span>
    </div>
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
      <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2.5 dark:border-white/10 dark:bg-white/2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-brand/15 text-brand">
          <TerminalIcon />
        </span>
        <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Terminal</span>
        {finished && autoPlay && (
          <button
            type="button"
            onClick={onReplay}
            aria-label="Replay commands"
            className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:hover:bg-white/10 dark:hover:text-stone-200"
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
                <span className="text-brand">$</span> {c.cmd.slice(0, typedLen)}
                {stillTyping && <Cursor shouldReduceMotion={shouldReduceMotion} />}
              </p>
              {showingOutput &&
                c.output.slice(0, outputCount).map((line, li) => (
                  <p key={li} className={`pl-3 ${line.tone === "success" ? "text-brand" : "text-stone-500 dark:text-stone-400"}`}>
                    {line.text}
                  </p>
                ))}
            </div>
          );
        })}
        {finished && (
          <p className="text-stone-800 dark:text-stone-200">
            <span className="text-brand">$</span> <Cursor shouldReduceMotion={shouldReduceMotion} />
          </p>
        )}
      </div>
    </div>
  );
}