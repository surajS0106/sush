// Widths the user dragged the sidebar and the Cowork side panel to. The
// transcript column's width is an appearance preference (lib/appearance.ts).

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

export interface Layout {
  /** The sidebar, in px. */
  sidebar: number;
  /** The Cowork side panel in px, or null for its default share of the window. */
  panel: number | null;
}

export const SIDEBAR = { min: 208, max: 480, default: 256 } as const;
/** The side panel never squeezes the chat narrower than `chatMin`. */
export const PANEL = { min: 320, max: 1400, chatMin: 360 } as const;

const DEFAULTS: Layout = { sidebar: SIDEBAR.default, panel: null };

const layout = createStore<Layout>("sush.layout", DEFAULTS);
layout.set((l) => ({ ...DEFAULTS, ...l }));

export const useLayout = () => useSyncExternalStore(layout.subscribe, layout.get);
export const setLayout = (patch: Partial<Layout>) => layout.set((l) => ({ ...l, ...patch }));
