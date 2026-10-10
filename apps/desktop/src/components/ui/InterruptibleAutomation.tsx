"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ImageSquareIcon as PhImage,
  FileTextIcon as PhFileText,
  VideoCameraIcon as PhVideo,
  CheckIcon as PhCheck,
  PauseIcon as PhPause,
  StopIcon as PhStop,
  ArrowCounterClockwiseIcon as PhReset,
  FolderIcon as PhFolder,
  PlayIcon as PhPlay,
} from "@phosphor-icons/react";

type Destination = "Documents" | "Images" | "Archive" | "Trash";
type FileStatus = "pending" | "processing" | "paused" | "done" | "skipped" | "stopped";
type Kind = "image" | "video" | "doc";

interface FileItem {
  id: number;
  name: string;
  kind: Kind;
  sizeLabel: string;
  suggested: Destination;
  checkpoint: boolean;
  reason?: string;
}

const DESTINATIONS: Destination[] = ["Documents", "Images", "Archive", "Trash"];

const SOURCE_FILES: FileItem[] = [
  { id: 1, name: "vacation-photo-014.jpg", kind: "image", sizeLabel: "3.2 MB", suggested: "Images", checkpoint: false },
  { id: 2, name: "team-offsite.mp4", kind: "video", sizeLabel: "128 MB", suggested: "Archive", checkpoint: false },
  {
    id: 3,
    name: "invoice_q3_2026.pdf",
    kind: "doc",
    sizeLabel: "210 KB",
    suggested: "Documents",
    checkpoint: true,
    reason: "Filename looks financial, could belong in Archive instead.",
  },
  { id: 4, name: "notes.txt", kind: "doc", sizeLabel: "4 KB", suggested: "Documents", checkpoint: false },
  {
    id: 5,
    name: "contract_draft_final_v2.pdf",
    kind: "doc",
    sizeLabel: "340 KB",
    suggested: "Archive",
    checkpoint: true,
    reason: "\"final_v2\" suggests it might still be active, not ready to archive.",
  },
  { id: 6, name: "screenshot_2026.png", kind: "image", sizeLabel: "1.1 MB", suggested: "Images", checkpoint: false },
];

const PROCESS_MS = 650;

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "image") return <PhImage size={15} aria-hidden />;
  if (kind === "video") return <PhVideo size={15} aria-hidden />;
  return <PhFileText size={15} aria-hidden />;
}
function CheckIcon() {
  return <PhCheck size={11} aria-hidden />;
}
function PauseIcon() {
  return <PhPause size={12} aria-hidden />;
}
function StopIcon() {
  return <PhStop size={13} aria-hidden />;
}
function ResetIcon() {
  return <PhReset size={13} aria-hidden />;
}
function FolderIcon() {
  return <PhFolder size={12} aria-hidden />;
}
function PlayIcon() {
  return <PhPlay size={13} weight="fill" aria-hidden />;
}

interface RunFile extends FileItem {
  status: FileStatus;
  destination: Destination;
}

function initialRun(): RunFile[] {
  return SOURCE_FILES.map((f) => ({ ...f, status: "pending", destination: f.suggested }));
}

function AutomationRun({ onReset }: { onReset: () => void }) {
  const [files, setFiles] = useState<RunFile[]>(initialRun);
  const [cursor, setCursor] = useState(0);
  const [pendingDestination, setPendingDestination] = useState<Destination | null>(null);
  const [halted, setHalted] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const current = files[cursor];
  const isPaused = current?.status === "paused";
  const finished = cursor >= files.length;

  useEffect(() => {
    if (halted || finished || isPaused) return;
    const raf = requestAnimationFrame(() => {
      setFiles((prev) => prev.map((f, i) => (i === cursor ? { ...f, status: "processing" } : f)));
    });
    timeoutRef.current = setTimeout(() => {
      const item = files[cursor];
      setFiles((prev) =>
        prev.map((f, i) => {
          if (i !== cursor) return f;
          return f.checkpoint ? { ...f, status: "paused" } : { ...f, status: "done" };
        })
      );
      if (!item?.checkpoint) {
        setCursor((c) => c + 1);
      } else {
        setPendingDestination(item.suggested);
      }
    }, shouldReduceMotion ? 60 : PROCESS_MS);
    return () => {
      cancelAnimationFrame(raf);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, halted, finished, isPaused, shouldReduceMotion]);

  const approve = () => {
    if (!current || pendingDestination === null) return;
    setFiles((prev) => prev.map((f, i) => (i === cursor ? { ...f, status: "done", destination: pendingDestination } : f)));
    setPendingDestination(null);
    setCursor((c) => c + 1);
  };

  const skip = () => {
    setFiles((prev) => prev.map((f, i) => (i === cursor ? { ...f, status: "skipped" } : f)));
    setPendingDestination(null);
    setCursor((c) => c + 1);
  };

  const stopAll = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setPendingDestination(null);
    setHalted(true);
    setFiles((prev) => prev.map((f, i) => (i >= cursor && f.status !== "done" && f.status !== "skipped" ? { ...f, status: "stopped" } : f)));
  };

  const doneCount = files.filter((f) => f.status === "done").length;
  const skippedCount = files.filter((f) => f.status === "skipped").length;
  const stoppedCount = files.filter((f) => f.status === "stopped").length;
  const allSettled = finished || halted;

  return (
    <div className="relative w-full max-w-md">
      <div className="relative rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Organizing 6 files</h3>
          <div className="flex items-center gap-1">
            {!allSettled && (
              <motion.button
                type="button"
                onClick={stopAll}
                aria-label="Stop automation"
                whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
              >
                <StopIcon />
              </motion.button>
            )}
            <motion.button
              type="button"
              onClick={onReset}
              aria-label="Restart demo"
              whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
            >
              <ResetIcon />
            </motion.button>
          </div>
        </div>

        <p className="mt-1 text-xs text-stone-500 dark:text-stone-500">
          {halted
            ? `Stopped. ${doneCount} moved, ${skippedCount} skipped, ${stoppedCount} left untouched.`
            : finished
              ? `Done. ${doneCount} moved, ${skippedCount} skipped.`
              : isPaused
                ? `Paused on file ${cursor + 1} of ${files.length}, waiting for you.`
                : `Working on file ${cursor + 1} of ${files.length}.`}
        </p>

        <div className="mt-3 flex items-center gap-1.5">
          {files.map((f) => (
            <span
              key={f.id}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-150 ${
                f.status === "done"
                  ? "bg-emerald-500"
                  : f.status === "skipped"
                    ? "bg-stone-300 dark:bg-stone-600"
                    : f.status === "stopped"
                      ? "bg-stone-200 dark:bg-stone-800"
                      : f.status === "paused"
                        ? "bg-amber-500"
                        : f.status === "processing"
                          ? "bg-emerald-400/60"
                          : "bg-stone-100 dark:bg-white/5"
              }`}
            />
          ))}
        </div>

        <div className="mt-4 space-y-1.5">
          {files.map((f, i) => (
            <FileRow key={f.id} file={f} isCurrent={i === cursor && !allSettled} shouldReduceMotion={shouldReduceMotion} />
          ))}
        </div>

        <AnimatePresence>
          {isPaused && current && pendingDestination !== null && (
            <motion.div
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50/80 p-3.5 dark:border-amber-500/30 dark:bg-amber-500/10"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                <motion.span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  animate={shouldReduceMotion ? { opacity: 0.8 } : { opacity: [0.4, 1, 0.4] }}
                  transition={shouldReduceMotion ? { duration: 0.2 } : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                />
                Checkpoint, needs your call
              </div>
              <p className="mt-1.5 text-sm text-stone-700 dark:text-stone-200">
                About to move <span className="font-medium">{current.name}</span> to {pendingDestination}.
              </p>
              {current.reason && <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{current.reason}</p>}

              <div className="relative mt-2.5 inline-flex flex-wrap gap-1 rounded-lg bg-white/70 p-1 dark:bg-black/20">
                {DESTINATIONS.map((dest) => {
                  const active = pendingDestination === dest;
                  return (
                    <button
                      key={dest}
                      type="button"
                      onClick={() => setPendingDestination(dest)}
                      className={`relative rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        active ? "text-white" : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="interruptible-automation-dest-pill"
                          className="absolute inset-0 rounded-md bg-emerald-600"
                          transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 32 }}
                        />
                      )}
                      <span className="relative inline-flex items-center gap-1">
                        <FolderIcon />
                        {dest}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <motion.button
                  type="button"
                  onClick={approve}
                  whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
                >
                  <CheckIcon />
                  Approve &amp; continue
                </motion.button>
                <motion.button
                  type="button"
                  onClick={skip}
                  whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
                >
                  Leave it where it is
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <span className="sr-only" role="status" aria-live="polite">
          {isPaused
            ? `Paused. About to move ${current?.name} to ${pendingDestination}, waiting for approval.`
            : allSettled
              ? `Automation finished. ${doneCount} moved, ${skippedCount} skipped, ${stoppedCount} untouched.`
              : `Processing file ${cursor + 1} of ${files.length}.`}
        </span>
      </div>
    </div>
  );
}

function FileRow({ file, isCurrent, shouldReduceMotion }: { file: RunFile; isCurrent: boolean; shouldReduceMotion: boolean | null }) {
  return (
    <motion.div
      layout={!shouldReduceMotion}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${isCurrent ? "bg-stone-50 dark:bg-white/5" : ""}`}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
          file.status === "done"
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
            : file.status === "skipped" || file.status === "stopped"
              ? "bg-stone-100 text-stone-400 dark:bg-white/5 dark:text-stone-600"
              : file.status === "paused"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : file.status === "processing"
                  ? "bg-emerald-500/10 text-emerald-700"
                  : "bg-stone-100 text-stone-400 dark:bg-white/5 dark:text-stone-600"
        }`}
      >
        {file.status === "done" ? (
          <CheckIcon />
        ) : file.status === "paused" ? (
          <PauseIcon />
        ) : file.status === "processing" ? (
          <motion.span
            animate={shouldReduceMotion ? { rotate: 0 } : { rotate: 360 }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.9, repeat: Infinity, ease: "linear" }}
          >
            <KindIcon kind={file.kind} />
          </motion.span>
        ) : (
          <KindIcon kind={file.kind} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-xs font-medium ${file.status === "stopped" ? "text-stone-400 dark:text-stone-600" : "text-stone-700 dark:text-stone-200"}`}>
          {file.name}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-stone-300 dark:text-stone-600">{file.sizeLabel}</span>
      <span
        className={`shrink-0 text-[11px] font-medium ${
          file.status === "done"
            ? "text-emerald-700 dark:text-emerald-400"
            : file.status === "skipped"
              ? "text-stone-500 dark:text-stone-500"
              : file.status === "stopped"
                ? "text-stone-300 dark:text-stone-600"
                : file.status === "paused"
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-stone-300 dark:text-stone-600"
        }`}
      >
        {file.status === "done"
          ? `to ${file.destination}`
          : file.status === "skipped"
            ? "left alone"
            : file.status === "stopped"
              ? "untouched"
              : file.status === "paused"
                ? "paused"
                : file.status === "processing"
                  ? "sorting..."
                  : "queued"}
      </span>
    </motion.div>
  );
}

interface InterruptibleAutomationProps {
  className?: string;
}

export function InterruptibleAutomation({ className }: InterruptibleAutomationProps) {
  const [started, setStarted] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className={className}>
      {!started ? (
        <div className="flex min-h-[280px] w-full items-center justify-center rounded-2xl border border-dashed border-stone-200/70 dark:border-white/10">
          <motion.button
            type="button"
            onClick={() => setStarted(true)}
            whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
          >
            <PlayIcon />
            Run auto-organizer
          </motion.button>
        </div>
      ) : (
        <AutomationRun key={runKey} onReset={() => setRunKey((k) => k + 1)} />
      )}
      <p className="mt-3 text-center text-xs text-stone-500 dark:text-stone-500">
        It runs itself, but pauses on the two files it is unsure about, and lets you change where they go before it commits.
      </p>
    </div>
  );
}