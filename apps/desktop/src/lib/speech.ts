// Dictation: which provider/model transcribes (Settings → Speech), and
// recording the microphone as 16 kHz mono WAV for it.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import type { ProviderView, TranscribeApi } from "@/lib/tauri";

/** The built-in Whisper model, which isn't a configured provider. */
export const BUILTIN = "builtin";

export interface SpeechSettings {
  /** null or BUILTIN: the built-in Whisper model. Otherwise a provider id. */
  providerId: string | null;
  model: string;
  api: TranscribeApi;
}

export const DEFAULT_OLLAMA_MODEL = "gemma4:e4b";

const speech = createStore<SpeechSettings>("sush.speech", {
  providerId: null,
  model: DEFAULT_OLLAMA_MODEL,
  api: "ollama-chat",
});

export const useSpeechSettings = () => useSyncExternalStore(speech.subscribe, speech.get);
export const setSpeechSettings = (patch: Partial<SpeechSettings>) => speech.set((s) => ({ ...s, ...patch }));

export const isOllama = (p: ProviderView) => /:11434(\/|$)/.test(p.baseUrl);
/** Claude can't take audio input, so Anthropic-format providers can't transcribe. */
export const canTranscribe = (p: ProviderView) => p.format === "openai-chat";

/** The API a provider most likely speaks for audio. */
export const defaultApi = (p: ProviderView): TranscribeApi => (isOllama(p) ? "ollama-chat" : "transcriptions");

export type SpeechTarget =
  | { kind: "builtin" }
  | { kind: "provider"; provider: ProviderView; model: string; api: TranscribeApi };

/** The configured speech target; the built-in model unless a provider is picked. */
export function resolveSpeechTarget(settings: SpeechSettings, providers: ProviderView[]): SpeechTarget | null {
  if (!settings.providerId || settings.providerId === BUILTIN) return { kind: "builtin" };
  // An explicit choice never silently falls back to something else.
  const picked = providers.find((p) => p.id === settings.providerId);
  return picked && canTranscribe(picked) && settings.model.trim()
    ? { kind: "provider", provider: picked, model: settings.model.trim(), api: settings.api }
    : null;
}

/** Longest clip sent in one request. Gemma's audio encoder takes short clips;
 *  transcription endpoints cap uploads at 25 MB (about 13 minutes here). */
export const chunkSeconds = (t: SpeechTarget) => (t.kind === "provider" && t.api === "ollama-chat" ? 30 : 600);

/** Whether to transcribe while recording. Live dictation re-sends the open
 *  segment every second or so, so it's only on for models that run locally
 *  and cost nothing per request. */
export const isLive = (t: SpeechTarget) => t.kind === "builtin" || isOllama(t.provider);

// --- recording -----------------------------------------------------------------------

export const SAMPLE_RATE = 16_000;

export interface Recording {
  /** The samples recorded so far from index `from` on, without stopping. */
  peek(from?: number): Float32Array;
  /** Stop and return the samples recorded so far. */
  stop(): Float32Array;
  /** Stop and discard. */
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  // The context resamples the mic to 16 kHz, which is what speech models expect.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but needs no worklet module, which the CSP would block as a blob.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(ctx.destination);

  const close = () => {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  const peek = (from = 0) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(Math.max(0, total - from));
    let start = 0;
    for (const c of chunks) {
      const end = start + c.length;
      if (end > from) out.set(c.subarray(Math.max(0, from - start)), Math.max(0, start - from));
      start = end;
    }
    return out;
  };
  return {
    peek,
    stop() {
      close();
      return peek();
    },
    cancel: close,
  };
}

/** 16-bit PCM WAV, base64-encoded for the transcribe command. */
export function wavBase64(samples: Float32Array, sampleRate = SAMPLE_RATE): string {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
