"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ImageIcon as PhImage,
  FileIcon as PhFile,
  CheckIcon as PhCheck,
  XIcon as PhX,
  ArrowClockwiseIcon as PhArrowClockwise,
  PlusIcon as PhPlus,
} from "@phosphor-icons/react";

type Status = "uploading" | "done" | "error";

interface Attachment {
  id: string;
  name: string;
  size: number;
  status: Status;
  progress: number;
  speed: number;
  failAt?: number;
}

let nextId = 1;

const RADIUS = 9;
const CIRC = 2 * Math.PI * RADIUS;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function ImageIcon() {
  return <PhImage size={14} aria-hidden />;
}

function DocumentIcon() {
  return <PhFile size={14} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={10} weight="bold" aria-hidden />;
}

function XIcon() {
  return <PhX size={13} aria-hidden />;
}

// A bare exclamation mark, deliberately with no outer triangle/circle of its own
// since it's always shown inside this file's own colored circular status badge.
function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function RetryIcon() {
  return <PhArrowClockwise size={13} aria-hidden />;
}

function PlusIcon() {
  return <PhPlus size={14} aria-hidden />;
}

function FileTone({ name }: { name: string }) {
  const image = isImage(name);
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
        image ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/12 text-amber-700 dark:text-amber-400"
      }`}
    >
      {image ? <ImageIcon /> : <DocumentIcon />}
    </span>
  );
}

function ProgressRing({ progress, status }: { progress: number; status: Status }) {
  const offset = CIRC * (1 - progress / 100);
  const color = status === "error" ? "#dc2626" : "#16a34a";
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" className="absolute inset-0 -rotate-90" aria-hidden>
      <circle cx="12" cy="12" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="text-black/5 dark:text-stone-100/10" />
      <motion.circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={CIRC}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 0.15, ease: "linear" }}
      />
    </svg>
  );
}

export function Attachments({ initialFiles = [] }: { initialFiles?: { name: string; size: number }[] }) {
  const [attachments, setAttachments] = useState<Attachment[]>(() =>
    initialFiles.map((f) => ({ id: `i${nextId++}`, name: f.name, size: f.size, status: "uploading", progress: 0, speed: 3.5 }))
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setAttachments((prev) =>
        prev.map((a) => {
          if (a.status !== "uploading") return a;
          const next = a.progress + a.speed;
          if (a.failAt !== undefined && next >= a.failAt) {
            return { ...a, progress: a.failAt, status: "error" };
          }
          if (next >= 100) {
            return { ...a, progress: 100, status: "done" };
          }
          return { ...a, progress: next };
        })
      );
    }, 80);
    return () => clearInterval(id);
  }, []);

  const remove = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const retry = (id: string) =>
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "uploading", progress: 0, failAt: undefined } : a)));

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const added: Attachment[] = Array.from(files).map((f) => ({
      id: `f${nextId++}`,
      name: f.name,
      size: f.size,
      status: "uploading",
      progress: 0,
      speed: 3.5,
    }));
    setAttachments((prev) => [...prev, ...added]);
  };

  return (
    <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">
        Attachments · {attachments.length}
      </p>
      <ul className="flex flex-col gap-1.5" role="list">
        <AnimatePresence initial={false}>
          {attachments.map((a) => (
            <motion.li
              key={a.id}
              layout
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-3 rounded-xl border border-transparent bg-black/[0.02] px-2.5 py-2 dark:bg-white/[0.03]"
            >
              <div className="relative h-8 w-8 shrink-0">
                <FileTone name={a.name} />
                {a.status === "uploading" && <ProgressRing progress={a.progress} status={a.status} />}
                {a.status === "done" && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-700 text-white ring-2 ring-white dark:ring-stone-950">
                    <CheckIcon />
                  </span>
                )}
                {a.status === "error" && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-white ring-2 ring-white dark:ring-stone-950">
                    <AlertIcon />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{a.name}</p>
                <p className={`text-xs ${a.status === "error" ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-500"}`}>
                  {a.status === "uploading" ? `${Math.round(a.progress)}% · ${formatBytes(a.size)}` : a.status === "error" ? "Upload failed" : formatBytes(a.size)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {a.status === "error" && (
                  <button
                    type="button"
                    onClick={() => retry(a.id)}
                    aria-label={`Retry uploading ${a.name}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
                  >
                    <RetryIcon />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
                >
                  <XIcon />
                </button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-stone-300 py-2 text-xs font-medium text-stone-500 transition-colors hover:border-emerald-400 hover:text-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-stone-700 dark:text-stone-400 dark:hover:border-emerald-500/60 dark:hover:text-emerald-400"
      >
        <PlusIcon />
        Add file
      </button>
    </div>
  );
}