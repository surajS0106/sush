import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";

const SPRING = { type: "spring", stiffness: 600, damping: 40 } as const;
const FADE = { duration: 0.12 };
/** How long a list may have no active item before the highlight fades, in ms. */
const HIDE_DELAY = 80;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Absent when the item is square, e.g. a list row wrapping a rounded button; the class's radius applies. */
  borderRadius?: string;
}

/** `el`'s box inside `container`, from offsets so scrolling and transforms (e.g. a zoom-in) don't skew it. */
function boxWithin(el: HTMLElement, container: Element): Box | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== container) return null;
  const box: Box = { x, y, width: el.offsetWidth, height: el.offsetHeight };
  const radius = getComputedStyle(el).borderRadius;
  if (radius !== "0px") box.borderRadius = radius;
  return box;
}

/**
 * One background that glides to `target`, taking its size and (if it has one) corner radius. Render it inside the
 * positioned element (usually the scroll container) that holds the items; it scrolls with them, so it never
 * drifts. Items must be positioned (`relative`) so they paint above it. It appears in place rather than
 * sliding in from where it last faded out. A target with `data-variant="destructive"` tints it red.
 */
export function MotionHighlight({
  target,
  revision,
  className,
}: {
  target: HTMLElement | null;
  /** Bump to re-measure when items move without the target changing (filtering, collapsing a group). */
  revision?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const [state, setState] = useState<{ box: Box | null; visible: boolean; snap: boolean; variant?: string }>({
    box: null,
    visible: false,
    snap: true,
  });

  useLayoutEffect(() => {
    const container = ref.current?.offsetParent;
    const box = target && container ? boxWithin(target, container) : null;
    setState((prev) =>
      box
        ? { box, visible: true, snap: !prev.visible, variant: target?.dataset.variant }
        : { ...prev, visible: false },
    );
  }, [target, revision]);

  return (
    <motion.span
      ref={ref}
      aria-hidden
      data-variant={state.variant}
      className={cn(
        "pointer-events-none absolute top-0 left-0 bg-accent data-[variant=destructive]:bg-destructive/10 dark:data-[variant=destructive]:bg-destructive/20",
        className,
      )}
      initial={false}
      animate={{ ...state.box, opacity: state.visible ? 1 : 0 }}
      transition={reduceMotion ? { duration: 0 } : state.snap ? { duration: 0, opacity: FADE } : { ...SPRING, opacity: FADE }}
    />
  );
}

/**
 * A highlight that follows whichever item inside its container matches `selector`, for lists that mark the
 * active item themselves (Radix `data-highlighted`, cmdk `data-selected`, `aria-selected` listboxes). Hover,
 * arrow keys and typeahead all move it, since it watches the DOM rather than the pointer.
 */
export function FollowHighlight({ selector, className }: { selector: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [revision, setRevision] = useState(0);

  useLayoutEffect(() => {
    const container = ref.current?.parentElement;
    if (!container) return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const next = container.querySelector<HTMLElement>(selector);
      clearTimeout(hideTimer);
      if (next) {
        setTarget(next);
        setRevision((r) => r + 1);
      } else {
        // Radix clears the highlight on pointer-leave before the next row takes it, so moving between rows
        // briefly has none. Hiding at once would make every move a fade-in instead of a glide; wait first.
        hideTimer = setTimeout(() => setTarget(null), HIDE_DELAY);
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-highlighted", "data-selected", "aria-selected", "hidden"],
    });
    return () => {
      observer.disconnect();
      clearTimeout(hideTimer);
    };
  }, [selector]);

  return (
    <>
      <span ref={ref} hidden />
      <MotionHighlight target={target} revision={revision} className={className} />
    </>
  );
}

/** A `relative` wrapper whose hovered item (closest match of `itemSelector`) gets a gliding highlight. */
export function HoverHighlight({
  itemSelector = "[data-hover-item]",
  className,
  highlightClassName,
  children,
}: {
  itemSelector?: string;
  className?: string;
  highlightClassName?: string;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return (
    <div
      className={cn("relative", className)}
      onPointerOver={(e) => {
        const item = (e.target as Element).closest<HTMLElement>(itemSelector);
        setTarget(item && e.currentTarget.contains(item) ? item : null);
      }}
      onPointerLeave={() => setTarget(null)}
    >
      <MotionHighlight target={target} className={highlightClassName} />
      {children}
    </div>
  );
}
