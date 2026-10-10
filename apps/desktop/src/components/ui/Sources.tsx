"use client";

import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CaretDownIcon as PhCaretDown } from "@phosphor-icons/react";

export interface Source {
  n: number;
  title: string;
  domain: string;
  letter: string;
  tone: string;
  url?: string;
}

type AnswerPart = { text?: string; cite?: number };
type SourcesVariant = "ambient" | "light" | "dark";

const SURFACE: Record<SourcesVariant, {
  card: string;
  answer: string;
  chip: string;
  chipLabel: string;
  rowHover: string;
  rowActive: string;
  rowTitle: string;
  rowDomain: string;
  badgeIdle: string;
}> = {
  ambient: {
    card: "border-stone-200/70 bg-white/95 dark:border-white/10 dark:bg-stone-900/80",
    answer: "text-stone-600 dark:text-stone-300",
    chip: "border-stone-200/70 bg-black/[0.02] hover:border-stone-300 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/20",
    chipLabel: "text-stone-500 dark:text-stone-400",
    rowHover: "hover:border-stone-200 hover:bg-black/[0.02] dark:hover:border-white/10 dark:hover:bg-white/[0.03]",
    rowActive: "border-brand/50 bg-brand/5 dark:border-brand/30 dark:bg-brand/5",
    rowTitle: "text-stone-800 dark:text-stone-100",
    rowDomain: "text-stone-500 dark:text-stone-500",
    badgeIdle: "bg-black/5 text-stone-500 dark:bg-white/10 dark:text-stone-400",
  },
  light: {
    card: "border-stone-200/70 bg-white/95",
    answer: "text-stone-600",
    chip: "border-stone-200/70 bg-black/[0.02] hover:border-stone-300",
    chipLabel: "text-stone-500",
    rowHover: "hover:border-stone-200 hover:bg-black/[0.02]",
    rowActive: "border-brand/50 bg-brand/5",
    rowTitle: "text-stone-800",
    rowDomain: "text-stone-500",
    badgeIdle: "bg-black/5 text-stone-500",
  },
  dark: {
    card: "border-white/10 bg-stone-900/90",
    answer: "text-stone-300",
    chip: "border-white/10 bg-white/[0.03] hover:border-white/20",
    chipLabel: "text-stone-500",
    rowHover: "hover:border-white/10 hover:bg-white/[0.03]",
    rowActive: "border-brand/30 bg-brand/5",
    rowTitle: "text-stone-100",
    rowDomain: "text-stone-500",
    badgeIdle: "bg-white/10 text-stone-500",
  },
};

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

function ChevronIcon() {
  return <PhCaretDown size={12} weight="bold" aria-hidden />;
}

// Shared between citation markers and the source list, so hovering a marker
// highlights its source row, and vice versa, wherever each is rendered.
interface SourcesState {
  activeId: number | null;
  setActiveId: (n: number | null) => void;
  clearIfActive: (n: number) => void;
  expanded: boolean;
  setExpanded: (v: boolean | ((v: boolean) => boolean)) => void;
}

const SourcesContext = createContext<SourcesState | null>(null);

function useSourcesState() {
  const state = useContext(SourcesContext);
  if (!state) throw new Error("Citation and SourceList must be inside SourcesProvider");
  return state;
}

export function SourcesProvider({ defaultExpanded = true, children }: { defaultExpanded?: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [activeId, setActiveId] = useState<number | null>(null);
  const value = useMemo<SourcesState>(
    () => ({
      activeId,
      setActiveId,
      clearIfActive: (n) => setActiveId((a) => (a === n ? null : a)),
      expanded,
      setExpanded,
    }),
    [activeId, expanded],
  );
  return <SourcesContext.Provider value={value}>{children}</SourcesContext.Provider>;
}

/** An inline numbered marker; focusing or clicking it opens and highlights its source. */
export function Citation({ n, title }: { n: number; title: string }) {
  const { activeId, setActiveId, clearIfActive, setExpanded } = useSourcesState();
  const active = activeId === n;
  return (
    <button
      type="button"
      onMouseEnter={() => setActiveId(n)}
      onMouseLeave={() => clearIfActive(n)}
      onFocus={() => setActiveId(n)}
      onBlur={() => clearIfActive(n)}
      onClick={() => {
        setExpanded(true);
        setActiveId(n);
      }}
      aria-label={`Jump to source ${n}: ${title}`}
      className={`relative -top-1 mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 align-baseline text-[11px] font-semibold leading-none transition-[color,background-color,border-color,transform,opacity] duration-150 ${FOCUS_RING} ${
        active ? "scale-110 bg-brand text-brand-foreground ring-2 ring-brand/50" : "bg-brand/10 text-brand hover:bg-brand hover:text-brand-foreground"
      }`}
    >
      {n}
    </button>
  );
}

/** The "N sources" chip and its expandable list of pages. */
export function SourceList({
  sources,
  variant = "ambient",
  onOpen,
}: {
  sources: Source[];
  variant?: SourcesVariant;
  /** Called when a source row is clicked, e.g. to open its page. */
  onOpen?: (source: Source) => void;
}) {
  const { activeId, setActiveId, clearIfActive, expanded, setExpanded } = useSourcesState();
  const shouldReduceMotion = useReducedMotion();
  const panelId = useId();
  const tone = SURFACE[variant];

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 transition-colors ${FOCUS_RING} ${tone.chip}`}
      >
        <span className="flex -space-x-1.5">
          {sources.slice(0, 5).map((s) => (
            <span
              key={s.n}
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white dark:ring-stone-950 ${s.tone}`}
            >
              {s.letter}
            </span>
          ))}
        </span>
        <span className={`text-xs font-medium ${tone.chipLabel}`}>
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </span>
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="text-stone-500"
        >
          <ChevronIcon />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={panelId}
            role="region"
            aria-label="Sources"
            initial={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={shouldReduceMotion ? { duration: 0.15 } : { height: { duration: 0.45, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
            className="overflow-hidden"
          >
            <motion.ul
              initial={shouldReduceMotion ? undefined : { y: -10 }}
              animate={{ y: 0 }}
              transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
              className="mt-2 flex flex-col gap-1"
              role="list"
            >
              {sources.map((s, i) => {
                const active = activeId === s.n;
                return (
                  <motion.li
                    key={s.n}
                    initial={shouldReduceMotion ? undefined : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.3, delay: 0.12 + Math.min(i, 8) * 0.05, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <button
                      type="button"
                      title={s.url}
                      onMouseEnter={() => setActiveId(s.n)}
                      onMouseLeave={() => clearIfActive(s.n)}
                      onFocus={() => setActiveId(s.n)}
                      onBlur={() => clearIfActive(s.n)}
                      onClick={() => {
                        setActiveId(s.n);
                        onOpen?.(s);
                      }}
                      className={`relative flex w-full items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-colors ${FOCUS_RING} ${
                        active ? tone.rowActive : `border-transparent ${tone.rowHover}`
                      }`}
                    >
                      {!shouldReduceMotion && (
                        <AnimatePresence>
                          {active && (
                            <motion.span
                              key={`pulse-${s.n}`}
                              aria-hidden
                              className="absolute inset-0 rounded-xl border-2 border-brand/60"
                              initial={{ opacity: 0.7, scale: 0.98 }}
                              animate={{ opacity: 0, scale: 1.02 }}
                              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                            />
                          )}
                        </AnimatePresence>
                      )}
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${s.tone}`}>
                        {s.letter}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm font-medium ${tone.rowTitle}`}>{s.title}</span>
                        <span className={`block truncate text-xs ${tone.rowDomain}`}>{s.domain}</span>
                      </span>
                      <span
                        className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-semibold ${
                          active ? "bg-brand text-brand-foreground" : tone.badgeIdle
                        }`}
                      >
                        {s.n}
                      </span>
                    </button>
                  </motion.li>
                );
              })}
            </motion.ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// A cited answer with a hover/focus-synced source list: hovering a citation
// marker highlights its source row, and vice versa.
export function Sources({
  answerParts,
  sources,
  variant = "ambient",
}: {
  answerParts: AnswerPart[];
  sources: Source[];
  variant?: SourcesVariant;
}) {
  const tone = SURFACE[variant];
  return (
    <SourcesProvider>
      <div className={`w-full max-w-md rounded-2xl border p-5 ${tone.card}`}>
        <p className={`text-sm leading-relaxed ${tone.answer}`}>
          {answerParts.map((part, i): ReactNode => {
            if (part.text !== undefined) return <span key={i}>{part.text}</span>;
            const source = sources.find((s) => s.n === part.cite);
            return source ? <Citation key={i} n={source.n} title={source.title} /> : null;
          })}
        </p>
        <div className="mt-4">
          <SourceList sources={sources} variant={variant} />
        </div>
      </div>
    </SourcesProvider>
  );
}
