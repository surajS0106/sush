"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CrownIcon as PhCrown, ArrowCounterClockwiseIcon as PhReset } from "@phosphor-icons/react";

interface Factor {
  id: string;
  label: string;
  detail: string;
  weight: number;
}

const FACTORS: Factor[] = [
  { id: "team", label: "Team size: 24 people", detail: "Plans over 20 seats typically need Pro's roles and permissions.", weight: 18 },
  { id: "integrations", label: "Uses 3+ integrations", detail: "Starter caps integrations at two.", weight: 12 },
  { id: "tenure", label: "On Starter for 8 months", detail: "Usage has grown steadily since signup.", weight: 9 },
  { id: "tickets", label: "Support tickets: low volume", detail: "Rarely needs priority support, a Pro-only perk.", weight: -7 },
];

const THRESHOLD = 20;
const MAX_ABS = Math.max(...FACTORS.map((f) => Math.abs(f.weight)));
const PLANS = ["Starter", "Pro"] as const;

function CrownIcon() {
  return <PhCrown size={12} weight="fill" aria-hidden />;
}
function ResetIcon() {
  return <PhReset size={13} aria-hidden />;
}

function MiniToggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
        checked ? "bg-emerald-600" : "bg-stone-300 dark:bg-stone-600"
      }`}
    >
      <motion.span
        animate={{ x: checked ? 17 : 2 }}
        transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 700, damping: 32 }}
        className="absolute top-0.5 block h-4 w-4 rounded-full bg-white shadow-md"
      />
    </motion.button>
  );
}

interface DecisionTimelineProps {
  className?: string;
}

export function DecisionTimeline({ className }: DecisionTimelineProps) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(FACTORS.map((f) => [f.id, true])));
  const [displayTotal, setDisplayTotal] = useState(() => FACTORS.reduce((sum, f) => sum + f.weight, 0));
  const shouldReduceMotion = useReducedMotion();
  const rafRef = useRef<number | null>(null);

  const total = FACTORS.filter((f) => enabled[f.id]).reduce((sum, f) => sum + f.weight, 0);
  const recommendation = total >= THRESHOLD ? "Pro" : "Starter";

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (shouldReduceMotion) {
      setDisplayTotal(total);
      return;
    }
    const start = displayTotal;
    const startTime = performance.now();
    const duration = 450;
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayTotal(Math.round(start + (total - start) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, shouldReduceMotion]);

  const toggleFactor = (id: string) => setEnabled((prev) => ({ ...prev, [id]: !prev[id] }));
  const reset = () => setEnabled(Object.fromEntries(FACTORS.map((f) => [f.id, true])));

  return (
    <div className={className}>
      <div className="w-full rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Recommended plan</h3>
          <motion.button
            type="button"
            onClick={reset}
            aria-label="Reset all factors"
            whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
          >
            <ResetIcon />
          </motion.button>
        </div>

        <div className="mt-3 inline-flex rounded-full bg-stone-100 p-1 dark:bg-stone-900">
          {PLANS.map((plan) => (
            <span key={plan} className="relative rounded-full px-4 py-1.5 text-sm font-medium">
              {recommendation === plan && (
                <motion.span
                  layoutId="decision-timeline-pill"
                  className="absolute inset-0 rounded-full bg-emerald-600"
                  transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 32 }}
                />
              )}
              <span className={`relative inline-flex items-center gap-1 transition-colors ${recommendation === plan ? "text-white" : "text-stone-500 dark:text-stone-400"}`}>
                {plan === "Pro" && <CrownIcon />}
                {plan}
              </span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs tabular-nums text-stone-500 dark:text-stone-500">
          {displayTotal} pts, needs {THRESHOLD}+ for Pro
        </p>

        <div className="mt-4">
          {FACTORS.map((factor) => {
            const on = enabled[factor.id];
            const positive = factor.weight >= 0;
            return (
              <div key={factor.id} className="flex items-start gap-3 border-b border-stone-100 py-3 last:border-0 last:pb-0 dark:border-white/5">
                <MiniToggle checked={on} onChange={() => toggleFactor(factor.id)} label={factor.label} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium transition-colors ${on ? "text-stone-800 dark:text-stone-100" : "text-stone-400 line-through decoration-stone-300 dark:text-stone-600"}`}>
                    {factor.label}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-500">{factor.detail}</p>
                  <div className="mt-1.5 h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-stone-100 dark:bg-white/5">
                    <motion.div
                      className={`h-full rounded-full ${positive ? "bg-green-500" : "bg-red-500"}`}
                      animate={{ width: on ? `${(Math.abs(factor.weight) / MAX_ABS) * 100}%` : "0%" }}
                      transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 30 }}
                    />
                  </div>
                </div>
                <span
                  className={`shrink-0 pt-0.5 text-sm font-medium tabular-nums transition-colors ${
                    on ? (positive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-stone-300 line-through dark:text-stone-700"
                  }`}
                >
                  {positive ? "+" : ""}
                  {factor.weight}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-center text-xs text-stone-500 dark:text-stone-500">Mute a factor to see how the recommendation would actually change.</p>
    </div>
  );
}