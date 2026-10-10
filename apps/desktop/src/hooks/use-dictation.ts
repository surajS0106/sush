import { Channel } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  chunkSeconds,
  isLive,
  resolveSpeechTarget,
  SAMPLE_RATE,
  startRecording,
  useSpeechSettings,
  wavBase64,
  type Recording,
  type SpeechTarget,
} from "@/lib/speech";
import { api, errorMessage, type ProviderView } from "@/lib/tauri";

export type DictationStatus = "idle" | "recording" | "downloading" | "transcribing";

/** Why dictation stopped short. `audio` is what's still untranscribed, kept so
 *  the user can switch model and retry without speaking again. */
export interface DictationFailure {
  message: string;
  audio: Float32Array | null;
}

/** Shorter than this is a stray key press, not speech. */
const MIN_SECONDS = 0.3;
/** How often live dictation re-transcribes the open segment. A pass still in
 *  flight is never overlapped, so slow models just update less often. */
const LIVE_INTERVAL_MS = 800;
/** Live segments are closed at about this length, under Whisper's 30 s window
 *  and Gemma's 30 s clip limit, and never re-sent after that. */
const LIVE_SEGMENT_SECONDS = 20;
/** Close a segment at the quietest point in this much audio before its end, so words aren't cut in half. */
const CUT_SEARCH_SECONDS = 3;

const send = (t: SpeechTarget, wav: string) =>
  t.kind === "builtin" ? api.transcribeLocal(wav) : api.transcribe(t.provider.id, t.model, t.api, wav);

/** Append `text` after `value` with a single separating space. */
function append(value: string, text: string) {
  if (!text) return value;
  if (!value || /\s$/.test(value)) return value + text;
  return `${value} ${text}`;
}

/** Index of the quietest 100 ms in the `CUT_SEARCH_SECONDS` before `end`. */
function quietCut(samples: Float32Array, end: number) {
  const frame = SAMPLE_RATE / 10;
  let best = end;
  let bestEnergy = Infinity;
  for (let at = Math.max(frame, end - CUT_SEARCH_SECONDS * SAMPLE_RATE); at + frame <= end; at += frame / 2) {
    let energy = 0;
    for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = at + frame / 2;
    }
  }
  return best;
}

/** Text being transcribed into the field. */
interface Transcript {
  target: SpeechTarget;
  /** The field's text when dictation started; the transcript goes after it. */
  base: string;
  /** Transcript so far (for a live session, of its closed segments). */
  text: string;
  done: boolean;
}

/** One press-to-press recording. */
interface Session extends Transcript {
  rec: Recording;
  /** Sample index where the open (still re-transcribed) segment starts. */
  from: number;
  /** The live pass in flight, if any. */
  pass: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * Dictation into a text field, using the provider and model from Settings →
 * Speech. Toggle once to record, again to finish. Local models transcribe
 * live, writing into the field as you speak; others transcribe on stop. The
 * transcript is appended to whatever was in the field when recording started.
 */
export function useDictation(value: string, setValue: (v: string) => void, providers: ProviderView[]) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [failure, setFailure] = useState<DictationFailure | null>(null);
  /** Built-in model download progress, 0 to 1. */
  const [progress, setProgress] = useState(0);
  const settings = useSpeechSettings();
  const session = useRef<Session | null>(null);
  const starting = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  /** Write the transcript so far, plus the open segment's draft, into the field. */
  const show = useCallback(
    (s: Transcript, draft = "") => {
      // Update the ref too: the next update may land before React re-renders.
      valueRef.current = append(append(s.base, s.text), draft);
      setValue(valueRef.current);
    },
    [setValue],
  );

  /** Fetch the built-in model on first use. */
  const ensureModel = useCallback(async (target: SpeechTarget) => {
    if (target.kind !== "builtin" || (await api.whisperModelStatus()).downloaded) return;
    setStatus("downloading");
    setProgress(0);
    const channel = new Channel<{ received: number; total: number }>();
    channel.onmessage = ({ received, total }) => setProgress(received / total);
    await api.whisperModelDownload(channel);
  }, []);

  /** Re-transcribe the open segment, closing it once it's long enough. */
  const livePass = useCallback(
    async (s: Session) => {
      const seg = s.rec.peek(s.from);
      if (seg.length < MIN_SECONDS * SAMPLE_RATE) return;
      const close = seg.length >= LIVE_SEGMENT_SECONDS * SAMPLE_RATE;
      const end = close ? quietCut(seg, seg.length) : seg.length;
      const text = await send(s.target, wavBase64(seg.subarray(0, end)));
      if (s.done) return;
      if (close) {
        s.text = append(s.text, text);
        s.from += end;
        show(s);
      } else {
        show(s, text);
      }
    },
    [show],
  );

  /** Stop the live loop and wait out any pass in flight. Its result still counts. */
  const settle = async (s: Session) => {
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    await s.pass?.catch(() => {});
  };

  const start = useCallback(async () => {
    if (session.current || starting.current) return;
    const target = resolveSpeechTarget(settings, providers);
    if (!target) {
      setFailure({ message: "No speech model is set up yet. Choose one to start dictating.", audio: null });
      return;
    }
    starting.current = true;
    try {
      if (isLive(target)) await ensureModel(target);
    } catch (e) {
      setFailure({ message: errorMessage(e), audio: null });
      setStatus("idle");
      starting.current = false;
      return;
    }
    try {
      const s: Session = {
        rec: await startRecording(),
        target,
        base: valueRef.current,
        text: "",
        from: 0,
        pass: null,
        timer: null,
        done: false,
      };
      session.current = s;
      setStatus("recording");
      if (isLive(target)) {
        s.timer = setInterval(() => {
          if (s.pass || s.done) return;
          s.pass = livePass(s).finally(() => (s.pass = null));
          // A failed pass is retried on the next tick; a lasting failure surfaces when recording stops.
          s.pass.catch(() => {});
        }, LIVE_INTERVAL_MS);
      }
    } catch (e) {
      setStatus("idle");
      // A microphone problem, not a model one, so switching models wouldn't help.
      toast.error(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access is blocked. Allow it in Settings › Privacy & security › Microphone."
          : errorMessage(e),
      );
    } finally {
      starting.current = false;
    }
  }, [settings, providers, ensureModel, livePass]);

  /** Discard the recording. With `restore`, also put the field back the way it was. */
  const cancel = useCallback(
    (restore = true) => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      s.done = true;
      if (s.timer) clearInterval(s.timer);
      s.rec.cancel();
      if (restore) {
        valueRef.current = s.base;
        setValue(s.base);
      }
      setStatus((st) => (st === "recording" ? "idle" : st));
    },
    [setValue],
  );

  /** Transcribe `samples` in model-sized chunks, appending to the session's transcript. */
  const transcribe = useCallback(
    async (s: Transcript, samples: Float32Array) => {
      const size = chunkSeconds(s.target) * SAMPLE_RATE;
      let i = 0;
      try {
        await ensureModel(s.target);
        setStatus("transcribing");
        for (; i < samples.length; i += size) {
          s.text = append(s.text, await send(s.target, wavBase64(samples.subarray(i, i + size))));
          show(s);
        }
      } catch (e) {
        show(s);
        setFailure({ message: errorMessage(e), audio: samples.subarray(i) });
      } finally {
        s.done = true;
        setStatus("idle");
      }
    },
    [ensureModel, show],
  );

  const stop = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    const samples = s.rec.stop();
    await settle(s);
    const rest = samples.subarray(s.from);
    if (rest.length < MIN_SECONDS * SAMPLE_RATE) {
      s.done = true;
      show(s);
      setStatus("idle");
      return;
    }
    await transcribe(s, rest);
  }, [show, transcribe]);

  const toggle = useCallback(() => {
    if (session.current) void stop();
    else if (status === "idle") void start();
  }, [start, stop, status]);

  /** Retry with the current speech settings: re-send the kept audio, or start recording if there was none. */
  const retry = useCallback(() => {
    const audio = failure?.audio;
    setFailure(null);
    const target = resolveSpeechTarget(settings, providers);
    if (!audio) void start();
    else if (!target) setFailure({ message: "No speech model is set up yet. Choose one to transcribe your recording.", audio });
    else void transcribe({ target, base: valueRef.current, text: "", done: false }, audio);
  }, [failure, settings, providers, transcribe, start]);

  const dismiss = useCallback(() => setFailure(null), []);

  // Don't leave the microphone open when the composer goes away.
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.done = true;
      if (s.timer) clearInterval(s.timer);
      s.rec.cancel();
    },
    [],
  );

  return { status, progress, toggle, stop, cancel, failure, retry, dismiss };
}
