// Voice mode's settings (Settings → Voice): which provider the user talks to,
// with which model and voice, and which of the four providers have a key.
// The keys themselves live in the OS keyring (`src-tauri/src/voice.rs`).

import { useEffect, useState, useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, type VoiceCatalog, type VoiceProvider } from "@/lib/tauri";

export interface VoiceProviderInfo {
  id: VoiceProvider;
  name: string;
  /** Speech to speech over one connection, or listen → think → speak. */
  realtime: boolean;
  blurb: string;
  keyUrl: string;
  defaultModel: string;
  defaultVoice: string;
}

export const VOICE_PROVIDERS: VoiceProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    realtime: true,
    blurb: "Speech to speech. It hears you and answers directly, with no pause to transcribe.",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-realtime",
    defaultVoice: "marin",
  },
  {
    id: "xai",
    name: "xAI",
    realtime: true,
    blurb: "Grok Voice. Speech to speech, quick and expressive.",
    keyUrl: "https://console.x.ai",
    defaultModel: "grok-voice-latest",
    defaultVoice: "ara",
  },
  {
    id: "sarvam",
    name: "Sarvam",
    realtime: false,
    blurb: "English and 10 Indian languages, switching as you do.",
    keyUrl: "https://dashboard.sarvam.ai",
    defaultModel: "bulbul:v3",
    defaultVoice: "shubh",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    realtime: false,
    blurb: "The most lifelike voices, yours included. Your chat model thinks.",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    defaultModel: "eleven_flash_v2_5",
    defaultVoice: "EXAVITQu4vr4xnSDxMaL",
  },
];

export const providerInfo = (id: VoiceProvider) => VOICE_PROVIDERS.find((p) => p.id === id)!;

export interface VoiceModeSettings {
  /** The provider picked; null picks the first with a key. */
  provider: VoiceProvider | null;
  models: Partial<Record<VoiceProvider, string>>;
  voices: Partial<Record<VoiceProvider, string>>;
  /** Who thinks in a Sarvam conversation: Sarvam's own model, or the chat's model. */
  sarvamBrain: "sarvam" | "chat";
  /** Added to the voice's instructions: how it should come across. */
  personality: string;
  /** Lift quiet speech so a whisper is heard. Missing (older settings) counts as on. */
  whispers?: boolean;
}

const settings = createStore<VoiceModeSettings>("sush.voice-mode", {
  provider: null,
  models: {},
  voices: {},
  sarvamBrain: "sarvam",
  personality: "",
  whispers: true,
});

export const useVoiceModeSettings = () => useSyncExternalStore(settings.subscribe, settings.get);
export const getVoiceModeSettings = settings.get;
export const setVoiceModeSettings = (patch: Partial<VoiceModeSettings>) => settings.set((s) => ({ ...s, ...patch }));
export const setVoiceModel = (p: VoiceProvider, model: string) => settings.set((s) => ({ ...s, models: { ...s.models, [p]: model } }));
export const setVoiceChoice = (p: VoiceProvider, voice: string) => settings.set((s) => ({ ...s, voices: { ...s.voices, [p]: voice } }));

export const modelFor = (s: VoiceModeSettings, p: VoiceProvider) => s.models[p] || providerInfo(p).defaultModel;
export const voiceFor = (s: VoiceModeSettings, p: VoiceProvider) => s.voices[p] || providerInfo(p).defaultVoice;

// --- keys -----------------------------------------------------------------------------

/** Providers with a key; null until asked. Not persisted: Rust knows. */
const keys = createStore<VoiceProvider[] | null>("sush.voice-mode.keys", null, false);
let asked = false;

export async function refreshVoiceKeys() {
  asked = true;
  try {
    keys.set(await api.voiceKeys());
  } catch {
    keys.set([]);
  }
}

export function useVoiceKeys(): VoiceProvider[] | null {
  const value = useSyncExternalStore(keys.subscribe, keys.get);
  useEffect(() => {
    if (!asked) void refreshVoiceKeys();
  }, []);
  return value;
}

/** The provider a conversation would use: the one picked if it has a key, else the first that does. */
export function activeProvider(s: VoiceModeSettings, withKeys: VoiceProvider[] | null): VoiceProvider | null {
  if (!withKeys?.length) return null;
  if (s.provider && withKeys.includes(s.provider)) return s.provider;
  return VOICE_PROVIDERS.find((p) => withKeys.includes(p.id))?.id ?? null;
}

// --- voices and models ------------------------------------------------------------------

const catalogs = new Map<VoiceProvider, Promise<VoiceCatalog>>();

export function forgetCatalog(p: VoiceProvider) {
  catalogs.delete(p);
}

/** A provider's models and voices, asked once a session. */
export function useVoiceCatalog(p: VoiceProvider | null, version = 0): VoiceCatalog | null {
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  useEffect(() => {
    setCatalog(null);
    if (!p) return;
    let live = true;
    let pending = catalogs.get(p);
    if (!pending) {
      pending = api.voiceCatalog(p);
      catalogs.set(p, pending);
      pending.catch(() => catalogs.delete(p));
    }
    pending.then((c) => live && setCatalog(c)).catch(() => live && setCatalog({ models: [], voices: [] }));
    return () => {
      live = false;
    };
  }, [p, version]);
  return catalog;
}

// --- the open conversation ----------------------------------------------------------------

/** The chat voice mode is open on, if any. One conversation at a time. */
const open = createStore<string | null>("sush.voice-mode.open", null, false, false);

export const useVoiceOpen = () => useSyncExternalStore(open.subscribe, open.get);
export const openVoice = (conversationId: string) => open.set(conversationId);
export const closeVoice = () => open.set(null);
