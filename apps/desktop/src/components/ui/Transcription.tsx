"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  MicrophoneIcon as PhMicrophone,
  CheckIcon as PhCheck,
  StopIcon as PhStop,
  ArrowClockwiseIcon as PhArrowClockwise,
  CaretDownIcon as PhCaretDown,
} from "@phosphor-icons/react";

const WORD_MS = 70;
const FINALIZE_PAUSE = 350;
const CHUNK_GAP = 200;

interface ScheduleStep {
  delay: number;
  chunkIndex: number;
  wordCount: number;
  finalized: boolean;
}

function buildSchedule(chunks: string[]): ScheduleStep[] {
  const steps: ScheduleStep[] = [];
  let t = 0;
  chunks.forEach((chunk, ci) => {
    const words = chunk.split(" ");
    words.forEach((_, wi) => {
      t += WORD_MS;
      steps.push({ delay: t, chunkIndex: ci, wordCount: wi + 1, finalized: false });
    });
    t += FINALIZE_PAUSE;
    steps.push({ delay: t, chunkIndex: ci, wordCount: words.length, finalized: true });
    t += CHUNK_GAP;
  });
  return steps;
}

// The Web Speech API has no official TS lib entry, so this is the minimal
// shape this component actually reads/writes from SpeechRecognition.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function MicIcon() {
  return <PhMicrophone size={13} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={13} weight="bold" aria-hidden />;
}

function StopIcon() {
  return <PhStop size={11} weight="fill" aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function ChevronDownIcon() {
  return <PhCaretDown size={12} weight="bold" aria-hidden />;
}

const WAVEFORM_BARS = [
  { peak: 10, duration: 0.8, delay: 0 },
  { peak: 15, duration: 0.7, delay: 0.08 },
  { peak: 18, duration: 0.85, delay: 0.16 },
  { peak: 13, duration: 0.75, delay: 0.24 },
];

function formatElapsed(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

type Phase = "demo" | "listening" | "done";

interface Language {
  id: string;
  label: string;
}

export function Transcription({
  chunks,
  languages,
  autoPlay = true,
}: {
  chunks: string[];
  languages: Language[];
  autoPlay?: boolean;
}) {
  const schedule = useMemo(() => buildSchedule(chunks), [chunks]);
  const [phase, setPhase] = useState<Phase>(autoPlay ? "demo" : "done");
  const [source, setSource] = useState<"script" | "live">("script");
  const [stepIndex, setStepIndex] = useState(autoPlay ? -1 : schedule.length - 1);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [languageId, setLanguageId] = useState(languages[0]?.id ?? "");
  const [languageOpen, setLanguageOpen] = useState(false);

  const startRef = useRef(0);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const micErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const languageRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();

  const language = languages.find((l) => l.id === languageId) ?? languages[0];

  const clearTimeouts = () => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  };

  const playDemo = () => {
    clearTimeouts();
    setStepIndex(-1);
    startRef.current = performance.now();
    setElapsedMs(0);
    setSource("script");
    setPhase("demo");

    if (shouldReduceMotion) {
      timeoutsRef.current.push(
        setTimeout(() => {
          setStepIndex(schedule.length - 1);
          setPhase("done");
        }, 0)
      );
      return;
    }

    schedule.forEach((s, i) => {
      timeoutsRef.current.push(setTimeout(() => setStepIndex(i), s.delay));
    });
    const finishDelay = (schedule[schedule.length - 1]?.delay ?? 0) + 250;
    timeoutsRef.current.push(setTimeout(() => setPhase("done"), finishDelay));
  };

  useEffect(() => {
    if (!autoPlay) return;
    playDemo();
    return () => clearTimeouts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase === "done") return;
    let raf: number;
    const tick = () => {
      setElapsedMs(performance.now() - startRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    return () => {
      clearTimeouts();
      if (micErrorTimeoutRef.current) clearTimeout(micErrorTimeoutRef.current);
      const recognition = recognitionRef.current;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!languageOpen) return;
    const onClick = (e: MouseEvent) => {
      if (languageRef.current && !languageRef.current.contains(e.target as Node)) setLanguageOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLanguageOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [languageOpen]);

  const showMicError = (message: string) => {
    setMicError(message);
    if (micErrorTimeoutRef.current) clearTimeout(micErrorTimeoutRef.current);
    micErrorTimeoutRef.current = setTimeout(() => setMicError(null), 3200);
  };

  const startRecording = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      showMicError("This browser doesn't support live transcription. Try Chrome, Edge, or Safari.");
      return;
    }

    setMicError(null);
    setLanguageOpen(false);
    clearTimeouts();

    const recognition = new Ctor();
    recognition.lang = language?.id ?? "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    // Accumulated outside React state so results aren't lost to stale
    // closures across the many onresult events a single session fires.
    let finalSoFar = "";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalSoFar += `${transcript} `;
        } else {
          interim += transcript;
        }
      }
      setFinalText(finalSoFar);
      setInterimText(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        showMicError("Microphone access was denied.");
      } else if (event.error === "audio-capture") {
        showMicError("Couldn't access the microphone.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        showMicError("Transcription stopped unexpectedly.");
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setSource("live");
      setPhase("done");
    };

    recognitionRef.current = recognition;
    setFinalText("");
    setInterimText("");
    startRef.current = performance.now();
    setElapsedMs(0);
    setPhase("listening");

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      showMicError("Couldn't start the microphone.");
      setPhase("done");
    }
  };

  const stopRecording = () => {
    recognitionRef.current?.stop();
  };

  const toggleRecording = () => {
    if (phase === "listening") {
      stopRecording();
      return;
    }
    startRecording();
  };

  const listening = phase === "listening";
  const finished = phase === "done";
  const snapshot = stepIndex >= 0 ? schedule[stepIndex] : null;
  const statusLabel = finished ? "Transcribed" : "Listening";
  const liveTranscript = `${finalText}${interimText}`.trim();

  return (
    <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggleRecording}
          aria-pressed={listening}
          aria-label={listening ? "Stop recording" : "Record audio to transcribe"}
          className={`relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
            listening
              ? "border-emerald-700/30 bg-emerald-700 text-white"
              : "border-stone-900/10 bg-black/[0.02] text-stone-600 hover:border-stone-900/20 hover:bg-black/5 hover:text-stone-800 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:border-white/20 dark:hover:bg-white/10 dark:hover:text-stone-100"
          }`}
        >
          {listening && (
            <motion.span
              aria-hidden
              className="absolute inset-[-3px] rounded-full border border-amber-400/60"
              animate={shouldReduceMotion ? undefined : { scale: [1, 1.3], opacity: [0.6, 0] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          {listening ? <StopIcon /> : <MicIcon />}
          {listening ? "Stop" : "Record"}
        </button>

        <div ref={languageRef} className="relative">
          <button
            type="button"
            onClick={() => setLanguageOpen((v) => !v)}
            disabled={listening}
            aria-haspopup="listbox"
            aria-expanded={languageOpen}
            className="inline-flex items-center gap-1.5 rounded-full border border-stone-900/10 bg-black/[0.02] px-2.5 py-1 text-xs font-medium text-stone-600 transition-colors hover:border-stone-900/20 hover:bg-black/5 hover:text-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:border-white/20 dark:hover:bg-emerald-500/15 dark:hover:text-stone-100"
          >
            {language?.label}
            <motion.span animate={{ rotate: languageOpen ? 180 : 0 }} transition={{ duration: 0.15 }} className="text-stone-500">
              <ChevronDownIcon />
            </motion.span>
          </button>
          <AnimatePresence>
            {languageOpen && (
              <motion.div
                role="listbox"
                aria-label="Transcription language"
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
                transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                style={{ transformOrigin: "top right" }}
                data-lenis-prevent
                className="scrollbar-thin absolute right-0 top-full z-20 mt-2 max-h-32 w-40 overflow-y-auto overscroll-contain rounded-xl border border-stone-200 bg-white p-1 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-800 dark:bg-stone-900"
              >
                {languages.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    role="option"
                    aria-selected={l.id === languageId}
                    onClick={() => {
                      setLanguageId(l.id);
                      setLanguageOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-stone-700 transition-colors hover:bg-emerald-500/10 dark:text-stone-200 dark:hover:bg-emerald-500/15/60"
                  >
                    {l.label}
                    {l.id === languageId && (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {micError && (
          <motion.p
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="mb-2 text-xs font-medium text-red-600 dark:text-red-400"
          >
            {micError}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="mb-3 flex items-center gap-2">
        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          {!finished && !shouldReduceMotion && (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-full border border-emerald-400/40"
              animate={{ scale: [1, 1.5], opacity: [0.6, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          {finished ? <CheckIcon /> : <MicIcon />}
        </span>
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">{statusLabel}</span>
        {listening && (
          <span className="flex h-3 items-end gap-0.5">
            {WAVEFORM_BARS.map((bar, i) => (
              <motion.span
                key={i}
                className="w-0.5 rounded-full bg-amber-500 dark:bg-amber-400"
                style={{ height: 3 }}
                animate={shouldReduceMotion ? undefined : { height: [3, bar.peak, 3] }}
                transition={{ duration: bar.duration, repeat: Infinity, ease: "easeInOut", delay: bar.delay }}
              />
            ))}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-stone-500 dark:text-stone-500">{formatElapsed(elapsedMs)}</span>
        {finished && source === "script" && autoPlay && (
          <button
            type="button"
            onClick={playDemo}
            aria-label="Replay transcription"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
          >
            <ReplayIcon />
          </button>
        )}
      </div>

      <p className="min-h-[1.25rem] text-sm leading-relaxed">
        {phase === "listening" ? (
          <>
            <span className="text-stone-800 dark:text-stone-100">{finalText}</span>
            <span className="italic text-stone-500 dark:text-stone-400">{interimText}</span>
            {!finalText && !interimText && (
              <span className="italic text-stone-500 dark:text-stone-500">Listening for speech…</span>
            )}
          </>
        ) : source === "live" ? (
          liveTranscript ? (
            <span className="text-stone-800 dark:text-stone-100">{liveTranscript}</span>
          ) : (
            !micError && (
              <span className="italic text-stone-500 dark:text-stone-500">No speech detected. Press Record and try again.</span>
            )
          )
        ) : (
          chunks.map((chunk, ci) => {
            if (!snapshot || ci > snapshot.chunkIndex) return null;
            const isCurrent = ci === snapshot.chunkIndex;
            const isFinal = !isCurrent || snapshot.finalized;
            const words = chunk.split(" ");
            const visible = isCurrent ? words.slice(0, snapshot.wordCount).join(" ") : chunk;
            return (
              <motion.span
                key={ci}
                animate={{ opacity: isFinal ? 1 : 0.55 }}
                transition={{ duration: 0.25 }}
                className={`${isFinal ? "text-stone-800 dark:text-stone-100" : "italic text-stone-500 dark:text-stone-400"} `}
              >
                {visible + " "}
              </motion.span>
            );
          })
        )}
      </p>
    </div>
  );
}