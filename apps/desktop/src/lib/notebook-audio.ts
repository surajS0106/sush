// Audio files as notebook sources. The webview decodes the file (MP3, M4A,
// WAV, OGG… whatever it plays), resamples it to 16 kHz mono, and transcribes
// it a minute at a time with the speech engine from Settings → Speech: the
// built-in Whisper model or a provider. Each minute's text starts with its
// timestamp, so passages cite where they are. The transcript is added as an
// "audio" source; the audio itself isn't kept.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { openSettings } from "@/lib/library";
import { getSpeechSettings, resolveSpeechTarget, SAMPLE_RATE, wavBase64, type SpeechTarget } from "@/lib/speech";
import { createStore } from "@/lib/store";
import { api, errorMessage } from "@/lib/tauri";

export interface AudioJob {
  id: string;
  notebookId: string;
  name: string;
  /** 0 to 1. */
  progress: number;
  stage: "decoding" | "transcribing";
}

const jobs = createStore<AudioJob[]>("sush.notebook-audio-jobs", [], false);
export const useAudioJobs = (notebookId: string) =>
  useSyncExternalStore(jobs.subscribe, jobs.get).filter((j) => j.notebookId === notebookId);

const setJob = (id: string, patch: Partial<AudioJob>) => jobs.set((all) => all.map((j) => (j.id === id ? { ...j, ...patch } : j)));

/** Audio files the picker offers. */
export const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.wav,.ogg,.oga,.opus,.flac,.aac,.webm";
const AUDIO_FILE = /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac|webm)$/i;
export const isAudioFile = (f: File) => f.type.startsWith("audio/") || AUDIO_FILE.test(f.name);

/** Seconds per request: short enough that each minute gets its timestamp. Gemma takes 30 s clips. */
const pieceSeconds = (t: SpeechTarget) => (t.kind === "provider" && t.api === "ollama-chat" ? 30 : 60);

function stamp(seconds: number) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Decode any audio the webview plays into 16 kHz mono samples. */
async function decode(file: File): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const probe = new AudioContext();
  try {
    const audio = await probe.decodeAudioData(bytes);
    const frames = Math.ceil(audio.duration * SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, Math.max(frames, 1), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } finally {
    void probe.close();
  }
}

/** Transcribe audio files and add each as a source, in the background. */
export async function addAudioFiles(notebookId: string, files: File[]) {
  const providers = await api.listProviders().catch(() => []);
  const target = resolveSpeechTarget(getSpeechSettings(), providers);
  if (!target) {
    toast.error("Choose a speech model first", {
      description: "Audio is transcribed with the model picked in Settings → Speech.",
      action: { label: "Open Settings", onClick: () => openSettings({ section: "speech" }) },
    });
    return;
  }
  if (target.kind === "builtin" && !(await api.whisperModelStatus()).downloaded) {
    toast.error("The built-in speech model isn’t downloaded", {
      description: "Download it in Settings → Speech, or pick a provider there.",
      action: { label: "Open Settings", onClick: () => openSettings({ section: "speech" }) },
    });
    return;
  }
  for (const file of files) void transcribeOne(notebookId, file, target);
}

async function transcribeOne(notebookId: string, file: File, target: SpeechTarget) {
  const id = crypto.randomUUID();
  const name = file.name.replace(/\.[^.]+$/, "");
  jobs.set((all) => [...all, { id, notebookId, name, progress: 0, stage: "decoding" }]);
  try {
    const samples = await decode(file);
    const size = pieceSeconds(target) * SAMPLE_RATE;
    const parts: string[] = [];
    setJob(id, { stage: "transcribing" });
    for (let at = 0; at < samples.length; at += size) {
      const wav = wavBase64(samples.subarray(at, at + size));
      const text = (target.kind === "builtin" ? await api.transcribeLocal(wav) : await api.transcribe(target.provider.id, target.model, target.api, wav)).trim();
      if (text) parts.push(`[${stamp(at / SAMPLE_RATE)}] ${text}`);
      setJob(id, { progress: Math.min(1, (at + size) / samples.length) });
    }
    if (parts.length === 0) throw new Error("No speech was heard in it.");
    await api.notebookAddText(notebookId, name, parts.join("\n\n"), "audio");
  } catch (e) {
    toast.error(`Couldn’t transcribe ${file.name}`, { description: errorMessage(e) });
  } finally {
    jobs.set((all) => all.filter((j) => j.id !== id));
  }
}
