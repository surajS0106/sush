// Models in words people can read: "nemotron-3-ultra:cloud" → "Nemotron 3 Ultra",
// "claude-sonnet-5-5" → "Claude Sonnet 5.5", "gpt-5.6-mini-2026-03-01" → "GPT-5.6 Mini";
// a one-word hint about what a model is for; and which models just failed for
// an account reason (out of credits, a rejected key), so the picker can say so.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import type { ModelTarget } from "@/lib/transport";

const UPPER = new Set(["gpt", "glm", "qwq", "llm", "oss", "vl"]);

/** A model's name for people: its own display name, else its id tidied up. */
export function friendlyName(id: string, displayName?: string | null): string {
  if (displayName?.trim()) return displayName.trim();
  // Drop the provider path ("meta-llama/…"), the tag (":cloud", ":latest") and a release date.
  let s = id.split("/").pop() ?? id;
  s = s.replace(/:[\w.-]+$/, "").replace(/[-_]?(20\d{2})-?(\d{2})-?(\d{2})$/, "").replace(/[-_]latest$/, "");
  const parts = s.split(/[-_\s]+/).filter(Boolean);
  const words: string[] = [];
  for (const p of parts) {
    // "5", "5" → "5.5": versions split across dashes.
    if (/^\d+$/.test(p) && words.length && /^\d+(\.\d+)?$/.test(words[words.length - 1]) && !words[words.length - 1].includes(".")) {
      words[words.length - 1] += `.${p}`;
      continue;
    }
    words.push(p);
  }
  let out = words.map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  // "GPT 5.6" reads as "GPT-5.6".
  out = out.replace(/^GPT (\d)/, "GPT-$1");
  return out || id;
}

/** What a model is good for, in a word, when its name says so. */
export function modelHint(id: string, local: boolean): string | null {
  const s = id.toLowerCase();
  if (local) return "On this computer";
  if (/haiku|mini|nano|flash|lite|small|fast|turbo|8b|7b|3b/.test(s)) return "Fast";
  if (/opus|ultra|large|\bmax\b|-pro\b|70b|405b|fable/.test(s)) return "Strongest";
  if (/sonnet|medium|4o|5\.\d|gpt-5|gemini|deepseek|qwen|llama/.test(s)) return "Balanced";
  return null;
}

/** Is this provider on this computer (an Ollama or LM Studio running locally)? */
export const isLocalProvider = (baseUrl: string) => /localhost|127\.0\.0\.1|:11434|:1234/.test(baseUrl);

// --- models that just failed for an account reason -----------------------------------------------

/** By `providerId/model`: why its last request failed, while that holds. */
const health = createStore<Record<string, { problem: string; at: number }>>("sush.model-health", {});

export const useModelHealth = () => useSyncExternalStore(health.subscribe, health.get);
const key = (t: ModelTarget) => `${t.providerId}/${t.model}`;

/** Note a failed request: an account problem is kept to show in the picker. */
export function noteModelProblem(t: ModelTarget, problem: string) {
  health.set((all) => ({ ...all, [key(t)]: { problem, at: Date.now() } }));
}

/** A request on this model worked: forget any problem. */
export function noteModelWorked(t: ModelTarget) {
  if (health.get()[key(t)]) {
    health.set((all) => {
      const next = { ...all };
      delete next[key(t)];
      return next;
    });
  }
}

export const modelProblem = (all: Record<string, { problem: string; at: number }>, t: ModelTarget) => all[key(t)]?.problem;
