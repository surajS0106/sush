// An amount field: the currency's symbol in front, thousands separators added
// as you type (in the reader's own locale) without the cursor jumping, and
// shorthand like "250k" or "1.2m" filled out when you leave the field. It
// reports a number, or null when empty or unreadable.

import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes } from "react";

import { currencySign } from "@/lib/currency";
import { cn } from "@/lib/utils";

const locale = undefined;
const group = new Intl.NumberFormat(locale).formatToParts(11111).find((p) => p.type === "group")?.value ?? ",";
const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal")?.value ?? ".";


/** "1234567.5" → "1,234,567.5" (separators by locale), keeping a trailing decimal point while typing. */
function withSeparators(raw: string): string {
  const [int, frac] = raw.split(".");
  const grouped = (int || (frac !== undefined ? "0" : "")).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return frac !== undefined ? `${grouped}${decimal}${frac}` : grouped;
}

/** What was typed, as plain digits with at most one "." (shorthand and junk aside). */
function digits(text: string): string {
  let out = "";
  let dot = false;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === decimal && !dot) {
      out += ".";
      dot = true;
    }
  }
  return out;
}

/** Fill out shorthand: "250k" → 250000, "1.2m" → 1200000, "3b" → 3000000000. */
export function parseAmount(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const mult = /k$/.test(t) ? 1e3 : /m$/.test(t) ? 1e6 : /b$/.test(t) ? 1e9 : 1;
  const n = Number(digits(t));
  if (!Number.isFinite(n) || digits(t) === "") return null;
  return Math.round(n * mult * 100) / 100;
}

const show = (n: number | null | undefined) => (n == null ? "" : withSeparators(String(n)));

export const MoneyInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
    value: number | null | undefined;
    onValueChange: (value: number | null) => void;
    currency: string;
    /** Smaller, for table cells and filters. */
    compact?: boolean;
  }
>(function MoneyInput({ value, onValueChange, currency, compact, className, onBlur, onKeyDown, ...rest }, ref) {
  const [text, setText] = useState(() => show(value));
  const inner = useRef<HTMLInputElement | null>(null);
  const caret = useRef<number | null>(null);

  // A change from outside (another window, a reset) shows when it differs from what's typed.
  useEffect(() => {
    if (parseAmount(text) !== (value ?? null)) setText(show(value));
  }, [value]);

  // Put the cursor back after the same number of digits it was after.
  useEffect(() => {
    const el = inner.current;
    if (el == null || caret.current == null || document.activeElement !== el) return;
    let seen = 0;
    let pos = 0;
    while (pos < text.length && seen < caret.current) {
      if (/[0-9]/.test(text[pos]) || text[pos] === decimal) seen++;
      pos++;
    }
    el.setSelectionRange(pos, pos);
    caret.current = null;
  }, [text]);

  const symbol = currencySign(currency);
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        compact ? "h-7 px-2 text-sm" : "h-8 px-2.5 text-sm",
        className,
      )}
    >
      <span aria-hidden className="pr-1 text-muted-foreground">
        {symbol}
      </span>
      <input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        {...rest}
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          const typed = e.target.value;
          // Shorthand stays as typed until the field is left.
          if (/[kmb]\s*$/i.test(typed)) {
            setText(typed);
            return;
          }
          const before = e.target.selectionStart ?? typed.length;
          caret.current = digits(typed.slice(0, before)).length;
          const raw = digits(typed);
          setText(withSeparators(raw));
          onValueChange(raw === "" ? null : Number(raw));
        }}
        onBlur={(e) => {
          const n = parseAmount(text);
          setText(show(n));
          onValueChange(n);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const n = parseAmount(text);
            setText(show(n));
            onValueChange(n);
          }
          onKeyDown?.(e);
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
});
