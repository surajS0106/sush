"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ShieldIcon as PhShield, WarningIcon as PhWarning, XIcon as PhX, CheckIcon as PhCheck } from "@phosphor-icons/react";

type Risk = "safe" | "caution" | "destructive";

const RISK_TONE: Record<Risk, { label: string; badge: string; iconBg: string; iconColor: string; approve: string; ring: string }> = {
  safe: {
    label: "Safe",
    badge: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    iconBg: "bg-emerald-500/10",
    iconColor: "text-emerald-700 dark:text-emerald-400",
    approve: "bg-emerald-600 hover:bg-emerald-500 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
    ring: "border-emerald-400/60",
  },
  caution: {
    label: "Use caution",
    badge: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    iconBg: "bg-amber-500/10",
    iconColor: "text-amber-700 dark:text-amber-400",
    approve: "bg-amber-600 hover:bg-amber-500 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
    ring: "border-amber-400/60",
  },
  destructive: {
    label: "Irreversible",
    badge: "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400",
    iconBg: "bg-red-500/10",
    iconColor: "text-red-600 dark:text-red-400",
    approve: "bg-red-600 hover:bg-red-500 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
    ring: "border-red-400/60",
  },
};

const HOLD_MS = 700;

function ShieldIcon() {
  return <PhShield size={12} weight="bold" aria-hidden />;
}

function AlertIcon() {
  return <PhWarning size={12} weight="bold" aria-hidden />;
}

function XIcon() {
  return <PhX size={12} weight="bold" aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={12} weight="bold" aria-hidden />;
}

function RiskIcon({ risk }: { risk: Risk }) {
  return risk === "destructive" ? <AlertIcon /> : <ShieldIcon />;
}

function HoldProgressRing({ progress }: { progress: number }) {
  const size = 13;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={strokeWidth} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
      />
    </svg>
  );
}

function HoldApproveButton({ tone, onConfirm }: { tone: (typeof RISK_TONE)[Risk]; onConfirm: () => void }) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const shouldReduceMotion = useReducedMotion();

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startRef.current = null;
    setHolding(false);
    if (!firedRef.current) setProgress(0);
  };

  const start = () => {
    if (firedRef.current) return;
    setHolding(true);
    startRef.current = performance.now();
    const tick = () => {
      if (startRef.current === null) return;
      const elapsed = performance.now() - startRef.current;
      const p = Math.min(1, elapsed / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        firedRef.current = true;
        setHolding(false);
        onConfirm();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => stop(), []);

  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") stop();
      }}
      className={`relative inline-flex select-none items-center gap-1.5 overflow-hidden rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${tone.approve}`}
    >
      <motion.span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-white/25"
        style={{ transformOrigin: "left" }}
        animate={{ scaleX: progress }}
        transition={shouldReduceMotion ? { duration: 0 } : holding ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 26 }}
      />
      <span className="relative flex items-center gap-1.5">
        {holding && <HoldProgressRing progress={progress} />}
        {holding ? "Confirming…" : "Hold to confirm"}
      </span>
    </button>
  );
}

export function Confirmation({
  title,
  description,
  meta,
  risk = "caution",
  onApprove,
  onDeny,
}: {
  title: string;
  description: string;
  meta?: string;
  risk?: Risk;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const [decision, setDecision] = useState<"pending" | "approved" | "denied">("pending");
  const shouldReduceMotion = useReducedMotion();
  const tone = RISK_TONE[risk];
  const titleId = "confirmation-title";

  const approve = () => {
    setDecision("approved");
    onApprove?.();
  };
  const deny = () => {
    setDecision("denied");
    onDeny?.();
  };

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
    >
      <AnimatePresence mode="wait" initial={false}>
        {decision === "pending" ? (
          <motion.div
            key="pending"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="p-5"
          >
            <div className="flex items-start gap-3">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.iconBg} ${tone.iconColor}`}>
                <RiskIcon risk={risk} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id={titleId} className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                    {title}
                  </h3>
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone.badge}`}>
                    <RiskIcon risk={risk} />
                    {tone.label}
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-stone-500 dark:text-stone-400">{description}</p>
                {meta && (
                  <code className="mt-2 block truncate rounded-md bg-black/[0.04] px-2 py-1 font-mono text-[11px] text-stone-500 dark:bg-white/[0.06] dark:text-stone-400">
                    {meta}
                  </code>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={deny}
                className="inline-flex items-center rounded-lg px-3.5 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-300 dark:hover:bg-white/10"
              >
                Deny
              </button>
              {risk === "destructive" ? (
                <HoldApproveButton tone={tone} onConfirm={approve} />
              ) : (
                <button
                  type="button"
                  onClick={approve}
                  className={`inline-flex items-center rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${tone.approve}`}
                >
                  Approve
                </button>
              )}
            </div>
            {risk === "destructive" && (
              <p className="mt-2 text-right text-[11px] text-stone-500 dark:text-stone-500">Press and hold to confirm</p>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="resolved"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-3 p-4"
          >
            <span
              className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                decision === "approved" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-stone-500/10 text-stone-500 dark:text-stone-400"
              }`}
            >
              {!shouldReduceMotion && decision === "approved" && (
                <motion.span
                  aria-hidden
                  className={`absolute rounded-full border-2 ${tone.ring}`}
                  style={{ inset: -3 }}
                  initial={{ scale: 0.7, opacity: 0.9 }}
                  animate={{ scale: 1.7, opacity: 0 }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              {decision === "approved" ? <CheckIcon /> : <XIcon />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-stone-800 dark:text-stone-100">
                {decision === "approved" ? "Approved" : "Denied"}
              </p>
              <p className="truncate text-xs text-stone-500 dark:text-stone-500">{title}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}