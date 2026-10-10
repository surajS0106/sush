"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  SparkleIcon as PhSparkle,
  ShieldIcon as PhShield,
  WarningIcon as PhWarning,
  CheckIcon as PhCheck,
  FlagIcon as PhFlag,
  ArrowCounterClockwiseIcon as PhReset,
} from "@phosphor-icons/react";

type Tier = "low" | "medium" | "high";
type ClaimStatus = "unreviewed" | "confirmed" | "flagged";

interface Claim {
  id: string;
  text: string;
}

const LOW_MAX = 40;
const HIGH_MIN = 75;

const DEFAULT_CLAIMS: Claim[] = [
  { id: "c1", text: "Revenue grew 12% year over year." },
  { id: "c2", text: "Churn decreased across EMEA accounts." },
  { id: "c3", text: "Support ticket volume dropped 30%." },
];

const TIER_TONE: Record<Tier, { label: string; text: string; badge: string; accent: string; ring: string; solid: string }> = {
  low: {
    label: "Low confidence",
    text: "text-red-700 dark:text-red-300",
    badge: "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400",
    accent: "#dc2626",
    ring: "border-red-400/60",
    solid: "bg-red-600 hover:bg-red-700 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:hover:bg-red-600",
  },
  medium: {
    label: "Use caution",
    text: "text-amber-700 dark:text-amber-300",
    badge: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    accent: "#d97706",
    ring: "border-amber-400/60",
    solid: "bg-amber-700 hover:bg-amber-800 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:hover:bg-amber-700",
  },
  high: {
    label: "High confidence",
    text: "text-green-700 dark:text-green-400",
    badge: "border-green-500/25 bg-green-500/10 text-green-600 dark:text-green-400",
    accent: "#16a34a",
    ring: "border-green-400/60",
    solid: "bg-green-700 hover:bg-green-800 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:hover:bg-green-700",
  },
};

function tierOf(value: number): Tier {
  if (value < LOW_MAX) return "low";
  if (value < HIGH_MIN) return "medium";
  return "high";
}

function SparkleIcon() {
  return <PhSparkle size={12} weight="bold" aria-hidden />;
}
function ShieldIcon() {
  return <PhShield size={12} weight="bold" aria-hidden />;
}
function WarningIcon() {
  return <PhWarning size={12} weight="bold" aria-hidden />;
}
function CheckIcon(props: { size?: number }) {
  return <PhCheck size={props.size ?? 12} weight="bold" aria-hidden />;
}
function FlagIcon() {
  return <PhFlag size={12} weight="bold" aria-hidden />;
}
function ResetIcon() {
  return <PhReset size={13} aria-hidden />;
}

function TierIcon({ tier }: { tier: Tier }) {
  if (tier === "high") return <SparkleIcon />;
  if (tier === "medium") return <ShieldIcon />;
  return <WarningIcon />;
}

function AcceptButton({
  tone,
  pulse,
  shouldReduceMotion,
  disabled,
  onClick,
}: {
  tone: (typeof TIER_TONE)[Tier];
  pulse: boolean;
  shouldReduceMotion: boolean | null;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.span
      className="relative inline-block shrink-0 rounded-lg"
      animate={pulse && !shouldReduceMotion ? { scale: [1, 1.08, 1] } : { scale: 1 }}
      transition={{ duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
    >
      {pulse && !shouldReduceMotion && (
        <motion.span
          aria-hidden
          className={`absolute inset-0 rounded-lg border-2 ${tone.ring}`}
          initial={{ scale: 1, opacity: 0.8 }}
          animate={{ scale: 1.35, opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
      <motion.button
        type="button"
        disabled={disabled}
        onClick={onClick}
        whileTap={disabled || shouldReduceMotion ? undefined : { scale: 0.95 }}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 ${tone.solid}`}
      >
        Accept
      </motion.button>
    </motion.span>
  );
}

interface ConfidenceGateProps {
  title?: string;
  claims?: Claim[];
  initialConfidence?: number;
  className?: string;
}

export function ConfidenceGate({ title = "AI summary", claims = DEFAULT_CLAIMS, initialConfidence = 62, className }: ConfidenceGateProps) {
  const [value, setValue] = useState(initialConfidence);
  const [dragging, setDragging] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, ClaimStatus>>({});
  const [accepted, setAccepted] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const liveRef = useRef<HTMLSpanElement>(null);
  const prevTier = useRef<Tier>(tierOf(initialConfidence));

  const tier = tierOf(value);
  const tone = TIER_TONE[tier];

  useEffect(() => {
    if (tier !== prevTier.current) {
      prevTier.current = tier;
      if (liveRef.current) liveRef.current.textContent = `${tone.label}. ${value}% confidence.`;
    }
  }, [tier, tone.label, value]);

  const statusOf = (id: string): ClaimStatus => statuses[id] ?? "unreviewed";
  const setStatus = (id: string, status: ClaimStatus) => setStatuses((prev) => ({ ...prev, [id]: status }));

  const allClaimsReviewed = claims.every((c) => statusOf(c.id) !== "unreviewed");
  const canAccept = tier === "high" || (tier === "medium" && reviewed) || (tier === "low" && allClaimsReviewed);

  const [justUnlocked, setJustUnlocked] = useState(false);
  const unlockTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pulseUnlock = (nextCanAccept: boolean) => {
    if (!nextCanAccept || canAccept) return;
    setJustUnlocked(true);
    if (unlockTimeout.current) clearTimeout(unlockTimeout.current);
    unlockTimeout.current = setTimeout(() => setJustUnlocked(false), 450);
  };

  const handleValueChange = (next: number) => {
    setValue(next);
    const nextTier = tierOf(next);
    pulseUnlock(nextTier === "high" || (nextTier === "medium" && reviewed) || (nextTier === "low" && allClaimsReviewed));
  };

  const toggleReviewed = () => {
    const next = !reviewed;
    setReviewed(next);
    pulseUnlock(tier === "medium" && next);
  };

  const setClaimStatus = (id: string, status: ClaimStatus) => {
    setStatus(id, status);
    const nextAllReviewed = claims.every((c) => (c.id === id ? status : statusOf(c.id)) !== "unreviewed");
    pulseUnlock(tier === "low" && nextAllReviewed);
  };

  useEffect(() => () => {
    if (unlockTimeout.current) clearTimeout(unlockTimeout.current);
  }, []);

  const reset = () => {
    setValue(initialConfidence);
    setReviewed(false);
    setStatuses({});
    setAccepted(false);
    setJustUnlocked(false);
    if (unlockTimeout.current) clearTimeout(unlockTimeout.current);
    prevTier.current = tierOf(initialConfidence);
  };

  const fade = shouldReduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 } };

  return (
    <div className={className}>
      <div className="relative w-full overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <span ref={liveRef} className="sr-only" role="status" aria-live="polite" />

        <AnimatePresence mode="wait" initial={false}>
          {accepted ? (
            <motion.div key="accepted" {...fade} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }} className="flex items-center gap-3 p-5">
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                {!shouldReduceMotion && (
                  <motion.span
                    aria-hidden
                    className="absolute rounded-full border-2 border-emerald-400/60"
                    style={{ inset: -3 }}
                    initial={{ scale: 0.7, opacity: 0.9 }}
                    animate={{ scale: 1.7, opacity: 0 }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  />
                )}
                <CheckIcon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Accepted at {value}% confidence</p>
                <p className="truncate text-xs text-stone-500 dark:text-stone-500">{title}</p>
              </div>
              <button
                type="button"
                onClick={reset}
                aria-label="Evaluate another answer"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
              >
                <ResetIcon />
              </button>
            </motion.div>
          ) : (
            <div className="p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</h3>
                <span className={`inline-flex shrink-0 items-center overflow-hidden rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 ${tone.badge}`}>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={tier}
                      className="inline-flex items-center gap-1"
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: -4 }}
                      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <TierIcon tier={tier} />
                      {tone.label}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </div>

              <div className="relative mt-4 flex h-5 items-center">
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                  <div
                    className="absolute inset-0"
                    style={{ backgroundImage: "linear-gradient(to right, #dc2626, #57534e, #16a34a)" }}
                  />
                  <div className="absolute inset-y-0 right-0 bg-stone-200 dark:bg-stone-700" style={{ left: `${value}%` }} />
                </div>
                <div className="pointer-events-none absolute inset-0 flex items-center">
                  {[LOW_MAX, HIGH_MIN].map((mark) => (
                    <span
                      key={mark}
                      aria-hidden
                      className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/70 dark:bg-stone-900/60"
                      style={{ left: `${mark}%` }}
                    />
                  ))}
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={value}
                  onChange={(e) => handleValueChange(Number(e.target.value))}
                  onPointerDown={() => setDragging(true)}
                  onPointerUp={() => setDragging(false)}
                  aria-label="AI confidence"
                  aria-valuetext={`${value}%, ${tone.label}`}
                  className="peer absolute inset-0 h-5 w-full cursor-pointer opacity-0"
                />
                <motion.div className="pointer-events-none absolute top-1/2" style={{ left: `${value}%` }} animate={{ x: "-50%", y: "-50%" }}>
                  <motion.span
                    aria-hidden
                    className="absolute -inset-1.5 rounded-full blur-[3px]"
                    style={{ backgroundColor: tone.accent }}
                    animate={
                      shouldReduceMotion
                        ? { opacity: 0.18, scale: 1 }
                        : dragging
                          ? { opacity: 0.4, scale: 1.35 }
                          : { opacity: [0.12, 0.32, 0.12], scale: [1, 1.3, 1] }
                    }
                    transition={shouldReduceMotion || dragging ? { duration: 0.2 } : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <motion.div
                    animate={{ scale: dragging ? 1.25 : 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 25 }}
                    style={{ boxShadow: `0 0 0 2px #fff, 0 0 0 4px ${tone.accent}${dragging ? `, 0 0 0 8px ${tone.accent}33` : ""}` }}
                    className="h-4 w-4 rounded-full bg-white transition-colors dark:shadow-[0_0_0_2px_theme(colors.neutral.950)]"
                  />
                  {dragging && (
                    <motion.span
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                      className="pointer-events-none absolute -top-9 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-md bg-stone-900 px-2 py-1 text-xs font-medium text-white dark:bg-stone-100 dark:text-stone-900"
                    >
                      {value}% &middot; {tone.label}
                      <span aria-hidden className="absolute left-1/2 top-full -mt-1 h-2 w-2 -translate-x-1/2 rotate-45 bg-stone-900 dark:bg-stone-100" />
                    </motion.span>
                  )}
                </motion.div>
              </div>
              <div className="mt-1.5 flex justify-between text-[11px] text-stone-500 transition-colors duration-150 dark:text-stone-500">
                <span
                  style={{ marginLeft: `${LOW_MAX}%`, transform: "translateX(-50%)" }}
                  className={value <= 50 ? "font-semibold text-stone-600 dark:text-stone-300" : ""}
                >
                  Review
                </span>
                <span
                  style={{ marginRight: `${100 - HIGH_MIN}%`, transform: "translateX(50%)" }}
                  className={value > 50 ? "font-semibold text-stone-600 dark:text-stone-300" : ""}
                >
                  Trust
                </span>
              </div>

              <AnimatePresence mode="wait" initial={false}>
                {tier === "high" && (
                  <motion.div key="high" {...fade} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-xs text-stone-500 dark:text-stone-500">{claims.length} claims generated, confident enough to skip review.</p>
                    <AcceptButton tone={tone} pulse={justUnlocked} shouldReduceMotion={shouldReduceMotion} onClick={() => setAccepted(true)} />
                  </motion.div>
                )}

                {tier === "medium" && (
                  <motion.div key="medium" {...fade} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="mt-4">
                    <p className="text-sm leading-relaxed text-stone-500 dark:text-stone-400">{claims.map((c) => c.text).join(" ")}</p>
                    <motion.button
                      type="button"
                      role="checkbox"
                      aria-checked={reviewed}
                      onClick={toggleReviewed}
                      whileTap={shouldReduceMotion ? undefined : { scale: 0.97 }}
                      className="mt-3 flex items-center gap-2 text-xs text-stone-500 transition-colors hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-400 dark:hover:text-stone-300"
                    >
                      <span
                        className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                          reviewed ? "border-emerald-600 bg-emerald-700 text-white" : "border-stone-300 dark:border-stone-600"
                        }`}
                      >
                        {reviewed && !shouldReduceMotion && (
                          <motion.span
                            aria-hidden
                            className="absolute rounded border-2 border-amber-400/70"
                            style={{ inset: -3 }}
                            initial={{ scale: 0.6, opacity: 0.9 }}
                            animate={{ scale: 1.6, opacity: 0 }}
                            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                          />
                        )}
                        <AnimatePresence>
                          {reviewed && (
                            <motion.span
                              key="check"
                              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                              transition={{ type: "spring", stiffness: 500, damping: 28 }}
                            >
                              <CheckIcon size={9} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                      I have reviewed this
                    </motion.button>
                    <div className="mt-3 flex justify-end">
                      <AcceptButton tone={tone} pulse={justUnlocked} shouldReduceMotion={shouldReduceMotion} disabled={!canAccept} onClick={() => setAccepted(true)} />
                    </div>
                  </motion.div>
                )}

                {tier === "low" && (
                  <motion.div key="low" {...fade} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="mt-4 flex flex-col gap-1.5">
                    {claims.map((claim) => {
                      const status = statusOf(claim.id);
                      return (
                        <div
                          key={claim.id}
                          className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                            status === "confirmed"
                              ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                              : status === "flagged"
                                ? "border-red-500/25 bg-red-500/5 text-red-700 line-through decoration-red-400/60 dark:text-red-300"
                                : "border-stone-200/70 text-stone-600 dark:border-white/10 dark:text-stone-300"
                          }`}
                        >
                          <span className="min-w-0 flex-1">{claim.text}</span>
                          <motion.button
                            type="button"
                            aria-pressed={status === "confirmed"}
                            aria-label={`Confirm: ${claim.text}`}
                            onClick={() => setClaimStatus(claim.id, status === "confirmed" ? "unreviewed" : "confirmed")}
                            whileTap={shouldReduceMotion ? undefined : { scale: 0.85 }}
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                              status === "confirmed" ? "bg-emerald-700 text-white" : "text-stone-500 hover:bg-emerald-500/10 hover:text-emerald-600"
                            }`}
                          >
                            <motion.span
                              key={status === "confirmed" ? "on" : "off"}
                              initial={shouldReduceMotion ? false : { scale: 0.5, opacity: 0.5 }}
                              animate={{ scale: 1, opacity: 1 }}
                              transition={{ type: "spring", stiffness: 500, damping: 22 }}
                              className="flex"
                            >
                              <CheckIcon />
                            </motion.span>
                          </motion.button>
                          <motion.button
                            type="button"
                            aria-pressed={status === "flagged"}
                            aria-label={`Flag as wrong: ${claim.text}`}
                            onClick={() => setClaimStatus(claim.id, status === "flagged" ? "unreviewed" : "flagged")}
                            whileTap={shouldReduceMotion ? undefined : { scale: 0.85 }}
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                              status === "flagged" ? "bg-red-600 text-white" : "text-stone-500 hover:bg-red-500/10 hover:text-red-600"
                            }`}
                          >
                            <motion.span
                              key={status === "flagged" ? "on" : "off"}
                              initial={shouldReduceMotion ? false : { scale: 0.5, opacity: 0.5 }}
                              animate={{ scale: 1, opacity: 1 }}
                              transition={{ type: "spring", stiffness: 500, damping: 22 }}
                              className="flex"
                            >
                              <FlagIcon />
                            </motion.span>
                          </motion.button>
                        </div>
                      );
                    })}
                    <div className="mt-1.5 flex items-center justify-between gap-3">
                      <p className="text-[11px] text-stone-500 dark:text-stone-500">
                        {allClaimsReviewed ? "All claims reviewed." : "Review every claim to continue."}
                      </p>
                      <AcceptButton tone={tone} pulse={justUnlocked} shouldReduceMotion={shouldReduceMotion} disabled={!canAccept} onClick={() => setAccepted(true)} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}