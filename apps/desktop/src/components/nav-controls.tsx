import { ArrowLeftIcon, ArrowRightIcon, PanelLeftIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Back/forward through the sessions you've opened. */
export interface Nav {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

/** Sidebar toggle plus back/forward, as in the title bar of Claude's desktop app. */
export function NavControls({ nav }: { nav: Nav }) {
  const { toggleSidebar } = useSidebar();
  return (
    <>
      <ToolbarButton label="Toggle sidebar" onClick={toggleSidebar}>
        <PanelLeftIcon />
      </ToolbarButton>
      <ToolbarButton label="Back" disabled={!nav.canBack} onClick={nav.back}>
        <ArrowLeftIcon />
      </ToolbarButton>
      <ToolbarButton label="Forward" disabled={!nav.canForward} onClick={nav.forward}>
        <ArrowRightIcon />
      </ToolbarButton>
    </>
  );
}

export const toolbarButtonClass =
  "flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-sidebar-accent [&>svg]:size-4";

/** Square ghost icon button for the title bar. */
export function ToolbarButton({
  label,
  className,
  children,
  ...props
}: { label: string; children: ReactNode } & ComponentProps<"button">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(toolbarButtonClass, className)}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
