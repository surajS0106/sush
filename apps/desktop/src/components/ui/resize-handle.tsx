import * as React from "react";

import { cn } from "@/lib/utils";

const KEY_STEP = 16;
/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

export interface ResizeHandleProps extends Omit<React.ComponentProps<"div">, "onChange"> {
  /** Names what it resizes, for screen readers. */
  label: string;
  /** The edge it sits on: dragging away from the container's center widens it. */
  edge: "left" | "right";
  min: number;
  max: number | (() => number);
  /** The container's current width in px; read when a drag or key press starts. */
  measure: () => number;
  onResize: (width: number) => void;
  /** Double-click (or Enter) puts the default width back. */
  onReset?: () => void;
  /** 2 for a centered column, which grows on both sides as one edge moves. */
  scale?: number;
}

/**
 * A vertical splitter on a container's edge. Drag it, or focus it and use the
 * arrow keys (Home/End jump to the limits). While a drag is on,
 * `data-resizing` on <html> pins the cursor and turns off width transitions
 * (index.css), so the container tracks the pointer exactly.
 */
export function ResizeHandle({
  label,
  edge,
  min,
  max,
  measure,
  onResize,
  onReset,
  scale = 1,
  className,
  ...props
}: ResizeHandleProps) {
  const maxOf = () => Math.max(min, typeof max === "function" ? max() : max);
  const clamp = (w: number) => Math.round(Math.min(maxOf(), Math.max(min, w)));
  const sign = edge === "right" ? 1 : -1;
  const [now, setNow] = React.useState<number>();

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = measure();
    let dragging = false;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        document.documentElement.dataset.resizing = "";
      }
      const width = clamp(start + sign * dx * scale);
      setNow(width);
      onResize(width);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      delete document.documentElement.dataset.resizing;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = measure();
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next =
      e.key === "ArrowRight" ? current + sign * step
      : e.key === "ArrowLeft" ? current - sign * step
      : e.key === "Home" ? min
      : e.key === "End" ? maxOf()
      : null;
    if (next !== null) {
      e.preventDefault();
      const width = clamp(next);
      setNow(width);
      onResize(width);
    } else if (e.key === "Enter" && onReset) {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={typeof max === "number" ? max : undefined}
      aria-valuenow={now}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={() => setNow(measure())}
      onDoubleClick={onReset}
      className={cn(
        // A 12px hit area around a 2px line that shows on hover, drag and focus.
        "group/resize absolute inset-y-0 z-20 flex w-3 cursor-col-resize touch-none justify-center outline-none select-none",
        edge === "right" ? "-right-1.5" : "-left-1.5",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="h-full w-0.5 rounded-full bg-transparent transition-colors duration-150 group-hover/resize:bg-border group-focus-visible/resize:bg-ring group-active/resize:bg-ring"
      />
    </div>
  );
}
