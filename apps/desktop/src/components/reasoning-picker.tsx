// The composer's thinking and effort control, like a video player's volume: the bars
// are the mute button (thinking on/off) and a slider grows out beside them on hover.
// Steps the picked model doesn't accept are dimmed and skipped.

import { useRef, useState } from "react";
import type { ProviderModels } from "@/hooks/use-providers";
import { setPrefs, usePrefs } from "@/lib/library";
import { EFFORTS, effectiveReasoning, effortAllowed, effortLabel, reasoningCaps } from "@/lib/reasoning";
import type { Effort } from "@/lib/tauri";
import type { ModelTarget } from "@/lib/transport";
import { cn } from "@/lib/utils";

/** Each level's color, on the bars. */
const EFFORT_BARS: Record<Effort, string> = {
  low: "text-effort-low",
  medium: "text-effort-medium",
  high: "text-effort-high",
  xhigh: "text-effort-xhigh",
  max: "text-effort-max",
};

/** Signal bars, one per effort level, rising left to right; `lit` of them are on. */
function EffortBars({ lit, className }: { lit: number; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden className={cn("size-3.5 shrink-0", className)}>
      {EFFORTS.map((e, i) => {
        const height = 4 + i * 2.5;
        return (
          <rect
            key={e.id}
            x={i * 3}
            y={14 - height}
            width={2}
            height={height}
            rx={0.5}
            fillOpacity={i < lit ? 1 : 0.25}
            className="transition-[fill-opacity] duration-150"
          />
        );
      })}
    </svg>
  );
}

export function ReasoningPicker({ catalog, target }: { catalog: ProviderModels[]; target: ModelTarget | null }) {
  const prefs = usePrefs();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const format = catalog.find((c) => c.provider.id === target?.providerId)?.provider.format;
  const caps = reasoningCaps(format, target?.model);
  const { thinking, effort } = effectiveReasoning(caps, { thinking: prefs.thinking, effort: prefs.reasoningEffort });

  const unknown = caps.thinking === "none";
  const label = unknown ? "Thinking" : !thinking ? "Thinking off" : effort ? effortLabel(effort) : "Thinking";
  // Auto shows the model's default level. Thinking on with no known level reads as medium.
  const barEffort = thinking && !unknown ? (effort ?? caps.defaultEffort ?? "medium") : null;
  const litBars = EFFORTS.findIndex((e) => e.id === barEffort) + 1;

  // Step 0 is off, then one per level.
  const canToggle = caps.thinking === "optional";
  const enabled = [canToggle, ...EFFORTS.map((e) => effortAllowed(caps, e.id, true))];
  const last = EFFORTS.length;
  const value = litBars; // 0 when off or unknown
  const disabled = !target || unknown || !enabled.some(Boolean);

  const pick = (i: number) => {
    if (disabled || !enabled[i]) return;
    if (i === 0) setPrefs({ thinking: false });
    else setPrefs({ thinking: true, reasoningEffort: EFFORTS[i - 1].id });
  };
  const nearest = (i: number) => {
    for (let d = 0; d <= last; d++) {
      if (enabled[i - d]) return i - d;
      if (enabled[i + d]) return i + d;
    }
    return value;
  };
  const fromPointer = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    pick(nearest(Math.round(ratio * last)));
  };
  const step = (dir: 1 | -1) => {
    for (let i = value + dir; i >= 0 && i <= last; i += dir) {
      if (enabled[i]) return pick(i);
    }
  };

  const pct = (value / last) * 100;

  const toggle = (
    <button
      type="button"
      disabled={disabled || !canToggle}
      aria-label={thinking ? "Turn thinking off" : "Turn thinking on"}
      onClick={() => (thinking ? pick(0) : setPrefs({ thinking: true }))}
      className="flex size-5 shrink-0 items-center justify-center outline-none disabled:cursor-default"
    >
      <EffortBars lit={litBars} className={barEffort ? EFFORT_BARS[barEffort] : undefined} />
    </button>
  );

  // The control has a fixed width and the slider is a panel laid exactly over it, so
  // hovering never shifts or covers its neighbours, and the label changing can't move the track.
  return (
    <div
      className={cn(
        "group/think relative flex h-8 items-center justify-between rounded-full pl-2 text-[13px] sm:w-28 text-muted-foreground transition-colors hover:text-foreground",
        disabled && "opacity-50",
      )}
      title={caps.note}
    >
      {toggle}
      <span className="hidden whitespace-nowrap pl-1.5 pr-2 sm:inline">{label}</span>

      <div
        className={cn(
          "absolute inset-y-0 right-0 flex w-28 items-center gap-2 rounded-full bg-background pl-2 pr-3 text-foreground shadow-sm ring-1 ring-border transition-opacity duration-150",
          dragging
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover/think:pointer-events-auto group-hover/think:opacity-100 group-focus-within/think:pointer-events-auto group-focus-within/think:opacity-100",
        )}
      >
        {toggle}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Thinking effort"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={value}
          aria-valuetext={label}
          aria-disabled={disabled}
          onPointerDown={(e) => {
            if (disabled) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            fromPointer(e.clientX);
          }}
          onPointerMove={(e) => dragging && fromPointer(e.clientX)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowUp") (e.preventDefault(), step(1));
            else if (e.key === "ArrowLeft" || e.key === "ArrowDown") (e.preventDefault(), step(-1));
          }}
          className="relative flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center outline-none"
        >
          <div className="relative h-1 w-full rounded-full bg-foreground/15">
            <div
              className={cn("absolute inset-y-0 left-0 rounded-full bg-current", barEffort ? EFFORT_BARS[barEffort] : "text-muted-foreground")}
              style={{ width: `${pct}%` }}
            />
            {enabled.map((ok, i) => (
              <span
                key={i}
                className={cn("absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/70", !ok && "opacity-0")}
                style={{ left: `${(i / last) * 100}%` }}
              />
            ))}
            <span
              className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-1.5 py-0.5 text-[11px] text-background"
              style={{ left: `${pct}%`, opacity: dragging ? 1 : 0 }}
            >
              {label}
            </span>
            <div
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow transition-[left] duration-100"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
