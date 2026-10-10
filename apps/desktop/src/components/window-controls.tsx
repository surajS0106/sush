import { getCurrentWindow } from "@tauri-apps/api/window";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** macOS keeps its native traffic lights (overlay title bar); elsewhere the window is undecorated. */
export const IS_MAC = navigator.userAgent.includes("Mac");

/** Minimize / maximize / close, pinned to the window's top-right corner. Renders nothing on macOS. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (IS_MAC) return;
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    const unlisten = win.onResized(sync);
    return () => void unlisten.then((fn) => fn());
  }, []);

  if (IS_MAC) return null;
  const win = getCurrentWindow();

  return (
    <div className="fixed top-0 right-0 z-50 flex h-12">
      <ControlButton label="Minimize" onClick={() => void win.minimize()}>
        <MinusIcon />
      </ControlButton>
      <ControlButton label={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
        {maximized ? <CopyIcon className="-scale-x-100" /> : <SquareIcon />}
      </ControlButton>
      <ControlButton label="Close" onClick={() => void win.close()} className="hover:bg-red-600 hover:text-white">
        <XIcon />
      </ControlButton>
    </div>
  );
}

function ControlButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground [&_svg]:size-3.5 [&_svg]:stroke-[1.5]",
        className,
      )}
    >
      {children}
    </button>
  );
}
