"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const PRESETS = [
  "#0f172a", "#ef4444", "#f97316", "#f59e0b", "#22c55e",
  "#14b8a6", "#3b82f6", "#10b981", "#ec4899", "#a8a29e",
];

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const to = (val: number) => Math.round((val + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  /** Accessible name for the trigger. */
  label?: string;
  className?: string;
  /** Replaces the default swatch trigger styling (h-5 w-5 rounded ring). */
  triggerClassName?: string;
  /**
   * Quick picks under the hex field. Defaults to a ten-hue set; pass the
   * colours already in use (so a board stays consistent without forcing a
   * palette on anyone), or an empty array to hide the row.
   */
  swatches?: string[];
}

/**
 * The popover is portalled to the body, which puts it outside any local theme
 * scope (a template with its own light/dark switch). Read the nearest scope
 * off the trigger when opening and repeat it on a wrapper around the portal.
 */
function themeScope(el: HTMLElement | null): "dark" | "light" | null {
  const host = el?.closest("[data-light], .dark");
  if (!host) return null;
  return host.hasAttribute("data-light") ? "light" : "dark";
}

export function ColorPicker({
  value,
  onChange,
  label = "Colour",
  className,
  triggerClassName,
  swatches = PRESETS,
}: ColorPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"dark" | "light" | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexDraft, setHexDraft] = useState(value);

  // Resync from an external value change, but not from our own onChange echo
  // (which would lose hue at s or v === 0).
  useEffect(() => {
    if (hsvToHex(hsv.h, hsv.s, hsv.v).toLowerCase() !== value.toLowerCase()) {
      setHsv(hexToHsv(value));
    }
    setHexDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    }
    // Capture on window so Escape closes only the picker: a dialog around the
    // trigger listens on the document and would otherwise close too.
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // The popover renders in a portal at the document root so it is never clipped
  // by an ancestor's overflow or paint containment. Its z-index sits above any
  // app overlay for the same reason: a picker opened from inside a full-screen
  // sheet or dialog has to land on top of it, not behind it. Position it against the
  // trigger each frame it could move, flipping above when there is no room below.
  // Inside a dialog it portals into the dialog instead (see `host`) and is
  // placed within the dialog's box, relative to it.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const b = host?.getBoundingClientRect() ?? { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
      const gap = 8;
      const ph = popRef.current?.offsetHeight ?? 280;
      const pw = popRef.current?.offsetWidth ?? 224;
      const below = b.bottom - t.bottom;
      const flip = below < ph + gap && t.top - b.top > below;
      const top = flip ? Math.max(b.top + gap, t.top - gap - ph) : t.bottom + gap;
      const left = clamp(t.left, b.left + gap, Math.max(b.left + gap, b.right - pw - gap));
      setPos({ top: top - b.top, left: left - b.left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, host]);

  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  function commit(next: Hsv) {
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  }

  function svFromEvent(clientX: number, clientY: number) {
    const r = svRef.current?.getBoundingClientRect();
    if (!r) return;
    commit({
      ...hsv,
      s: clamp((clientX - r.left) / r.width, 0, 1),
      v: clamp(1 - (clientY - r.top) / r.height, 0, 1),
    });
  }
  function hueFromEvent(clientX: number) {
    const r = hueRef.current?.getBoundingClientRect();
    if (!r) return;
    commit({ ...hsv, h: clamp(((clientX - r.left) / r.width) * 360, 0, 359.9) });
  }

  function dragSV(e: ReactPointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    svFromEvent(e.clientX, e.clientY);
  }
  function dragHue(e: ReactPointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    hueFromEvent(e.clientX);
  }

  function onHexInput(v: string) {
    setHexDraft(v);
    const withHash = v.startsWith("#") ? v : "#" + v;
    if (HEX_RE.test(withHash)) {
      const lower = withHash.toLowerCase();
      setHsv(hexToHsv(lower));
      onChange(lower);
    }
  }

  const hueHex = hsvToHex(hsv.h, 1, 1);

  return (
    <div ref={rootRef} className={cx("inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setScope(themeScope(triggerRef.current));
          // A modal dialog traps focus and blocks pointer events outside itself,
          // so a popover portalled to the body would be unusable from inside one.
          setHost(triggerRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null);
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label + ", " + value.toUpperCase()}
        className={
          triggerClassName ??
          "h-5 w-5 rounded ring-1 ring-black/10 transition-transform hover:scale-110 dark:ring-white/20"
        }
        style={{ background: value }}
      />

      {open && typeof document !== "undefined"
        ? createPortal(
        <div className={scope === "dark" ? "dark" : undefined} data-light={scope === "light" ? "" : undefined}>
        <div
          ref={popRef}
          data-color-picker=""
          role="dialog"
          aria-label={label + " picker"}
          className={cx(host ? "absolute" : "fixed", "z-100 w-56 rounded-xl border border-stone-200 bg-white p-3 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-700 dark:bg-stone-900")}
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
        >
          <div
            ref={svRef}
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.s * 100)}
            aria-valuetext={
              Math.round(hsv.s * 100) + " percent saturation, " + Math.round(hsv.v * 100) + " percent brightness"
            }
            onPointerDown={dragSV}
            onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && svFromEvent(e.clientX, e.clientY)}
            onKeyDown={(e) => {
              const d = e.shiftKey ? 0.1 : 0.02;
              const keys = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];
              if (!keys.includes(e.key)) return;
              e.preventDefault();
              if (e.key === "ArrowRight") commit({ ...hsv, s: clamp(hsv.s + d, 0, 1) });
              else if (e.key === "ArrowLeft") commit({ ...hsv, s: clamp(hsv.s - d, 0, 1) });
              else if (e.key === "ArrowUp") commit({ ...hsv, v: clamp(hsv.v + d, 0, 1) });
              else commit({ ...hsv, v: clamp(hsv.v - d, 0, 1) });
            }}
            className="relative h-32 w-full cursor-crosshair touch-none rounded-lg outline-none ring-stone-900/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:ring-white/60"
            style={{
              background: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, " + hueHex + ")",
            }}
          >
            <span
              aria-hidden
              className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: hsv.s * 100 + "%", top: (1 - hsv.v) * 100 + "%", background: value }}
            />
          </div>

          <div
            ref={hueRef}
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            onPointerDown={dragHue}
            onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && hueFromEvent(e.clientX)}
            onKeyDown={(e) => {
              const d = e.shiftKey ? 20 : 2;
              if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                commit({ ...hsv, h: (hsv.h + d) % 360 });
              } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                commit({ ...hsv, h: (hsv.h - d + 360) % 360 });
              }
            }}
            className="relative mt-3 h-3 w-full cursor-pointer touch-none rounded-full outline-none ring-stone-900/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:ring-white/60"
            style={{
              background: "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
            }}
          >
            <span
              aria-hidden
              className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: (hsv.h / 360) * 100 + "%", background: hueHex }}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="h-6 w-6 shrink-0 rounded ring-1 ring-black/10 dark:ring-white/15" style={{ background: value }} />
            <input
              value={hexDraft.toUpperCase()}
              onChange={(e) => onHexInput(e.target.value)}
              onBlur={() => setHexDraft(value)}
              spellCheck={false}
              aria-label="Hex value"
              className="w-full rounded-md border border-stone-200 bg-transparent px-2 py-1 font-mono text-[11px] uppercase text-stone-700 outline-none focus:border-stone-400 dark:border-stone-700 dark:text-stone-200"
            />
          </div>

          {swatches.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {swatches.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setHsv(hexToHsv(p));
                  onChange(p);
                }}
                aria-label={"Use " + p}
                className="h-4 w-4 rounded ring-1 ring-black/10 transition-transform hover:scale-110 dark:ring-white/15"
                style={{ background: p }}
              />
            ))}
          </div>
          )}
        </div>
        </div>,
        host ?? document.body
      )
        : null}
    </div>
  );
}

/*
Usage:

const [color, setColor] = useState("#6d5efc");
<ColorPicker value={color} onChange={setColor} label="Brand colour" />

Controlled by a hex string. HSV field + hue rail are pointer-captured sliders
with arrow-key support; the popover closes on Escape or outside click.
*/
