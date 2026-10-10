"use client";

import { useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

export function PillTabs({
  tabs,
  active: activeProp,
  onChange,
  showPanels = true,
  label = "Sections",
}: {
  tabs: string[];
  active?: number;
  onChange?: (index: number) => void;
  showPanels?: boolean;
  /** Accessible name of the tablist. */
  label?: string;
}) {
  const groupId = useId();
  const [uncontrolledActive, setUncontrolledActive] = useState(0);
  const active = activeProp ?? uncontrolledActive;
  const setActive = onChange ?? setUncontrolledActive;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const shouldReduceMotion = useReducedMotion();

  const focusTab = (index: number) => {
    setActive(index);
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusTab((active + 1) % tabs.length);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusTab((active - 1 + tabs.length) % tabs.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTab(tabs.length - 1);
    }
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={handleKeyDown}
        className="inline-flex gap-1 rounded-full bg-stone-100 p-1 dark:bg-stone-900"
      >
        {tabs.map((tab, i) => (
          <button
            key={tab}
            ref={(el) => { tabRefs.current[i] = el; }}
            id={`${groupId}-tab-${i}`}
            role="tab"
            aria-selected={active === i}
            aria-controls={showPanels ? `${groupId}-panel-${i}` : undefined}
            tabIndex={active === i ? 0 : -1}
            onClick={() => setActive(i)}
            className={`relative rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              active === i
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            {active === i && (
              <motion.span
                layoutId={`${groupId}-pill-tabs-active-bg`}
                className="absolute inset-0 rounded-full bg-white shadow-sm dark:bg-black"
                transition={
                  shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 35 }
                }
              />
            )}
            <span className="relative">{tab}</span>
          </button>
        ))}
      </div>
      {showPanels &&
        tabs.map((tab, i) => (
          <div
            key={tab}
            id={`${groupId}-panel-${i}`}
            role="tabpanel"
            aria-labelledby={`${groupId}-tab-${i}`}
            hidden={active !== i}
            className="pt-3 text-sm text-stone-500 dark:text-stone-400"
          >
            {tab} content goes here.
          </div>
        ))}
    </div>
  );
}