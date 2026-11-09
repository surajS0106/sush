// The composer's permission mode: whether connector tools wait for approval.
// A toggle: on = Auto (Sush runs on its own), off = Manual (asks first).

import { HandIcon, ZapIcon } from "lucide-react";

import { setPrefs, usePrefs } from "@/lib/library";
import { cn } from "@/lib/utils";

export function PermissionModePicker() {
  const auto = usePrefs().permissionMode === "auto";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={auto}
      aria-label="Auto mode"
      title={
        auto
          ? "Auto: Sush runs on its own and pauses to ask if anything looks unsafe."
          : "Manual: Sush asks before using connector tools."
      }
      onClick={() => setPrefs({ permissionMode: auto ? "manual" : "auto" })}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-2 rounded-full border pl-2.5 pr-1.5 text-xs font-medium shadow-xs transition-colors",
        auto
          ? "border-sush/50 bg-sush/15 text-sush-deep hover:bg-sush/25 dark:bg-sush/20 dark:text-sush dark:hover:bg-sush/30"
          : "border-amber-500/50 bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:bg-amber-500/20 dark:text-amber-300 dark:hover:bg-amber-500/30",
      )}
    >
      {auto ? <ZapIcon className="size-3.5 fill-current" /> : <HandIcon className="size-3.5" />}
      {auto ? "Auto" : "Manual"}
      <span
        aria-hidden
        className={cn(
          "relative h-4 w-7 rounded-full transition-colors",
          auto ? "bg-sush-deep dark:bg-sush" : "bg-amber-500/50 dark:bg-amber-400/50",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-all",
            auto ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}
