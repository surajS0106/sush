import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import type { ModelTarget } from "@/lib/transport";

/** How many messages went to each model, and when it was last used, keyed `<providerId>/<model>`. */
type Usage = Record<string, { count: number; last: number }>;

const usage = createStore<Usage>("sush.model-usage", {});
const keyOf = (t: ModelTarget) => `${t.providerId}/${t.model}`;

/** Counts one message (a send, steer or regenerate) towards a model. */
export function recordModelUse(target: ModelTarget) {
  const key = keyOf(target);
  usage.set((all) => ({ ...all, [key]: { count: (all[key]?.count ?? 0) + 1, last: Date.now() } }));
}

/** Every model's usage, kept in step with other windows. */
export function useModelUsage() {
  return useSyncExternalStore(usage.subscribe, usage.get);
}

/**
 * The most used models, most used first (ties go to the most recent), among
 * those `available` says still exist. Only models used more than once count,
 * so a single try doesn't become a suggestion.
 */
export function topModels(all: Usage, available: (t: ModelTarget) => boolean, limit = 3): ModelTarget[] {
  return Object.entries(all)
    .filter(([, u]) => u.count > 1)
    .sort(([, a], [, b]) => b.count - a.count || b.last - a.last)
    .map(([key]) => {
      const slash = key.indexOf("/");
      return { providerId: key.slice(0, slash), model: key.slice(slash + 1) };
    })
    .filter(available)
    .slice(0, limit);
}
