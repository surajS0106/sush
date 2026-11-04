// The composer's thinking and effort menu. Every option stays listed, and what the
// picked model doesn't accept is disabled, with the reason below.

import { ChevronDownIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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

const AUTO = "auto";

/** Every label the pill can show. They're stacked invisibly under the current one so its width never changes. */
const PILL_LABELS = ["Thinking", "Thinking off", ...EFFORTS.map((e) => e.label)];

/** Each level's color, on the bars and the pill around them. */
const EFFORT_STYLE: Record<Effort, { bars: string; pill: string }> = {
  low: { bars: "text-effort-low", pill: "border-effort-low/40 bg-effort-low/10 hover:bg-effort-low/15" },
  medium: { bars: "text-effort-medium", pill: "border-effort-medium/40 bg-effort-medium/10 hover:bg-effort-medium/15" },
  high: { bars: "text-effort-high", pill: "border-effort-high/40 bg-effort-high/10 hover:bg-effort-high/15" },
  xhigh: { bars: "text-effort-xhigh", pill: "border-effort-xhigh/40 bg-effort-xhigh/10 hover:bg-effort-xhigh/15" },
  max: { bars: "text-effort-max", pill: "border-effort-max/40 bg-effort-max/10 hover:bg-effort-max/15" },
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
  const autoAllowed = caps.efforts.length > 0 && (thinking || !caps.offDisablesEffort);
  const offCaps = !thinking && caps.offMaxEffort;
  const note = caps.note ?? (offCaps ? `With thinking off, effort goes up to ${effortLabel(caps.offMaxEffort!)}.` : undefined);
  // Auto shows the model's default level. Thinking on with no known level reads as medium.
  const barEffort = thinking && !unknown ? (effort ?? caps.defaultEffort ?? "medium") : null;
  const litBars = EFFORTS.findIndex((e) => e.id === barEffort) + 1;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!target}
          aria-label={`Thinking and effort: ${label}`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium shadow-xs transition-colors disabled:opacity-50",
            barEffort
              ? cn("text-foreground", EFFORT_STYLE[barEffort].pill)
              : "border-foreground/10 bg-foreground/[0.03] text-muted-foreground hover:bg-foreground/[0.06] dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10",
          )}
        >
          <EffortBars lit={litBars} className={barEffort ? EFFORT_STYLE[barEffort].bars : undefined} />
          <span className="hidden whitespace-nowrap sm:inline-grid">
            {PILL_LABELS.map((l) => (
              <span key={l} className="invisible col-start-1 row-start-1">{l}</span>
            ))}
            <span className="col-start-1 row-start-1">{label}</span>
          </span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuCheckboxItem
          checked={thinking}
          disabled={caps.thinking !== "optional"}
          // Stays open: effort is usually the next choice.
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(on) => setPrefs({ thinking: on })}
        >
          Thinking
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={effort ?? AUTO}
          onValueChange={(v) => setPrefs({ reasoningEffort: v === AUTO ? null : (v as Effort) })}
        >
          <DropdownMenuRadioItem value={AUTO} disabled={!autoAllowed} onSelect={(e) => e.preventDefault()}>
            Auto
            {caps.defaultEffort && autoAllowed && (
              <span className="ml-auto text-xs text-muted-foreground">{effortLabel(caps.defaultEffort)}</span>
            )}
          </DropdownMenuRadioItem>
          {EFFORTS.map((e) => (
            <DropdownMenuRadioItem
              key={e.id}
              value={e.id}
              disabled={!effortAllowed(caps, e.id, thinking)}
              onSelect={(ev) => ev.preventDefault()}
            >
              {e.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {note && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{note}</p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
