"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  LightbulbIcon as PhLightbulb,
  ShuffleIcon as PhShuffle,
  ArrowRightIcon as PhArrowRight,
  PaperPlaneRightIcon as PhPaperPlaneRight,
  ArrowClockwiseIcon as PhArrowClockwise,
} from "@phosphor-icons/react";

function LightbulbMark() {
  return <PhLightbulb size={12} weight="fill" aria-hidden />;
}

function ShuffleIcon() {
  return <PhShuffle size={14} aria-hidden />;
}

function ArrowIcon() {
  return <PhArrowRight size={12} weight="bold" aria-hidden />;
}

function SendIcon() {
  return <PhPaperPlaneRight size={14} weight="fill" aria-hidden />;
}

function UndoIcon() {
  return <PhArrowClockwise size={13} aria-hidden />;
}

export function Suggestion({
  suggestionSets,
  onSelect,
  label = "Suggested replies",
  className = "w-full max-w-md",
}: {
  /** One or more batches of suggestion strings; the shuffle icon cycles between batches. */
  suggestionSets: string[][];
  onSelect?: (text: string) => void;
  label?: string;
  className?: string;
}) {
  const [setIndex, setSetIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const suggestions = suggestionSets[setIndex] ?? [];

  const handleSelect = (text: string) => {
    setSelected(text);
    onSelect?.(text);
  };

  return (
    <div className={className}>
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">{label}</p>
        {!selected && suggestionSets.length > 1 && (
          <button
            type="button"
            onClick={() => setSetIndex((i) => (i + 1) % suggestionSets.length)}
            aria-label="Show different suggestions"
            title="Show different suggestions"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand dark:hover:bg-brand/15 dark:hover:text-stone-300"
          >
            <ShuffleIcon />
          </button>
        )}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {selected ? (
          <motion.div
            key="composer"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-2.5 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3 dark:border-brand/25 dark:bg-brand/5"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground">
              <SendIcon />
            </span>
            <p className="flex-1 truncate text-sm font-medium text-stone-800 dark:text-stone-100">{selected}</p>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-200"
            >
              <UndoIcon />
              Start over
            </button>
          </motion.div>
        ) : (
          <motion.div
            key={`row-${setIndex}`}
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="relative"
          >
            <div
              className="flex gap-2 overflow-x-auto pb-1 pl-0.5 pr-6 pt-0.5 scrollbar-hide"
              style={{
                WebkitMaskImage: "linear-gradient(to right, black 0, black calc(100% - 28px), transparent 100%)",
                maskImage: "linear-gradient(to right, black 0, black calc(100% - 28px), transparent 100%)",
              }}
            >
              {suggestions.map((s, i) => (
                <motion.button
                  key={s}
                  type="button"
                  onClick={() => handleSelect(s)}
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.94 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                  whileTap={{ scale: 0.96 }}
                  className="group inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-stone-200/70 bg-white px-3.5 py-2 text-sm font-medium text-stone-700 shadow-sm transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand dark:border-white/10 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-brand/30 dark:hover:bg-brand/5 dark:hover:text-brand"
                >
                  <span className="text-brand dark:text-brand">
                    <LightbulbMark />
                  </span>
                  {s}
                  <span className="text-stone-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-stone-600">
                    <ArrowIcon />
                  </span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}