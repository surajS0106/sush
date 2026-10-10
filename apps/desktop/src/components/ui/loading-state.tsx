// Pixel-grid loader for long-running work, adapted from Beautiful UI's
// LoadingState (beautifului.dev/r/loading-state.json) onto our theme tokens.
//
// Variants:
//   Drive: square cells, chevron wavefront driving right; the 650ms cycle is
//          shorter than the sweep, so two fronts are always in flight
//   Dots:  same wavefront, circular cells
//   Orbit: a comet lapping the grid perimeter
//
// Paired with a shimmering label and a live elapsed timer in tabular figures.
// Reduced motion freezes the grid to its dim state; the timer still ticks.

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
} satisfies Record<string, { delays: (number | null)[]; dur: number; round: boolean }>;

export type LoadingStateVariant = keyof typeof PATTERNS;

function LoaderGrid({ delays, dur, round }: (typeof PATTERNS)[LoadingStateVariant]) {
  return (
    <span aria-hidden data-pixel-loader className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={cn("size-[4px] bg-foreground", round ? "rounded-full" : "rounded-[1px]")}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function useElapsed() {
  const [ds, setDs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDs((d) => d + 1), 100);
    return () => clearInterval(t);
  }, []);
  const total = ds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export function LoadingState({
  label = "Churning",
  variant = "Drive",
  className,
}: {
  label?: string;
  variant?: LoadingStateVariant;
  className?: string;
}) {
  const elapsed = useElapsed();
  return (
    <div role="status" className={cn("flex w-fit items-center gap-2.5", className)}>
      <LoaderGrid {...PATTERNS[variant]} />
      <span
        className="bg-clip-text text-[13px] font-medium text-transparent"
        style={{
          backgroundImage:
            "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
          backgroundSize: "200% 100%",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {label}
      </span>
      <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{elapsed}</span>
    </div>
  );
}
