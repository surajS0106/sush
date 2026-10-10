"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  FileIcon as PhFile,
  CopyIcon as PhCopy,
  CheckIcon as PhCheck,
  DownloadSimpleIcon as PhDownloadSimple,
  ArrowsOutIcon as PhArrowsOut,
  XIcon as PhX,
} from "@phosphor-icons/react";

export interface Version {
  label: string;
  note: string;
  code: string;
}

function FileIcon() {
  return <PhFile size={14} aria-hidden />;
}

function CopyIcon() {
  return <PhCopy size={14} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={14} weight="bold" aria-hidden />;
}

function DownloadIcon() {
  return <PhDownloadSimple size={14} aria-hidden />;
}

function ExpandIcon() {
  return <PhArrowsOut size={14} aria-hidden />;
}

function CloseIcon() {
  return <PhX size={16} aria-hidden />;
}

function ShimmerLines() {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-4" role="status" aria-label="Generating artifact">
      {[85, 60, 92, 40, 70].map((w, i) => (
        <div key={i} className="relative h-3 overflow-hidden rounded bg-stone-200 dark:bg-white/10" style={{ width: `${w}%` }}>
          <motion.span
            aria-hidden
            className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/25"
            animate={{ x: ["-100%", "200%"] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "linear", delay: i * 0.08 }}
          />
        </div>
      ))}
    </div>
  );
}

function CodeLines({ code }: { code: string }) {
  const shouldReduceMotion = useReducedMotion();
  const lines = code.split("\n");
  return (
    <div className="overflow-x-auto px-4 py-4">
      <table className="border-collapse font-mono text-[13px] leading-relaxed">
        <tbody>
          {lines.map((line, i) => (
            <motion.tr
              key={i}
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              // Stagger only the first screenful; later lines (and lines streamed in) appear at once.
              transition={{ duration: 0.22, delay: i < 24 ? i * 0.035 : 0, ease: [0.16, 1, 0.3, 1] }}
            >
              <td className="select-none pr-4 text-right text-stone-300 dark:text-stone-100/25">{i + 1}</td>
              <td className="whitespace-pre text-stone-800 dark:text-stone-200">{line || " "}</td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactBody({ generating, code, versionKey }: { generating: boolean; code: string; versionKey: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-stone-50 dark:bg-stone-950">
      <AnimatePresence mode="wait" initial={false}>
        {generating && !code ? (
          <motion.div key="shimmer" exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <ShimmerLines />
          </motion.div>
        ) : (
          // Keyed by version, not content, so streamed lines append instead of remounting the body.
          <motion.div key={versionKey} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
            <CodeLines code={code} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ArtifactHeader({
  title,
  titleId,
  version,
  copied,
  onCopy,
  onDownload,
  expandControl,
  onExpand,
  onClose,
  triggerRef,
  closeRef,
}: {
  title: string;
  titleId: string;
  version: Version;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
  expandControl: "expand" | "close";
  onExpand: () => void;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  closeRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-stone-200 bg-stone-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.02]">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-brand dark:bg-brand/15 dark:text-brand">
        <FileIcon />
      </span>
      <div className="min-w-0 flex-1">
        <h3 id={titleId} className="truncate font-mono text-sm font-medium text-stone-900 dark:text-stone-100">
          {title}
        </h3>
        <p className="text-[11px] text-stone-500">
          {version.label} · {version.note}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Code copied" : "Copy code"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-brand"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download file"
          title="Download file"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-brand"
        >
          <DownloadIcon />
        </button>
        {expandControl === "expand" ? (
          <button
            ref={triggerRef}
            type="button"
            onClick={onExpand}
            aria-label="Expand artifact"
            title="Expand"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-brand"
          >
            <ExpandIcon />
          </button>
        ) : (
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close artifact"
            title="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-brand"
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function ArtifactVersionRow({
  versions,
  versionIndex,
  onSelect,
}: {
  versions: Version[];
  versionIndex: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 border-t border-stone-200 bg-stone-50 px-4 py-2.5 dark:border-white/10 dark:bg-white/[0.02]">
      <span className="mr-1 text-[11px] font-medium text-stone-500">Versions</span>
      {versions.map((v, i) => (
        <button
          key={v.label}
          type="button"
          onClick={() => onSelect(i)}
          aria-current={i === versionIndex}
          aria-label={`View ${v.label}, ${v.note}`}
          className={`h-2.5 w-2.5 rounded-full transition-[color,background-color,border-color,transform,opacity] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand ${
            i === versionIndex ? "scale-125 bg-brand" : "bg-stone-300 hover:bg-stone-400 dark:bg-white/15 dark:hover:bg-white/30"
          }`}
        />
      ))}
    </div>
  );
}

export function Artifact({
  title,
  versions,
  initialVersionIndex,
  generating = false,
  onDownload,
  className = "w-full max-w-md",
}: {
  title: string;
  versions: Version[];
  /** Defaults to the last (newest) version. */
  initialVersionIndex?: number;
  /** The newest version is still being written: a shimmer until its first line arrives. */
  generating?: boolean;
  /** Replaces the default browser download, e.g. with a native save dialog. */
  onDownload?: (version: Version) => void;
  className?: string;
}) {
  const [versionIndex, setVersionIndex] = useState(initialVersionIndex ?? versions.length - 1);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const version = versions[Math.min(versionIndex, versions.length - 1)];
  const showGenerating = generating && version === versions.at(-1);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const closeModal = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(version.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable ; no-op
    }
  };

  const handleDownload = () => {
    if (onDownload) return onDownload(version);
    const blob = new Blob([version.code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = title;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={className}>
      <AnimatePresence mode="popLayout">
        {!open ? (
          <motion.div
            key="card"
            layoutId={`${titleId}-shell`}
            className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_25px_60px_-25px_rgba(0,0,0,0.15)] dark:border-white/10 dark:bg-stone-900 dark:shadow-[0_25px_60px_-25px_rgba(0,0,0,0.6)]"
          >
            <ArtifactHeader
              title={title}
              titleId={titleId}
              version={version}
              copied={copied}
              onCopy={handleCopy}
              onDownload={handleDownload}
              expandControl="expand"
              onExpand={() => setOpen(true)}
              onClose={closeModal}
              triggerRef={triggerRef}
              closeRef={closeRef}
            />
            <div className="max-h-96 overflow-y-auto">
              <ArtifactBody generating={showGenerating} code={version.code} versionKey={version.label} />
            </div>
            <ArtifactVersionRow versions={versions} versionIndex={versionIndex} onSelect={setVersionIndex} />
          </motion.div>
        ) : (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={closeModal}
              aria-hidden
              className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-sm"
            />
            <motion.div
              key="modal"
              layoutId={`${titleId}-shell`}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="fixed inset-4 z-50 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_12px_32px_-8px_rgba(0,0,0,0.14)] dark:shadow-none dark:border-white/10 dark:bg-stone-900 md:inset-10"
            >
              <ArtifactHeader
                title={title}
                titleId={titleId}
                version={version}
                copied={copied}
                onCopy={handleCopy}
                onDownload={handleDownload}
                expandControl="close"
                onExpand={() => setOpen(true)}
                onClose={closeModal}
                triggerRef={triggerRef}
                closeRef={closeRef}
              />
              <div data-lenis-prevent className="h-[calc(100%-6.5rem)] overflow-y-auto overscroll-contain">
                <ArtifactBody generating={showGenerating} code={version.code} versionKey={version.label} />
              </div>
              <ArtifactVersionRow versions={versions} versionIndex={versionIndex} onSelect={setVersionIndex} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}