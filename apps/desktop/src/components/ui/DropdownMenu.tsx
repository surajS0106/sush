import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckIcon } from "lucide-react";

import { FollowHighlight } from "@/components/ui/motion-highlight";
import { cn } from "@/lib/utils";

export interface DropdownMenuItem<T extends string> {
  value: T;
  label: string;
  /** Shown before the label, in the trigger and the list. */
  icon?: ReactNode;
  /** Muted text after the label in the list, e.g. "142 MB, offline". */
  hint?: string;
  disabled?: boolean;
  /** Applied to the label in the trigger and the list, e.g. a font preview. */
  style?: CSSProperties;
}

/** Height the list may take before it scrolls (`max-h-72`). */
const MAX_LIST_HEIGHT = 288;

/** The nearest ancestor that clips `el`, whose edges the menu has to fit inside. */
function clippingRect(el: HTMLElement): { top: number; bottom: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== "visible") return node.getBoundingClientRect();
  }
  return { top: 0, bottom: window.innerHeight };
}

const enabledIndex = (items: { disabled?: boolean }[], from: number, step: 1 | -1) => {
  for (let i = from; i >= 0 && i < items.length; i += step) if (!items[i].disabled) return i;
  return -1;
};

export function DropdownMenu<T extends string>({
  label,
  items,
  value,
  onChange,
  align = "start",
  variant = "ghost",
  placeholder = "Select…",
  className,
}: {
  /** Accessible name for the trigger. */
  label: string;
  items: DropdownMenuItem<T>[];
  value: T;
  onChange: (value: T) => void;
  align?: "start" | "end";
  /** `ghost`: a quiet button sized to its label, for settings rows. `field`: a full-width input-style box, for forms. */
  variant?: "ghost" | "field";
  /** Trigger text when `value` matches no item. */
  placeholder?: string;
  /** On the wrapper, e.g. a width. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const selected = items.find((item) => item.value === value);
  const field = variant === "field";

  useEffect(() => {
    if (!open) return;
    setHighlighted(Math.max(0, items.findIndex((item) => item.value === value)));
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Capture on window runs before a surrounding Radix dialog's Escape handler, so Escape closes only the menu.
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);

  // Open upward when the list wouldn't fit below the trigger but fits better above it.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const trigger = rootRef.current.getBoundingClientRect();
    const bounds = clippingRect(rootRef.current);
    const needed = Math.min(MAX_LIST_HEIGHT, items.length * 36 + 8) + 4;
    const below = bounds.bottom - trigger.bottom;
    setUp(below < needed && trigger.top - bounds.top > below);
  }, [open]);

  const select = (item: DropdownMenuItem<T>) => {
    if (item.disabled) return;
    onChange(item.value);
    setOpen(false);
  };

  const move = (to: number) => {
    if (to < 0) return;
    setHighlighted(to);
    listRef.current?.querySelectorAll('[role="menuitemradio"]')[to]?.scrollIntoView({ block: "nearest" });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      move(enabledIndex(items, highlighted + step, step));
    } else if (open && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      move(e.key === "Home" ? enabledIndex(items, 0, 1) : enabledIndex(items, items.length - 1, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) select(items[highlighted]);
      else setOpen(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", field ? "block w-full" : "inline-block", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex items-center gap-2 text-sm transition-colors duration-150 focus-visible:outline-none",
          field
            ? "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-left hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
            : "h-9 rounded-md px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          open && !field && "bg-accent",
        )}
      >
        {selected?.icon}
        <span className={cn("truncate", field && "flex-1", !selected && "text-muted-foreground")} style={selected?.style}>
          {selected?.label ?? placeholder}
        </span>
        <motion.svg
          animate={{ rotate: open ? 180 : 0 }}
          transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 30 }}
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-muted-foreground"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </motion.svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label={label}
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: up ? 4 : -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            style={{ transformOrigin: `${up ? "bottom" : "top"} ${align === "end" ? "right" : "left"}` }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "absolute z-50 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md",
              up ? "bottom-full mb-1" : "top-full mt-1",
              // At least as wide as the trigger (a field) or 11rem; wider when a label needs it.
              "w-max max-w-80",
              field ? "min-w-full" : "min-w-44",
              align === "end" ? "right-0" : "left-0",
            )}
          >
            <div ref={listRef} className="relative max-h-72 overflow-y-auto overscroll-contain p-1">
              {/* One background glides to the highlighted row; it scrolls with the rows, so it never drifts. */}
              <FollowHighlight selector="[data-highlighted]" className="rounded-md bg-accent" />
              {items.map((item, i) => (
                <div
                  key={item.value}
                  role="menuitemradio"
                  aria-checked={item.value === value}
                  aria-disabled={item.disabled || undefined}
                  data-highlighted={highlighted === i && !item.disabled ? "" : undefined}
                  tabIndex={-1}
                  onMouseEnter={() => !item.disabled && setHighlighted(i)}
                  onClick={() => select(item)}
                  className={cn(
                    "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    item.disabled && "cursor-default opacity-50",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {item.icon}
                    <span className="truncate" style={item.style}>
                      {item.label}
                      {item.hint && <span className="text-muted-foreground"> · {item.hint}</span>}
                    </span>
                  </span>
                  {item.value === value && <CheckIcon className="size-4 shrink-0 text-muted-foreground" />}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
