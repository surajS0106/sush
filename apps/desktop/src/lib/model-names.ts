// Models in words people can read: "nemotron-3-ultra:cloud" → "Nemotron 3 Ultra",
// "claude-sonnet-5-5" → "Claude Sonnet 5.5", "gpt-5.6-mini-2026-03-01" → "GPT-5.6 Mini";
// a one-word hint about what a model is for; and which models just failed for
// an account reason (out of credits, a rejected key), so the picker can say so.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import type { ModelTarget } from "@/lib/transport";

const UPPER = new Set(["gpt", "glm", "qwq", "llm", "oss", "vl"]);

/**
 * Models that only make images (or video) and fail on a chat endpoint: OpenAI's gpt-image and DALL·E,
 * xAI's Grok Imagine, Imagen, Veo, Sora, FLUX, Stable Diffusion. They belong in Settings → Images, so the
 * chat picker leaves them out. Chat models that can also draw (gemini-…-image) are kept.
 */
const IMAGE_ONLY =
  /^(chatgpt-image|gpt-image|dall-e|grok-(\d+-)?image|grok-imagine|imagen|veo|sora|flux|stable-diffusion|sdxl|sd3|recraft|ideogram|midjourney)/i;

/**
 * Other models that can't hold a conversation: speech, transcription, embeddings, moderation,
 * realtime, legacy completions. Picked for a chat they only fail.
 */
const NOT_CHAT =
  /(^|[/:_.-])(tts|whisper|transcribe|embed|embedding|embeddings|moderation|omni-moderation|text-moderation|realtime|davinci-002|babbage-002)($|[/:_.-])/i;

/** Whether a model only makes images or video (Settings → Images lists these). */
export function isImageOnlyModel(id: string): boolean {
  return IMAGE_ONLY.test(id.split("/").pop() ?? id);
}

/** Whether a model belongs in the chat picker. Filtered at display time, never when the list loads. */
export function isChatModel(id: string): boolean {
  return !isImageOnlyModel(id) && !NOT_CHAT.test(id);
}

const SNAPSHOT = /[-_]?(20\d{2})-?(\d{2})-?(\d{2})$/;

/**
 * Leaves out dated snapshots ("gpt-image-2.5-sunburst-2026-08-01") when the provider also lists the
 * alias ("gpt-image-2.5-sunburst"): both read as the same name, so the picker showed what looked like
 * duplicates. The alias tracks the newest snapshot; a snapshot without an alias stays.
 */
export function withoutSnapshots<T extends { id: string }>(models: T[]): T[] {
  const ids = new Set(models.map((m) => m.id));
  return models.filter((m) => {
    const alias = m.id.replace(SNAPSHOT, "");
    return alias === m.id || !ids.has(alias);
  });
}

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
