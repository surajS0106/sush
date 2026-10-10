"use client";

import { motion, useReducedMotion } from "framer-motion";

type SharePlatform = "claude" | "chatgpt";

const platformStyles: Record<SharePlatform, { label: string; dot: string; hoverBorder: string }> = {
  claude: {
    label: "Claude",
    dot: "bg-amber-500",
    hoverBorder: "group-hover:border-amber-300 dark:group-hover:border-amber-700",
  },
  chatgpt: {
    label: "ChatGPT",
    dot: "bg-emerald-500",
    hoverBorder: "group-hover:border-emerald-300 dark:group-hover:border-emerald-700",
  },
};

export function ShareCard({
  platform,
  title,
  snippet,
  messageCount,
  sharedAt,
}: {
  platform: SharePlatform;
  title: string;
  snippet: string;
  messageCount: number;
  sharedAt: string;
}) {
  const shouldReduceMotion = useReducedMotion();
  const style = platformStyles[platform];

  return (
    <motion.a
      href="#"
      onClick={(e) => e.preventDefault()}
      initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.94, rotate: -1 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={{ type: "spring", stiffness: 340, damping: 26 }}
      className={`group block w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-sm transition-colors duration-150 dark:border-stone-700 dark:bg-stone-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${style.hoverBorder}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">
          Shared from {style.label}
        </span>
      </div>
      <h3 className="mt-2.5 truncate text-[15px] font-semibold text-stone-900 dark:text-stone-100">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-stone-500 line-clamp-2 dark:text-stone-400">{snippet}</p>
      <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3 dark:border-stone-800">
        <span className="text-xs text-stone-500 dark:text-stone-500">
          {messageCount} messages · {sharedAt}
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          View chat
          <span className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden>
            →
          </span>
        </span>
      </div>
    </motion.a>
  );
}