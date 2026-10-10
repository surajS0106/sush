"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  PackageIcon as PhPackage,
  CheckIcon as PhCheck,
  CopyIcon as PhCopy,
  ArrowSquareOutIcon as PhArrowSquareOut,
  ArrowClockwiseIcon as PhArrowClockwise,
} from "@phosphor-icons/react";

interface BootStep {
  label: string;
  detail?: string;
  /** Duration this step stays active, in ms. Defaults to 900. */
  duration?: number;
}

interface Resources {
  cpuPct: number;
  memoryUsedMB: number;
  memoryTotalMB: number;
}

function BoxIcon() {
  return <PhPackage size={13} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={11} weight="bold" aria-hidden />;
}

function CopyIcon() {
  return <PhCopy size={12} aria-hidden />;
}

function ExternalLinkIcon() {
  return <PhArrowSquareOut size={12} aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function StepIndicator({ status, shouldReduceMotion }: { status: "pending" | "active" | "done"; shouldReduceMotion: boolean | null }) {
  if (status === "done") {
    return (
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-700 text-white">
        <CheckIcon />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500/15">
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-green-400/25 border-t-green-500"
          animate={shouldReduceMotion ? undefined : { rotate: 360 }}
          transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
        />
      </span>
    );
  }
  return <span className="h-5 w-5 shrink-0 rounded-full border-2 border-stone-300 dark:border-white/15" />;
}

function GaugeBar({ label, pct, note, shouldReduceMotion }: { label: string; pct: number; note: string; shouldReduceMotion: boolean | null }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
        <span>{label}</span>
        <span>{note}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-white/10">
        <motion.div
          className="h-full rounded-full bg-green-700 dark:bg-green-500"
          initial={{ width: 0 }}
          animate={shouldReduceMotion ? { width: `${pct}%` } : { width: [`${pct - 3}%`, `${pct + 3}%`, `${pct - 3}%`] }}
          transition={shouldReduceMotion ? { duration: 0.4 } : { duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </div>
  );
}

export function Sandbox({
  steps,
  previewUrl,
  resources,
  autoPlay = true,
}: {
  steps: BootStep[];
  previewUrl: string;
  resources: Resources;
  autoPlay?: boolean;
}) {
  const [playId, setPlayId] = useState(0);
  return (
    <SandboxRun
      key={playId}
      steps={steps}
      previewUrl={previewUrl}
      resources={resources}
      autoPlay={autoPlay}
      onReplay={() => setPlayId((id) => id + 1)}
    />
  );
}

function SandboxRun({
  steps,
  previewUrl,
  resources,
  autoPlay,
  onReplay,
}: {
  steps: BootStep[];
  previewUrl: string;
  resources: Resources;
  autoPlay: boolean;
  onReplay: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [ready, setReady] = useState(!autoPlay);
  const [copied, setCopied] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (!autoPlay) return;
    let cumulative = 0;
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    steps.forEach((step, i) => {
      const d = shouldReduceMotion ? 40 : (step.duration ?? 900);
      cumulative += d;
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return;
          if (i === steps.length - 1) {
            setTimeout(() => !cancelled && setReady(true), 250);
          } else {
            setCurrentIndex(i + 1);
          }
        }, cumulative)
      );
    });
    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, shouldReduceMotion]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`https://${previewUrl}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable ; no-op
    }
  };

  const statusOf = (i: number): "pending" | "active" | "done" => (i < currentIndex || ready ? "done" : i === currentIndex ? "active" : "pending");

  return (
    <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_25px_60px_-25px_rgba(0,0,0,0.15)] dark:border-white/10 dark:bg-stone-900 dark:shadow-[0_25px_60px_-25px_rgba(0,0,0,0.6)]">
      <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2.5 dark:border-white/10 dark:bg-white/[0.02]">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400">
          <BoxIcon />
        </span>
        <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Sandbox</span>
        <AnimatePresence mode="wait">
          <motion.span
            key={ready ? "ready" : "booting"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="ml-auto flex items-center gap-1.5 text-[11px] font-medium"
          >
            <span className="relative flex h-1.5 w-1.5">
              {ready && !shouldReduceMotion && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              )}
              <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${ready ? "bg-green-500 dark:bg-green-400" : "bg-amber-500 dark:bg-amber-400"}`} />
            </span>
            <span className={ready ? "text-green-600 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>{ready ? "Ready" : "Booting"}</span>
          </motion.span>
        </AnimatePresence>
        {ready && autoPlay && (
          <button
            type="button"
            onClick={onReplay}
            aria-label="Restart sandbox"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-emerald-400"
          >
            <ReplayIcon />
          </button>
        )}
      </div>

      <div className="px-4 py-4">
        <div className="flex flex-col gap-2.5">
          {steps.map((step, i) => {
            const status = statusOf(i);
            return (
              <div key={step.label} className="flex items-center gap-2.5">
                <StepIndicator status={status} shouldReduceMotion={shouldReduceMotion} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate font-mono text-xs ${status === "pending" ? "text-stone-400 dark:text-stone-600" : "text-stone-800 dark:text-stone-200"}`}>{step.label}</p>
                  {step.detail && status !== "pending" && <p className="truncate font-mono text-[11px] text-stone-500 dark:text-stone-500">{step.detail}</p>}
                </div>
              </div>
            );
          })}
        </div>

        <AnimatePresence>
          {ready && (
            <motion.div
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={shouldReduceMotion ? { duration: 0.2 } : { height: { duration: 0.3, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.25 } }}
              className="overflow-hidden"
            >
              <div className="mt-4 flex items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.03]">
                <span className="truncate font-mono text-xs text-stone-700 dark:text-stone-300">{previewUrl}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={copied ? "Preview URL copied" : "Copy preview URL"}
                  title={copied ? "Preview URL copied" : "Copy preview URL"}
                  className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-emerald-400"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-500">
                  <ExternalLinkIcon />
                </span>
              </div>

              <div className="mt-4 flex flex-col gap-3">
                <GaugeBar label="CPU" pct={resources.cpuPct} note={`${resources.cpuPct}%`} shouldReduceMotion={shouldReduceMotion} />
                <GaugeBar
                  label="Memory"
                  pct={(resources.memoryUsedMB / resources.memoryTotalMB) * 100}
                  note={`${resources.memoryUsedMB} / ${resources.memoryTotalMB} MB`}
                  shouldReduceMotion={shouldReduceMotion}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}