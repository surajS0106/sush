"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  PlayIcon as PhPlay,
  PauseIcon as PhPause,
  SparkleIcon as PhSparkle,
  SpeakerHighIcon as PhSpeakerHigh,
  SpeakerXIcon as PhSpeakerX,
  UploadSimpleIcon as PhUploadSimple,
  TrashIcon as PhTrash,
} from "@phosphor-icons/react";

const BAR_COUNT = 48;
const SPEEDS = [1, 1.5, 2, 0.5];

function PlayIcon() {
  return <PhPlay size={16} weight="fill" aria-hidden />;
}

function PauseIcon() {
  return <PhPause size={16} weight="fill" aria-hidden />;
}

function SpeakerIcon() {
  return <PhSparkle size={12} weight="fill" aria-hidden />;
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return muted ? <PhSpeakerX size={14} aria-hidden /> : <PhSpeakerHigh size={14} aria-hidden />;
}

function UploadIcon() {
  return <PhUploadSimple size={13} aria-hidden />;
}

function TrashIcon() {
  return <PhTrash size={13} aria-hidden />;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function BarRow({ heights, color, playing, reduceMotion }: { heights: number[]; color: string; playing: boolean; reduceMotion: boolean | null }) {
  return (
    // w-full is load-bearing: this div is itself a flex item inside the seek
    // track's flex row, so without an explicit width it shrink-wraps to its
    // bars' min-width instead of stretching to fill the track.
    <div className="flex h-full w-full items-center gap-0.5">
      {heights.map((h, i) => (
        <motion.span
          key={i}
          className={`min-w-[2px] flex-1 rounded-full ${color}`}
          style={{ height: `${(h * 100).toFixed(2)}%` }}
          animate={playing && !reduceMotion ? { scaleY: [1, 1.1 + h * 0.2, 1] } : { scaleY: 1 }}
          transition={
            playing && !reduceMotion
              ? { duration: 0.7 + (i % 6) * 0.08, repeat: Infinity, ease: "easeInOut", delay: (i % 12) * 0.05 }
              : { duration: 0.2 }
          }
        />
      ))}
    </div>
  );
}

function VolumeControl({ volume, muted, toggleMute, onVolumeChange }: { volume: number; muted: boolean; toggleMute: () => void; onVolumeChange: (v: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const effective = muted ? 0 : volume;

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onVolumeChange(Math.round(frac * 100) / 100);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setFromClientX(e.clientX);
  };
  const onPointerUp = () => setDragging(false);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onVolumeChange(Math.max(0, Math.round((effective - 0.1) * 100) / 100));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onVolumeChange(Math.min(1, Math.round((effective + 0.1) * 100) / 100));
    }
  };

  return (
    <div className="ml-auto flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
        aria-pressed={muted}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-500 dark:hover:text-stone-300"
      >
        <VolumeIcon muted={muted || volume === 0} />
      </button>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(effective * 100)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="group relative flex h-4 w-12 cursor-pointer items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
      >
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-white/10">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${effective * 100}%` }} />
        </div>
        <div
          aria-hidden
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-600 ring-2 ring-white transition-opacity duration-150 dark:ring-stone-950 ${
            dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          style={{ left: `${effective * 100}%` }}
        />
      </div>
    </div>
  );
}

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <button
      type="button"
      onClick={onUpload}
      className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 py-7 text-stone-500 transition-colors hover:border-emerald-400 hover:text-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/15 dark:text-stone-500 dark:hover:border-emerald-500/50 dark:hover:text-emerald-400"
    >
      <UploadIcon />
      <span className="text-xs font-medium">Upload an audio file</span>
    </button>
  );
}

// title/src: pass your own audio file as the initial track. durationSeconds is
// only the pre-load estimate shown before the file's real metadata arrives.
// The player also lets the visitor swap in their own file or clear it entirely
// (the upload/trash icons next to the volume control); src only seeds the
// initial state, it isn't a controlled prop after that.
export function AudioPlayer({ title, src, durationSeconds = 0 }: { title: string; src: string; durationSeconds?: number }) {
  const [currentSrc, setCurrentSrc] = useState<string | null>(src);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);
  const [speed, setSpeed] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Only the object URL created from a user-uploaded file needs revoking,
  // never the initial `src` prop, so it's tracked separately from currentSrc.
  const uploadedUrlRef = useRef<string | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const barHeights = useRef(
    Array.from({ length: BAR_COUNT }, (_, i) => {
      const base = Math.sin(i * 0.5) * 0.5 + 0.5;
      const detail = Math.sin(i * 1.7) * 0.3;
      const h = Math.max(0.18, Math.min(1, base * 0.7 + detail + 0.3));
      return Math.round(h * 10000) / 10000;
    })
  ).current;

  const applyProgress = (time: number, dur: number) => {
    const frac = dur > 0 ? Math.min(1, Math.max(0, time / dur)) : 0;
    if (fillRef.current) fillRef.current.style.clipPath = `inset(0 ${(1 - frac) * 100}% 0 0)`;
    if (trackRef.current) {
      trackRef.current.setAttribute("aria-valuenow", String(Math.round(time)));
      trackRef.current.setAttribute("aria-valuetext", `${formatTime(time)} of ${formatTime(dur)}`);
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    if (!playing || !currentSrc) return;
    let raf: number;
    let lastWhole = Math.floor(audioRef.current?.currentTime ?? 0);
    const tick = () => {
      const audio = audioRef.current;
      if (!audio) return;
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      applyProgress(audio.currentTime, dur);
      const whole = Math.floor(audio.currentTime);
      if (whole !== lastWhole) {
        lastWhole = whole;
        setCurrentTime(audio.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, currentSrc]);

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
  };

  const handleEnded = () => {
    const audio = audioRef.current;
    const time = audio?.duration ?? duration;
    setPlaying(false);
    setCurrentTime(time);
    applyProgress(time, duration);
  };

  const handleSeek = (time: number) => {
    const clamped = Math.min(duration, Math.max(0, time));
    const audio = audioRef.current;
    if (audio) audio.currentTime = clamped;
    applyProgress(clamped, duration);
    setCurrentTime(clamped);
  };

  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    handleSeek(frac * duration);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      setCurrentTime(audio.currentTime);
      return;
    }
    if (audio.currentTime >= duration - 0.05) audio.currentTime = 0;
    audio.play().catch(() => {});
    setPlaying(true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    seekFromClientX(e.clientX);
  };
  const onPointerUp = () => setDragging(false);

  const toggleMute = () => setMuted((m) => !m);
  const handleVolumeChange = (v: number) => {
    setVolume(v);
    if (v > 0 && muted) setMuted(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = audioRef.current?.currentTime ?? currentTime;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      handleSeek(at - 5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      handleSeek(at + 5);
    } else if (e.key === "Home") {
      e.preventDefault();
      handleSeek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      handleSeek(duration);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      togglePlay();
    }
  };

  const resetPlayback = () => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(durationSeconds);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (uploadedUrlRef.current) URL.revokeObjectURL(uploadedUrlRef.current);
    // Local-only preview: this creates a blob URL that only exists in this
    // browser tab. A real app would typically upload `file` to its backend
    // here and use the returned hosted URL instead (or alongside this one),
    // and would still need to revoke the local object URL to avoid leaking it.
    const url = URL.createObjectURL(file);
    uploadedUrlRef.current = url;
    resetPlayback();
    setCurrentSrc(url);
  };

  const deleteAudio = () => {
    audioRef.current?.pause();
    if (uploadedUrlRef.current) {
      URL.revokeObjectURL(uploadedUrlRef.current);
      uploadedUrlRef.current = null;
    }
    resetPlayback();
    setCurrentSrc(null);
  };

  useEffect(() => {
    return () => {
      if (uploadedUrlRef.current) URL.revokeObjectURL(uploadedUrlRef.current);
    };
  }, []);

  return (
    <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" />
      {currentSrc && (
        <audio ref={audioRef} src={currentSrc} preload="metadata" onLoadedMetadata={handleLoadedMetadata} onEnded={handleEnded} className="hidden" />
      )}
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          <SpeakerIcon />
        </span>
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">{title}</span>
        {currentSrc ? (
          <>
            <VolumeControl volume={volume} muted={muted} toggleMute={toggleMute} onVolumeChange={handleVolumeChange} />
            <button
              type="button"
              onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
              className="rounded-full border border-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:text-stone-400 dark:hover:border-white/20 dark:hover:text-stone-200"
            >
              {speed}x
            </button>
            <button
              type="button"
              onClick={openFilePicker}
              aria-label="Change audio file"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-500 dark:hover:text-stone-300"
            >
              <UploadIcon />
            </button>
            <button
              type="button"
              onClick={deleteAudio}
              aria-label="Delete audio file"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-500 dark:hover:text-red-400"
            >
              <TrashIcon />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={openFilePicker}
            className="ml-auto rounded-full border border-stone-200 px-2.5 py-1 text-[11px] font-medium text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:text-stone-400 dark:hover:border-white/20 dark:hover:text-stone-200"
          >
            Upload
          </button>
        )}
      </div>

      {!currentSrc ? (
        <EmptyState onUpload={openFilePicker} />
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white transition-colors hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={playing ? "pause" : "play"}
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.15 }}
                className="flex items-center justify-center"
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </motion.span>
            </AnimatePresence>
          </button>

          <div className="min-w-0 flex-1">
            <div
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              className="relative flex h-9 cursor-pointer items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
            >
              <BarRow heights={barHeights} color="bg-stone-200 dark:bg-stone-700" playing={playing} reduceMotion={shouldReduceMotion} />
              <div ref={fillRef} className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 ${(1 - currentTime / duration) * 100}% 0 0)` }}>
                <BarRow heights={barHeights} color="bg-emerald-500" playing={playing} reduceMotion={shouldReduceMotion} />
              </div>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-stone-500 dark:text-stone-500">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}