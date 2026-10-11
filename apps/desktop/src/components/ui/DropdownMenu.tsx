import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface DropdownMenuItem<T extends string> {
  value: T;
  label: string;
  /** Shown before the label, in the trigger and the list. */
  icon?: ReactNode;
}

export function DropdownMenu<T extends string>({
  label,
  items,
  value,
  onChange,
  align = "start",
}: {
  /** Accessible name for the trigger. */
  label: string;
  items: DropdownMenuItem<T>[];
  value: T;
  onChange: (value: T) => void;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const selected = items.find((item) => item.value === value) ?? items[0];

  useEffect(() => {
    if (!open) return;
    setHighlighted(Math.max(0, items.findIndex((item) => item.value === value)));
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const select = (item: DropdownMenuItem<T>) => {
    onChange(item.value);
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setHighlighted((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) select(items[highlighted]);
      else setOpen(true);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${selected.label}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {selected.icon}
        {selected.label}
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
          className="text-muted-foreground"
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
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            style={{ transformOrigin: align === "end" ? "top right" : "top left" }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "absolute top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md",
              align === "end" ? "right-0" : "left-0",
            )}
          >
            <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
              {items.map((item, i) => (
                <div
                  key={item.value}
                  role="menuitemradio"
                  aria-checked={item.value === value}
                  tabIndex={-1}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => select(item)}
                  className="relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                >
                  {highlighted === i && (
                    <motion.span
                      layoutId="dropdown-menu-highlight"
                      className="absolute inset-0 rounded-md bg-accent"
                      transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 600, damping: 40 }}
                    />
                  )}
                  <span className="relative flex flex-1 items-center gap-2">
                    {item.icon}
                    {item.label}
                  </span>
                  {item.value === value && <CheckIcon className="relative size-4 text-muted-foreground" />}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
