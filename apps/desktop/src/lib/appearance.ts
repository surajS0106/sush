// Appearance preferences from Settings → General. Theme itself is next-themes';
// these are applied as data attributes on <html>, which index.css maps to
// the transcript's font, size and width, the accent color, and reduced motion.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

export type ChatFont = "sans" | "serif" | "mono";
export type TextSize = "small" | "medium" | "large";
export type TranscriptWidth = "narrow" | "medium" | "wide";
export type Motion = "system" | "reduced";
export type Accent = "orange" | "red" | "pink" | "violet" | "blue" | "teal" | "green" | "graphite";

/** In picker order; index.css defines each one's --brand for light and dark. */
export const ACCENTS: { value: Accent; label: string }[] = [
  { value: "orange", label: "Orange" },
  { value: "red", label: "Red" },
  { value: "pink", label: "Pink" },
  { value: "violet", label: "Violet" },
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "green", label: "Green" },
  { value: "graphite", label: "Graphite" },
];

export interface Appearance {
  chatFont: ChatFont;
  textSize: TextSize;
  width: TranscriptWidth;
  motion: Motion;
  accent: Accent;
}

const DEFAULTS: Appearance = {
  chatFont: "sans",
  textSize: "medium",
  width: "medium",
  motion: "system",
  accent: "orange",
};

const appearance = createStore<Appearance>("sush.appearance", DEFAULTS);
// Fill in preferences added since the stored copy was saved.
appearance.set((a) => ({ ...DEFAULTS, ...a }));

function apply({ chatFont, textSize, width, motion, accent }: Appearance) {
  const { dataset } = document.documentElement;
  dataset.chatFont = chatFont;
  dataset.textSize = textSize;
  dataset.transcriptWidth = width;
  dataset.motion = motion;
  dataset.accent = accent;
}

apply(appearance.get());
appearance.subscribe(() => apply(appearance.get()));

export const useAppearance = () => useSyncExternalStore(appearance.subscribe, appearance.get);
export const setAppearance = (patch: Partial<Appearance>) => appearance.set((a) => ({ ...a, ...patch }));
