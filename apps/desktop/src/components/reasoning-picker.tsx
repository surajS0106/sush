// The composer's thinking and effort control: signal bars that open a menu of levels
// (Off, then Low to Max). Levels the picked model doesn't accept are shown but disabled.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  const format = catalog.find((c) => c.provider.id === target?.providerId)?.provider.format;
  const caps = reasoningCaps(format, target?.model);
  const { thinking, effort } = effectiveReasoning(caps, { thinking: prefs.thinking, effort: prefs.reasoningEffort });

  const unknown = caps.thinking === "none";
  const label = unknown ? "Thinking" : !thinking ? "Thinking off" : effort ? effortLabel(effort) : "Thinking";
  // Auto shows the model's default level. Thinking on with no known level reads as medium.
  const barEffort = thinking && !unknown ? (effort ?? caps.defaultEffort ?? "medium") : null;
  const litBars = EFFORTS.findIndex((e) => e.id === barEffort) + 1;

  const canToggle = caps.thinking === "optional";
  const levels = EFFORTS.filter((e) => effortAllowed(caps, e.id, true));
  const selected = !thinking ? "off" : (effort ?? caps.defaultEffort ?? "");

  const pick = (v: string) => {
    if (v === "off") setPrefs({ thinking: false });
    else setPrefs({ thinking: true, reasoningEffort: v as Effort });
  };

  // A button that opens a menu, sized like its neighbours: nothing grows over the model pill.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!target}
          aria-label={`Thinking: ${label}. Change`}
          className={cn(
            "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground dark:hover:bg-white/10 dark:data-[state=open]:bg-white/10",
            unknown && "opacity-60",
          )}
        >
          <EffortBars lit={litBars} className={barEffort ? EFFORT_BARS[barEffort] : undefined} />
          <span className="hidden whitespace-nowrap @md:inline">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">Thinking</DropdownMenuLabel>
        {unknown || (!canToggle && levels.length === 0) ? (
          <p className="px-2 pb-2 text-sm text-muted-foreground">{caps.note ?? "This model doesn't let Sush change how much it thinks."}</p>
        ) : (
          <>
            <DropdownMenuRadioGroup value={selected} onValueChange={pick}>
              {canToggle && (
                <DropdownMenuRadioItem value="off">
                  <EffortBars lit={0} />
                  Off
                </DropdownMenuRadioItem>
              )}
              {EFFORTS.map((e, i) => {
                const ok = effortAllowed(caps, e.id, true);
                return (
                  <DropdownMenuRadioItem key={e.id} value={e.id} disabled={!ok}>
                    <EffortBars lit={i + 1} className={EFFORT_BARS[e.id]} />
                    {e.label}
                    {caps.defaultEffort === e.id && <span className="text-xs text-muted-foreground">default</span>}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            {caps.note && (
              <>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{caps.note}</p>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
