"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { LinkIcon as PhLink, CheckIcon as PhCheck } from "@phosphor-icons/react";

type Visibility = "private" | "anyone";

function LinkIcon() {
  return <PhLink size={14} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={14} weight="bold" aria-hidden />;
}

export function ShareSheet() {
  const [visibility, setVisibility] = useState<Visibility>("anyone");
  const [copied, setCopied] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const shareUrl = "claude.ai/share/8f2a-91c4";

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(`https://${shareUrl}`);
    } catch {
      // clipboard permission denied; UI still confirms optimistically
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-700 dark:bg-stone-900">
      <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Share this chat</h3>
      <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
        Anyone with the link can view this conversation. It won't update after you share it.
      </p>

      <div className="relative mt-4 grid grid-cols-2 rounded-lg bg-stone-100 p-1 text-sm font-medium dark:bg-stone-900">
        {(["private", "anyone"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setVisibility(option)}
            className={`relative z-10 rounded-md px-3 py-1.5 transition-colors ${
              visibility === option ? "text-stone-900 dark:text-stone-100" : "text-stone-500 dark:text-stone-400"
            }`}
          >
            {visibility === option && (
              <motion.span
                layoutId="share-visibility-highlight"
                className="absolute inset-0 -z-10 rounded-md bg-white shadow-sm dark:bg-stone-700"
                transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 34 }}
              />
            )}
            {option === "private" ? "Only you" : "Anyone with link"}
          </button>
        ))}
      </div>

      <AnimatePresence initial={false}>
        {visibility === "anyone" && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 1, height: "auto" } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 py-1 pl-3 pr-1 dark:border-stone-800 dark:bg-stone-900">
              <span className="min-w-0 flex-1 truncate text-xs text-stone-500 dark:text-stone-400">{shareUrl}</span>
              <button
                type="button"
                onClick={handleCopy}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-200 ${
                  copied
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
                    : "bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-700 dark:hover:bg-emerald-800 dark:hover:bg-stone-200"
                }`}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={copied ? "check" : "link"}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ duration: 0.15 }}
                    className="inline-flex"
                  >
                    {copied ? <CheckIcon /> : <LinkIcon />}
                  </motion.span>
                </AnimatePresence>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>

            <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">
              What people will see
            </p>
            <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">
                  Shared from Claude
                </span>
              </div>
              <p className="mt-1.5 truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                Debugging a flaky CI pipeline
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}