// Which character stands on the composer, from Settings → Sushi: the original
// nigiri ("sushi") or any built-in avatar, brought to life (components/mascot.tsx).

import { useSyncExternalStore } from "react";

import { AVATARS } from "@/lib/avatars";
import { createStore } from "@/lib/store";

export const DEFAULT_MASCOT = "sushi";

export const MASCOTS: { key: string; label: string }[] = [
  { key: DEFAULT_MASCOT, label: "Sushi" },
  ...AVATARS.map((a) => ({ key: a.key, label: a.label })),
];

const mascot = createStore<string>("sush.mascot", DEFAULT_MASCOT);
// A key from an avatar that no longer exists falls back to Sushi.
if (!MASCOTS.some((m) => m.key === mascot.get())) mascot.set(DEFAULT_MASCOT);

export const useMascot = () => useSyncExternalStore(mascot.subscribe, mascot.get);
export const setMascot = (key: string) => mascot.set(key);
