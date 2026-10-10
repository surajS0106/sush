import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { openSettings } from "@/lib/library";
import {
  chunkSeconds,
  resolveSpeechTarget,
  SAMPLE_RATE,
  startRecording,
  useSpeechSettings,
  wavBase64,
  type Recording,
} from "@/lib/speech";
import { api, errorMessage, type ProviderView } from "@/lib/tauri";

export type DictationStatus = "idle" | "recording" | "transcribing";

/** Shorter than this is a stray key press, not speech. */
const MIN_SECONDS = 0.3;

/** Append `text` after `value` with a single separating space. */
function append(value: string, text: string) {
  if (!text) return value;
  if (!value || /\s$/.test(value)) return value + text;
  return `${value} ${text}`;
}

/**
 * Record-then-transcribe dictation into a text field, using the provider and
 * model from Settings → Speech. Toggle once to record, again to transcribe;
 * the transcript is appended to whatever is in the field by then.
 */
export function useDictation(value: string, setValue: (v: string) => void, providers: ProviderView[]) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const settings = useSpeechSettings();
  const recording = useRef<Recording | null>(null);
  const starting = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const start = useCallback(async () => {
    if (recording.current || starting.current) return;
    if (!resolveSpeechTarget(settings, providers)) {
      toast.error("Pick a speech model to dictate.", {
        action: { label: "Open settings", onClick: () => openSettings({ section: "speech" }) },
      });
      return;
    }
    starting.current = true;
    try {
      recording.current = await startRecording();
      setStatus("recording");
    } catch (e) {
      toast.error(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access is blocked. Allow it in Settings › Privacy & security › Microphone."
          : errorMessage(e),
      );
    } finally {
      starting.current = false;
    }
  }, [settings, providers]);

  const cancel = useCallback(() => {
    recording.current?.cancel();
    recording.current = null;
    setStatus((s) => (s === "recording" ? "idle" : s));
  }, []);

  const stop = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    const samples = rec.stop();
    const target = resolveSpeechTarget(settings, providers);
    if (!target || samples.length < MIN_SECONDS * SAMPLE_RATE) {
      setStatus("idle");
      return;
    }
    setStatus("transcribing");
    try {
      const size = chunkSeconds(target.api) * SAMPLE_RATE;
      for (let i = 0; i < samples.length; i += size) {
        const text = await api.transcribe(
          target.provider.id,
          target.model,
          target.api,
          wavBase64(samples.subarray(i, i + size)),
        );
        // Update the ref too: the next chunk may land before React re-renders.
        valueRef.current = append(valueRef.current, text);
        setValue(valueRef.current);
      }
    } catch (e) {
      toast.error(`Dictation failed: ${errorMessage(e)}`);
    } finally {
      setStatus("idle");
    }
  }, [settings, providers, setValue]);

  const toggle = useCallback(() => {
    if (recording.current) void stop();
    else if (status === "idle") void start();
  }, [start, stop, status]);

  // Don't leave the microphone open when the composer goes away.
  useEffect(() => () => recording.current?.cancel(), []);

  return { status, toggle, stop, cancel };
}
