// Dictation: which provider/model transcribes (Settings → Speech), and
// recording the microphone as 16 kHz mono WAV for it.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import type { ProviderView, TranscribeApi } from "@/lib/tauri";

export interface SpeechSettings {
  /** null: use a local Ollama provider if there is one. */
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

export interface SpeechTarget {
  provider: ProviderView;
  model: string;
  api: TranscribeApi;
}

/** The configured speech target, falling back to local Ollama when none is picked. */
export function resolveSpeechTarget(settings: SpeechSettings, providers: ProviderView[]): SpeechTarget | null {
  const picked = settings.providerId ? providers.find((p) => p.id === settings.providerId) : undefined;
  if (picked && canTranscribe(picked) && settings.model.trim()) {
    return { provider: picked, model: settings.model.trim(), api: settings.api };
  }
  const ollama = providers.find(isOllama);
  return ollama ? { provider: ollama, model: DEFAULT_OLLAMA_MODEL, api: "ollama-chat" } : null;
}

/** Longest clip sent in one request. Gemma's audio encoder takes short clips;
 *  transcription endpoints cap uploads at 25 MB (about 13 minutes here). */
export const chunkSeconds = (api: TranscribeApi) => (api === "ollama-chat" ? 30 : 600);

// --- recording -----------------------------------------------------------------------

export const SAMPLE_RATE = 16_000;

export interface Recording {
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
  return {
    stop() {
      close();
      const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
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
