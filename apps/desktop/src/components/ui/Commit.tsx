"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  RobotIcon as PhRobot,
  GitBranchIcon as PhGitBranch,
  CopyIcon as PhCopy,
  CheckIcon as PhCheck,
  CaretDownIcon as PhCaretDown,
  ArrowClockwiseIcon as PhArrowClockwise,
  ArrowSquareOutIcon as PhArrowSquareOut,
} from "@phosphor-icons/react";

interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  url?: string;
}

function pseudoHash(input: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 7);
}

function AgentIcon() {
  return <PhRobot size={13} weight="fill" aria-hidden />;
}

function BranchIcon() {
  return <PhGitBranch size={11} aria-hidden />;
}

function CopyIcon() {
  return <PhCopy size={12} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={12} weight="bold" aria-hidden />;
}

function ChevronIcon() {
  return <PhCaretDown size={14} weight="bold" aria-hidden />;
}

function ReplayIcon() {
  return <PhArrowClockwise size={14} aria-hidden />;
}

function ExternalLinkIcon() {
  return <PhArrowSquareOut size={11} aria-hidden className="shrink-0 opacity-0 transition-opacity group-hover/file:opacity-100" />;
}

function StatsBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions || 1;
  const addPct = (additions / total) * 100;
  return (
    <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700" aria-hidden>
      <span className="h-full bg-green-500" style={{ width: `${addPct}%` }} />
    </span>
  );
}

export function Commit({
  subject,
  body,
  files,
  branch = "main",
  autoPlay = true,
  repoUrl,
}: {
  subject: string;
  body?: string;
  files: ChangedFile[];
  branch?: string;
  autoPlay?: boolean;
  /** Base repo URL (e.g. "https://github.com/org/repo") used to derive a file's GitHub link when it has no explicit url. */
  repoUrl?: string;
}) {
  const [playId, setPlayId] = useState(0);
  return (
    <CommitRun
      key={playId}
      subject={subject}
      body={body}
      files={files}
      branch={branch}
      autoPlay={autoPlay}
      repoUrl={repoUrl}
      onReplay={() => setPlayId((id) => id + 1)}
    />
  );
}

function CommitRun({
  subject,
  body,
  files,
  branch,
  autoPlay,
  repoUrl,
  onReplay,
}: {
  subject: string;
  body?: string;
  files: ChangedFile[];
  branch: string;
  autoPlay: boolean;
  repoUrl?: string;
  onReplay: () => void;
}) {
  const fullText = useMemo(() => (body ? `${subject}\n\n${body}` : subject), [subject, body]);
  const words = useMemo(() => fullText.split(" "), [fullText]);
  const [revealed, setRevealed] = useState(autoPlay ? 0 : words.length);
  const [committed, setCommitted] = useState(!autoPlay);
  const [filesOpen, setFilesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const filesId = "commit-files-panel";

  const delays = useMemo(() => words.map((w, i) => 30 + ((w.length * 7 + i * 3) % 40)), [words]);
  const hash = useMemo(() => pseudoHash(fullText), [fullText]);
  const totals = useMemo(
    () => files.reduce((acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }), { additions: 0, deletions: 0 }),
    [files]
  );

  useEffect(() => {
    if (!autoPlay) return;
    let cancelled = false;

    if (shouldReduceMotion) {
      const t = setTimeout(() => {
        if (cancelled) return;
        setRevealed(words.length);
        setCommitted(true);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }

    let i = 0;
    const step = () => {
      if (cancelled) return;
      i += 1;
      setRevealed(i);
      if (i >= words.length) {
        setTimeout(() => !cancelled && setCommitted(true), 400);
        return;
      }
      timeout = setTimeout(step, delays[i] ?? 40);
    };
    let timeout = setTimeout(step, delays[0] ?? 40);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, words.length, delays, shouldReduceMotion]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable ; no-op
    }
  };

  const visibleText = words.slice(0, revealed).join(" ");
  const [visibleSubject, ...visibleBodyParts] = visibleText.split("\n\n");
  const visibleBody = visibleBodyParts.join("\n\n");

  return (
    <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-green-500 dark:text-green-400">
          <AgentIcon />
        </span>
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">Assistant</span>
        {repoUrl ? (
          <a
            href={`${repoUrl}/tree/${branch}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`View ${branch} branch on GitHub`}
            className="inline-flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:text-stone-400 dark:hover:border-white/20 dark:hover:text-stone-200"
          >
            <BranchIcon />
            {branch}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-500 dark:border-white/10 dark:text-stone-400">
            <BranchIcon />
            {branch}
          </span>
        )}
        <span className="ml-auto text-xs text-stone-500 dark:text-stone-500">Just now</span>
      </div>

      <div className="min-h-[4.5rem]">
        <p className="text-sm font-semibold text-stone-800 dark:text-stone-100">
          {visibleSubject}
          {!committed && <span className="text-stone-300 dark:text-stone-600">|</span>}
        </p>
        {visibleBody && <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">{visibleBody}</p>}
      </div>

      <AnimatePresence>
        {committed && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="mt-3 flex items-center gap-2 border-t border-stone-100 pt-3 dark:border-white/5">
              {repoUrl ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-black/[0.04] py-1 pl-2 pr-1 dark:bg-white/[0.06]">
                  <a
                    href={`${repoUrl}/commit/${hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`View commit ${hash} on GitHub`}
                    className="font-mono text-xs text-stone-600 underline-offset-2 transition-colors hover:text-stone-800 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-300 dark:hover:text-stone-100"
                  >
                    {hash}
                  </a>
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={copied ? "Commit hash copied" : "Copy commit hash"}
                    title={copied ? "Commit hash copied" : "Copy commit hash"}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-stone-500 transition-colors hover:bg-black/[0.06] hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={copied ? "Commit hash copied" : "Copy commit hash"}
                  title={copied ? "Commit hash copied" : "Copy commit hash"}
                  className="inline-flex items-center gap-1.5 rounded-md bg-black/[0.04] px-2 py-1 font-mono text-xs text-stone-600 transition-colors hover:bg-black/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:bg-white/[0.06] dark:text-stone-300 dark:hover:bg-white/10"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {hash}
                </button>
              )}
              <span className="text-xs text-stone-500 dark:text-stone-500">
                <span className="font-medium text-green-600 dark:text-green-400">+{totals.additions}</span>{" "}
                <span className="font-medium">−{totals.deletions}</span>
              </span>
              <StatsBar additions={totals.additions} deletions={totals.deletions} />
              {autoPlay && (
                <button
                  type="button"
                  onClick={onReplay}
                  aria-label="Replay commit"
                  className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:bg-white/10 dark:hover:text-stone-300"
                >
                  <ReplayIcon />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setFilesOpen((v) => !v)}
              aria-expanded={filesOpen}
              aria-controls={filesId}
              className="mt-2 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-medium text-stone-500 transition-colors hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-400 dark:hover:text-stone-200"
            >
              <motion.span animate={{ rotate: filesOpen ? 90 : 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
                <ChevronIcon />
              </motion.span>
              {files.length} files changed
            </button>

            <AnimatePresence initial={false}>
              {filesOpen && (
                <motion.div
                  id={filesId}
                  initial={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={shouldReduceMotion ? { duration: 0.15 } : { height: { duration: 0.4, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } }}
                  className="overflow-hidden"
                >
                  <motion.ul
                    initial={shouldReduceMotion ? undefined : { y: -8 }}
                    animate={{ y: 0 }}
                    transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.35, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
                    className="mt-1 flex flex-col gap-1 pl-1"
                    role="list"
                  >
                    {files.map((f, i) => {
                      const url = f.url ?? (repoUrl ? `${repoUrl}/blob/${hash}/${f.path}` : undefined);
                      return (
                        <motion.li
                          key={f.path}
                          initial={shouldReduceMotion ? undefined : { opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.28, delay: 0.1 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                          className="flex items-center gap-2 text-xs"
                        >
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open ${f.path} on GitHub`}
                              className="group/file inline-flex min-w-0 items-center gap-1 truncate rounded font-mono text-stone-500 underline-offset-2 hover:text-stone-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-400 dark:hover:text-stone-200"
                            >
                              <span className="truncate">{f.path}</span>
                              <ExternalLinkIcon />
                            </a>
                          ) : (
                            <span className="truncate font-mono text-stone-500 dark:text-stone-400">{f.path}</span>
                          )}
                          <span className="ml-auto shrink-0 text-stone-500 dark:text-stone-500">
                            <span className="text-green-600 dark:text-green-400">+{f.additions}</span> −{f.deletions}
                          </span>
                          <StatsBar additions={f.additions} deletions={f.deletions} />
                        </motion.li>
                      );
                    })}
                  </motion.ul>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}