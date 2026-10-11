// Appearance preferences from Settings → General. Theme itself is next-themes';
// these are applied as data attributes on <html>, which index.css maps to
// the transcript's font, size and width, the accent color, and reduced motion.

import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import { createStore } from "@/lib/store";

export type ChatFont = "sans" | "serif" | "mono" | "space-mono";
export type TextSize = "small" | "medium" | "large";
export type TranscriptWidth = "narrow" | "medium" | "wide";
export type Motion = "system" | "reduced";
export type Accent = "sush" | "orange" | "red" | "pink" | "violet" | "blue" | "teal" | "green" | "graphite" | "custom";

/**
 * In picker order; index.css defines each preset's --brand for light and dark.
 * "custom" reads the --custom-brand* variables that apply() derives from
 * `customAccent`.
 */
export const ACCENTS: { value: Accent; label: string }[] = [
  { value: "sush", label: "Default" },
  { value: "red", label: "Coral" },
  { value: "orange", label: "Orange" },
  { value: "pink", label: "Pink" },
  { value: "violet", label: "Violet" },
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Deep teal" },
  { value: "green", label: "Green" },
  { value: "graphite", label: "Graphite" },
  { value: "custom", label: "Custom" },
];

export interface Appearance {
  chatFont: ChatFont;
  textSize: TextSize;
  width: TranscriptWidth;
  motion: Motion;
  accent: Accent;
  /** The color picked for the "custom" accent, as #rrggbb. */
  customAccent: string;
  /** Bumped when the default accent changes; see the migration below. */
  palette?: number;
}

const DEFAULTS: Appearance = {
  chatFont: "sans",
  textSize: "medium",
  width: "medium",
  motion: "system",
  accent: "sush",
  customAccent: "#d946ef",
  palette: 2,
};

const appearance = createStore<Appearance>("sush.appearance", DEFAULTS);
// Fill in preferences added since the stored copy was saved. Copies saved
// before palette 2 hold the old orange default, so move those to Sush once;
// orange stays available to pick again.
appearance.set((a) => ({
  ...DEFAULTS,
  ...a,
  ...((a.palette ?? 1) < 2 && { accent: a.accent === "orange" ? "sush" : a.accent, palette: 2 }),
}));

function apply({ chatFont, textSize, width, motion, accent, customAccent }: Appearance) {
  const { dataset, style } = document.documentElement;
  dataset.chatFont = chatFont;
  dataset.textSize = textSize;
  dataset.transcriptWidth = width;
  dataset.motion = motion;
  dataset.accent = accent;
  // Set even when another accent is active: the picker's swatch for "custom"
  // reads these too.
  const [l, c, h] = hexToOklch(/^#[0-9a-f]{6}$/i.test(customAccent) ? customAccent : DEFAULTS.customAccent);
  for (const [mode, [min, max]] of [["", LIGHT_RANGE], ["-dark", DARK_RANGE]] as const) {
    const lightness = Math.min(max, Math.max(min, l));
    style.setProperty(`--custom-brand${mode}`, `oklch(${lightness.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`);
    style.setProperty(`--custom-brand${mode}-foreground`, lightness > 0.74 ? "oklch(0.205 0 0)" : "oklch(1 0 0)");
  }
}

// A custom accent keeps its hue and chroma, but its lightness is held in the
// range the presets span for each theme so the send button and other accents
// stay visible against the background: pure white in light mode or black in
// dark mode would vanish. Text on the accent turns dark once it gets light.
const LIGHT_RANGE = [0.3, 0.76] as const;
const DARK_RANGE = [0.6, 0.9] as const;

/** #rrggbb → [lightness 0–1, chroma, hue in degrees], via OKLab. */
function hexToOklch(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, n >> 8, n].map((v) => {
    const c = (v & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lms = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  const [l_, m_, s_] = lms;
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720454 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const hue = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), hue < 0 ? hue + 360 : hue];
}

apply(appearance.get());
appearance.subscribe(() => apply(appearance.get()));

export const useAppearance = () => useSyncExternalStore(appearance.subscribe, appearance.get);
export const setAppearance = (patch: Partial<Appearance>) => appearance.set((a) => ({ ...a, ...patch }));

/**
 * Runs `update` (a next-themes setTheme call) as a cross-fade between the old
 * and new theme. The View Transitions API snapshots the whole page, so every
 * color changes in one fade instead of element by element; index.css sets the
 * timing. flushSync makes next-themes commit and swap the class on <html>
 * inside the callback, before the new snapshot is taken. Without the API, or
 * with reduced motion, the theme changes instantly.
 */
export function transitionTheme(update: () => void) {
  const reduced =
    appearance.get().motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !("startViewTransition" in document)) return update();
  document.startViewTransition(() => flushSync(update));
}
