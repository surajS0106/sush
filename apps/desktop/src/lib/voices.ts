// Voices for notebooks' audio overviews (Settings → Speech → Audio overviews).
// "system": the computer's own voices read the script live; free, offline,
// nothing to set up, nothing saved. "provider": an OpenAI-compatible
// `/audio/speech` endpoint (OpenAI, Azure Foundry, Groq, or a local server
// such as Kokoro-FastAPI) voices each turn once, and the clips are kept.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

export interface VoiceSettings {
  engine: "system" | "provider";
  providerId: string | null;
  model: string;
  /** The provider's voice names for host a and host b. */
  voiceA: string;
  voiceB: string;
  /** System voices by `voiceURI`; empty uses the default. */
  systemA: string;
  systemB: string;
}

const voices = createStore<VoiceSettings>("sush.voices", {
  engine: "system",
  providerId: null,
  model: "gpt-4o-mini-tts",
  voiceA: "alloy",
  voiceB: "verse",
  systemA: "",
  systemB: "",
});

export const useVoiceSettings = () => useSyncExternalStore(voices.subscribe, voices.get);
export const getVoiceSettings = voices.get;
export const setVoiceSettings = (patch: Partial<VoiceSettings>) => voices.set((v) => ({ ...v, ...patch }));

/** Which voices made a set of clips: when it changes, the clips are made again. */
export const voicesKey = (v: VoiceSettings) => `${v.providerId}|${v.model}|${v.voiceA}|${v.voiceB}`;

/** How the hosts sound, for models that take delivery instructions. */
export const DELIVERY =
  "A warm, curious podcast host talking with a colleague: conversational, natural pace, real interest, never reading aloud.";

/** The computer's voices, English first, once the browser has them. */
export function systemVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === "undefined") return [];
  return [...speechSynthesis.getVoices()].sort(
    (a, b) => Number(b.lang.startsWith("en")) - Number(a.lang.startsWith("en")) || a.name.localeCompare(b.name),
  );
}

/** The system voice for a host: the one picked, else two different English voices. */
export function systemVoiceFor(host: "a" | "b", settings: VoiceSettings): SpeechSynthesisVoice | undefined {
  const all = systemVoices();
  const picked = all.find((v) => v.voiceURI === (host === "a" ? settings.systemA : settings.systemB));
  if (picked) return picked;
  const english = all.filter((v) => v.lang.startsWith("en"));
  return (english.length >= 2 ? english : all)[host === "a" ? 0 : Math.min(1, all.length - 1)];
}
