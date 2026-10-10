// Building blocks for settings pages: a page, titled groups of rows, a row
// with a title/description on the left and its control on the right.

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function Page({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-8 py-6 pr-14 pl-8">{children}</div>;
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="pb-2 text-base font-semibold">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  );
}

export function Setting({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A row of mutually exclusive options, like a radio group. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-lg border bg-muted/40 p-0.5">
      {options.map((o) => {
        const button = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.icon ? o.label : undefined}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-7 items-center justify-center rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground",
              o.icon ? "w-8" : "px-3",
              value === o.value && "bg-background text-foreground shadow-xs ring-1 ring-foreground/10 dark:bg-accent",
            )}
          >
            {o.icon ? <o.icon className="size-4" /> : o.label}
          </button>
        );
        return o.icon ? (
          <Tooltip key={o.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{o.label}</TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
