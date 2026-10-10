"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  WrenchIcon as PhWrench,
  CaretDownIcon as PhCaretDown,
  ArrowClockwiseIcon as PhArrowClockwise,
  CheckIcon as PhCheck,
  XIcon as PhX,
} from "@phosphor-icons/react";

type Status = "pending" | "running" | "streaming" | "success" | "error";
type ToolOutcome = "success" | "error";
type ToolVariant = "ambient" | "light" | "dark";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");
const formatElapsed = (ms: number) => (ms / 1000).toFixed(1) + "s";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// A call that runs this long fills the latency rail edge to edge. Anything
// past it is pinned at full and just reads as "slow".
const RAIL_FULL_MS = 3200;

const SURFACE: Record<
  ToolVariant,
  {
    card: string;
    divider: string;
    headerHover: string;
    iconBox: string;
    title: string;
    label: string;
    chipIdle: string;
    replayHover: string;
    railTrack: string;
    tick: string;
    kvKey: string;
    kvValue: string;
    caption: string;
  }
> = {
  ambient: {
    card: "border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900",
    divider: "border-stone-100 dark:border-white/[0.06]",
    headerHover: "hover:bg-black/[0.03] dark:hover:bg-white/5",
    iconBox: "bg-stone-900/[0.05] text-stone-500 dark:bg-white/10 dark:text-stone-300",
    title: "text-stone-800 dark:text-stone-100",
    label: "text-stone-500 dark:text-stone-500",
    chipIdle: "bg-stone-100 text-stone-500 dark:bg-white/[0.06] dark:text-stone-400",
    replayHover:
      "text-stone-500 hover:bg-black/5 hover:text-stone-600 dark:hover:bg-white/10 dark:hover:text-stone-300",
    railTrack: "bg-stone-100 dark:bg-white/[0.06]",
    tick: "bg-stone-400/70 dark:bg-white/25",
    kvKey: "text-stone-500 dark:text-stone-500",
    kvValue: "text-stone-700 dark:text-stone-200",
    caption: "text-stone-500 dark:text-stone-500",
  },
  light: {
    card: "border-stone-200 bg-white",
    divider: "border-stone-100",
    headerHover: "hover:bg-black/[0.03]",
    iconBox: "bg-stone-900/[0.05] text-stone-500",
    title: "text-stone-800",
    label: "text-stone-500",
    chipIdle: "bg-stone-100 text-stone-500",
    replayHover: "text-stone-500 hover:bg-black/5 hover:text-stone-600",
    railTrack: "bg-stone-100",
    tick: "bg-stone-400/70",
    kvKey: "text-stone-500",
    kvValue: "text-stone-700",
    caption: "text-stone-500",
  },
  dark: {
    card: "border-white/10 bg-stone-900",
    divider: "border-white/[0.06]",
    headerHover: "hover:bg-white/5",
    iconBox: "bg-white/10 text-stone-300",
    title: "text-stone-100",
    label: "text-stone-500",
    chipIdle: "bg-white/[0.06] text-stone-500",
    replayHover: "text-stone-500 hover:bg-white/10 hover:text-stone-300",
    railTrack: "bg-white/[0.06]",
    tick: "bg-white/25",
    kvKey: "text-stone-500",
    kvValue: "text-stone-200",
    caption: "text-stone-500",
  },
};

const CHIP_TONE: Record<Status, string> = {
  pending: "",
  running: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  streaming: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  success: "bg-green-500/10 text-green-700 dark:text-green-400",
  error: "bg-red-500/10 text-red-700 dark:text-red-400",
};

function ChipGlyph({ status, reduce }: { status: Status; reduce: boolean | null }) {
  if (status === "running") {
    return (
      <motion.span
        aria-hidden
        className="h-2.5 w-2.5 rounded-full border-2 border-amber-500/30 border-t-amber-600 dark:border-amber-400/30 dark:border-t-amber-300"
        animate={reduce ? undefined : { rotate: 360 }}
        transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
      />
    );
  }
  if (status === "streaming") {
    return (
      <span aria-hidden className="flex items-center gap-[3px]">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 w-1 rounded-full bg-current"
            animate={reduce ? undefined : { opacity: [0.3, 1, 0.3], y: [0, -1.5, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: i * 0.15 }}
          />
        ))}
      </span>
    );
  }
  if (status === "success") return <PhCheck size={11} weight="bold" aria-hidden />;
  if (status === "error") return <PhX size={11} weight="bold" aria-hidden />;
  return <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />;
}

function StatusChip({
  status,
  elapsedMs,
  reduce,
  idleTone,
}: {
  status: Status;
  elapsedMs: number;
  reduce: boolean | null;
  idleTone: string;
}) {
  const label =
    status === "pending"
      ? "Queued"
      : status === "running"
        ? "Running"
        : status === "streaming"
          ? "Streaming"
          : status === "success"
            ? "Success"
            : "Failed";
  return (
    <motion.span
      layout
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        status === "pending" ? idleTone : CHIP_TONE[status]
      )}
    >
      <ChipGlyph status={status} reduce={reduce} />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={status}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          transition={{ duration: 0.15 }}
          className="tabular-nums"
        >
          {label}
          {status !== "pending" ? " · " + formatElapsed(elapsedMs) : ""}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

function LatencyRail({
  status,
  elapsedMs,
  p50Ms,
  tone,
  reduce,
}: {
  status: Status;
  elapsedMs: number;
  p50Ms?: number;
  tone: (typeof SURFACE)[ToolVariant];
  reduce: boolean | null;
}) {
  if (status === "pending") return null;

  const active = status === "running" || status === "streaming";
  const done = status === "success" || status === "error";
  const frac = Math.min(Math.max(elapsedMs / RAIL_FULL_MS, 0.03), 1);
  const p50Frac = p50Ms != null ? Math.min(p50Ms / RAIL_FULL_MS, 1) : null;
  const barColor = status === "error" ? "bg-red-500" : status === "success" ? "bg-green-500" : "bg-amber-500";
  const delta = done && p50Ms != null ? elapsedMs - p50Ms : null;

  return (
    <div className="px-4 pb-1.5 pt-1">
      <div className={cx("relative h-1 overflow-hidden rounded-full", tone.railTrack)}>
        {active && !reduce ? (
          <motion.span
            aria-hidden
            className={cx("absolute inset-y-0 w-1/3 rounded-full opacity-70", barColor)}
            initial={{ x: "-120%" }}
            animate={{ x: "360%" }}
            transition={{ duration: 1.1, ease: "easeInOut", repeat: Infinity }}
          />
        ) : (
          <motion.span
            aria-hidden
            className={cx("absolute inset-y-0 left-0 rounded-full", barColor)}
            initial={false}
            animate={{ width: (done ? frac : 0.5) * 100 + "%" }}
            transition={reduce ? { duration: 0 } : { duration: 0.5, ease: EASE }}
          />
        )}
        {p50Frac != null && (
          <span
            aria-hidden
            className={cx("absolute inset-y-[-1px] w-px", tone.tick)}
            style={{ left: p50Frac * 100 + "%" }}
          />
        )}
      </div>
      {done && p50Ms != null && (
        <div className={cx("mt-1 flex items-center justify-between font-mono text-[11px] tabular-nums", tone.caption)}>
          <span>p50 {formatElapsed(p50Ms)}</span>
          <span>
            {formatElapsed(elapsedMs)}
            {delta != null &&
              (Math.abs(delta) < 50 ? (
                <span className="ml-1.5 text-green-600 dark:text-green-400">on p50</span>
              ) : (
                <span
                  className={cx(
                    "ml-1.5",
                    delta < 0 ? "text-green-600 dark:text-green-400" : "text-amber-700 dark:text-amber-400"
                  )}
                >
                  {(delta < 0 ? "-" : "+") + formatElapsed(Math.abs(delta))} {delta < 0 ? "vs p50" : "over p50"}
                </span>
              ))}
          </span>
        </div>
      )}
    </div>
  );
}

function SectionLabel({
  children,
  count,
  tone,
}: {
  children: ReactNode;
  count?: number;
  tone: (typeof SURFACE)[ToolVariant];
}) {
  return (
    <p
      className={cx(
        "mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em]",
        tone.label
      )}
    >
      {children}
      {count != null && (
        <span className="font-mono text-[11px] font-normal normal-case tabular-nums opacity-70">{count}</span>
      )}
    </p>
  );
}

function Caret() {
  return (
    <span className="ml-0.5 inline-block h-3 w-px translate-y-[2px] animate-pulse bg-current align-baseline motion-reduce:animate-none" />
  );
}

function KeyValueRows({
  rows,
  typing,
  tone,
}: {
  rows: Array<[string, string]>;
  typing: { row: number; chars: number } | null;
  tone: (typeof SURFACE)[ToolVariant];
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
      {rows.map(([key, value], i) => {
        const isTyping = typing != null && i === typing.row;
        const shown = isTyping ? value.slice(0, typing.chars) : value;
        return (
          <Fragment key={key}>
            <span className={cx("font-mono text-xs", tone.kvKey)}>{key}</span>
            <span className={cx("truncate font-mono text-xs", tone.kvValue)}>
              {shown}
              {isTyping && <Caret />}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

// A self-playing tool-call card: queued -> running (args dispatched) ->
// streaming (result types in row by row) -> success, or queued -> running ->
// failed. The header collapses the body; the hairline under it is a latency
// rail that sweeps while the call is in flight, then locks to the measured
// duration against a p50 tick. Replay re-runs the same outcome.
export function Tool(props: {
  name: string;
  input: Record<string, string>;
  output: Record<string, string>;
  outcome?: ToolOutcome;
  errorMessage?: string;
  variant?: ToolVariant;
  p50Ms?: number;
  defaultOpen?: boolean;
}) {
  const [playId, setPlayId] = useState(0);
  return <ToolRun key={playId} {...props} onReplay={() => setPlayId((n) => n + 1)} />;
}

function ToolRun({
  name,
  input,
  output,
  outcome = "success",
  errorMessage = "The tool call failed.",
  variant = "ambient",
  p50Ms,
  defaultOpen = true,
  onReplay,
}: {
  name: string;
  input: Record<string, string>;
  output: Record<string, string>;
  outcome?: ToolOutcome;
  errorMessage?: string;
  variant?: ToolVariant;
  p50Ms?: number;
  defaultOpen?: boolean;
  onReplay: () => void;
}) {
  const reduce = useReducedMotion();
  const tone = SURFACE[variant];
  const panelId = "tool-panel";

  const inputEntries = useMemo(() => Object.entries(input), [input]);
  const outputEntries = useMemo(() => Object.entries(output), [output]);

  const [status, setStatus] = useState<Status>("pending");
  const [open, setOpen] = useState(defaultOpen);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sweep, setSweep] = useState(false);
  const [revealRows, setRevealRows] = useState(0);
  const [typedChars, setTypedChars] = useState(0);
  const startRef = useRef(0);

  const done = status === "success" || status === "error";

  // Timeline: pending -> running -> (streaming | error). The component is
  // remounted (via key) to replay or to switch outcome, so mount state is
  // always the clean "pending" starting point.
  useEffect(() => {
    const t1 = setTimeout(
      () => {
        startRef.current = performance.now();
        setStatus("running");
        setSweep(!reduce);
      },
      reduce ? 20 : 340
    );
    const t2 = setTimeout(
      () => setStatus(outcome === "error" ? "error" : "streaming"),
      reduce ? 60 : 1050
    );
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [outcome, reduce]);

  // Live duration counter, running from dispatch to resolution.
  useEffect(() => {
    if (status === "pending" || done) return;
    let raf = 0;
    const tick = () => {
      setElapsedMs(performance.now() - startRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, done]);

  // Stream the result: reveal one row at a time, typing its value out.
  useEffect(() => {
    if (status !== "streaming") return;

    if (reduce) {
      const t = setTimeout(() => {
        setRevealRows(outputEntries.length);
        setTypedChars(Number.MAX_SAFE_INTEGER);
        setElapsedMs(performance.now() - startRef.current);
        setStatus("success");
      }, 80);
      return () => clearTimeout(t);
    }

    let cancelled = false;
    let row = 0;
    let char = 0;
    let timer: ReturnType<typeof setTimeout>;

    const step = () => {
      if (cancelled) return;
      const entry = outputEntries[row];
      if (!entry) return;
      const value = entry[1];
      if (char < value.length) {
        char += 1;
        setTypedChars(char);
        timer = setTimeout(step, 15 + Math.random() * 24);
      } else if (row < outputEntries.length - 1) {
        row += 1;
        char = 0;
        setRevealRows(row + 1);
        setTypedChars(0);
        timer = setTimeout(step, 150);
      } else {
        timer = setTimeout(() => {
          if (cancelled) return;
          setElapsedMs(performance.now() - startRef.current);
          setStatus("success");
        }, 280);
      }
    };
    timer = setTimeout(() => {
      setRevealRows(1);
      setTypedChars(0);
      step();
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, reduce, outputEntries]);

  const outputRows =
    status === "success" ? outputEntries : outputEntries.slice(0, revealRows);
  const typing =
    status === "streaming" ? { row: revealRows - 1, chars: typedChars } : null;

  return (
    <div className={cx("w-full max-w-md overflow-hidden rounded-xl border shadow-sm", tone.card)}>
      <div className="flex items-center gap-1 p-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={cx(
            "flex flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
            tone.headerHover
          )}
        >
          <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", tone.iconBox)}>
            <PhWrench size={13} weight="bold" aria-hidden />
          </span>
          <span className={cx("flex-1 truncate font-mono text-sm font-medium", tone.title)}>{name}</span>
          <StatusChip status={status} elapsedMs={elapsedMs} reduce={reduce} idleTone={tone.chipIdle} />
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="shrink-0 text-stone-500"
          >
            <PhCaretDown size={14} weight="bold" aria-hidden />
          </motion.span>
        </button>
        {done && (
          <button
            type="button"
            onClick={onReplay}
            aria-label="Run again"
            className={cx(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
              tone.replayHover
            )}
          >
            <PhArrowClockwise size={14} aria-hidden />
          </button>
        )}
      </div>

      <LatencyRail status={status} elapsedMs={elapsedMs} p50Ms={p50Ms} tone={tone} reduce={reduce} />

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-label="Tool call details"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={
              reduce
                ? { duration: 0.15 }
                : { height: { duration: 0.4, ease: EASE }, opacity: { duration: 0.28, ease: EASE } }
            }
            className={cx("overflow-hidden border-t", tone.divider)}
          >
            <div className="flex flex-col gap-3 px-4 py-3">
              <div
                className={cx(
                  "relative overflow-hidden transition-opacity duration-300",
                  (status === "streaming" || done) && "opacity-60"
                )}
              >
                <SectionLabel tone={tone} count={inputEntries.length}>
                  Input
                </SectionLabel>
                <KeyValueRows rows={inputEntries} typing={null} tone={tone} />
                {sweep && !reduce && (
                  <motion.span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 -inset-x-2"
                    initial={{ x: "-120%" }}
                    animate={{ x: "120%" }}
                    transition={{ duration: 0.7, ease: EASE }}
                    onAnimationComplete={() => setSweep(false)}
                    style={{
                      background:
                        "linear-gradient(90deg, transparent, rgba(16,185,129,0.16), transparent)",
                    }}
                  />
                )}
              </div>

              <AnimatePresence mode="popLayout">
                {(status === "streaming" || status === "success") && (
                  <motion.div
                    key="output"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE }}
                  >
                    <SectionLabel tone={tone} count={outputEntries.length}>
                      Output
                    </SectionLabel>
                    <KeyValueRows rows={outputRows} typing={typing} tone={tone} />
                  </motion.div>
                )}
                {status === "error" && (
                  <motion.div
                    key="error"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: EASE }}
                  >
                    <SectionLabel tone={tone}>Error</SectionLabel>
                    <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs leading-relaxed text-red-700 dark:text-red-400">
                      {errorMessage}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <span className="sr-only" aria-live="polite">
        {status === "pending"
          ? "Tool call queued"
          : status === "running"
            ? "Running " + name
            : status === "streaming"
              ? "Streaming result from " + name
              : status === "success"
                ? name + " finished in " + formatElapsed(elapsedMs)
                : name + " failed: " + errorMessage}
      </span>
    </div>
  );
}

/*
Usage:

<Tool
  name="get_weather"
  input={{ city: "Tokyo", unit: "celsius" }}
  output={{ temperature: "22°C", condition: "Partly cloudy", humidity: "58%" }}
  p50Ms={2000}
/>

// Failure path:
<Tool
  name="get_weather"
  input={{ city: "Tokyo", unit: "celsius" }}
  output={{}}
  outcome="error"
  errorMessage="Request timed out after 10s; the weather service never responded."
/>
*/
