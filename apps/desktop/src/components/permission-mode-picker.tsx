// The composer's permission mode: whether connector tools wait for approval.

import { CheckIcon, ChevronDownIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setPrefs, usePrefs, type PermissionMode } from "@/lib/library";
import { cn } from "@/lib/utils";

const MODES: { id: PermissionMode; label: string; description: string }[] = [
  { id: "manual", label: "Manual", description: "Sush asks before using connector tools." },
  { id: "auto", label: "Auto", description: "Sush runs on its own and pauses to ask if anything looks unsafe." },
];

export function PermissionModePicker() {
  const mode = usePrefs().permissionMode;
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Permission mode: ${current.label}`}
          className={cn(
            "flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
            mode === "auto"
              ? "bg-brand/12 text-brand hover:bg-brand/18"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/10",
          )}
        >
          {current.label}
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 rounded-xl p-1.5">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Permission mode</DropdownMenuLabel>
        {MODES.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => setPrefs({ permissionMode: m.id })}
            className="items-start gap-3 rounded-lg px-2 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm">{m.label}</div>
              <p className="text-xs text-muted-foreground">{m.description}</p>
            </div>
            <CheckIcon className={cn("mt-0.5 size-4 text-brand", m.id !== mode && "invisible")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
