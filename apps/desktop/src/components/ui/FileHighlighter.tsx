"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  SparkleIcon as PhSparkle,
  FileIcon as PhFile,
  CaretDownIcon as PhCaretDown,
} from "@phosphor-icons/react";

const MESSAGE =
  "Found it: the refresh in src/auth/refresh.ts was firing twice under fast reconnects, which invalidated the new token before src/auth/session.ts had stored it. I deduped in-flight refreshes, added a regression test in src/auth/session.test.ts, and updated README.md with the retry behavior.";

interface FileMeta {
  status: "new" | "modified";
  snippet: string[];
}

const FILE_META: Record<string, FileMeta> = {
  "src/auth/refresh.ts": {
    status: "modified",
    snippet: ["let pending: Promise<Token> | null = null;", "", "export async function refresh(token: string) {", "  return (pending ??= doRefresh(token));", "}"],
  },
  "src/auth/session.ts": {
    status: "modified",
    snippet: ["const next = await refresh(token);", "// store only after the new token actually lands", "store.set(next);"],
  },
  "src/auth/session.test.ts": {
    status: "new",
    snippet: ["it('dedupes concurrent refreshes', async () => {", "  const [a, b] = await Promise.all([refresh(t), refresh(t)]);", "  expect(a).toBe(b);", "});"],
  },
  "README.md": {
    status: "modified",
    snippet: ["### Token refresh", "Retries once on a 401 and dedupes any refresh", "already in flight.", ""],
  },
};

const FILE_REGEX = /\b(?:[\w-]+\/)*[\w-]+(?:\.[A-Za-z0-9]{1,8})+\b/g;

interface TextSegment {
  type: "text";
  value: string;
}
interface FileSegment {
  type: "file";
  path: string;
}
type Segment = TextSegment | FileSegment;

function splitMessage(message: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of message.matchAll(FILE_REGEX)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) segments.push({ type: "text", value: message.slice(lastIndex, idx) });
    segments.push({ type: "file", path: match[0] });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < message.length) segments.push({ type: "text", value: message.slice(lastIndex) });
  return segments;
}

interface Badge {
  label: string;
  className: string;
}

const EXT_BADGES: Record<string, Badge> = {
  ts: { label: "TS", className: "bg-blue-500 text-white" },
  tsx: { label: "TSX", className: "bg-sky-500 text-white" },
  js: { label: "JS", className: "bg-yellow-400 text-yellow-950" },
  md: { label: "M↓", className: "bg-stone-400 text-white" },
  json: { label: "{}", className: "bg-amber-700 text-white" },
};

function badgeFor(path: string): Badge {
  const lower = path.toLowerCase();
  if (/\.(test|spec)\.[jt]sx?$/.test(lower)) return { label: "✓", className: "bg-emerald-500 text-white" };
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  return EXT_BADGES[ext] ?? { label: "•", className: "bg-stone-400 text-white" };
}

const STATUS_TONE: Record<FileMeta["status"], string> = {
  new: "text-emerald-700 dark:text-emerald-400",
  modified: "text-amber-700 dark:text-amber-400",
};

const KEYWORDS = new Set(["export", "async", "function", "return", "const", "let", "await", "new", "it", "expect"]);

function tokenizeLine(line: string): { text: string; className: string }[] {
  if (line.trim().startsWith("//") || line.trim().startsWith("###")) {
    return [{ text: line, className: "text-stone-500 dark:text-stone-500 italic" }];
  }
  const parts = line.split(/(\s+|[(){};]|"[^"]*"|'[^']*')/g).filter((p) => p.length > 0);
  return parts.map((p) => {
    if (/^["'].*["']$/.test(p)) return { text: p, className: "text-emerald-700 dark:text-emerald-400" };
    if (KEYWORDS.has(p)) return { text: p, className: "text-emerald-700 dark:text-emerald-400" };
    if (/^[(){};]$/.test(p)) return { text: p, className: "text-stone-400 dark:text-stone-600" };
    return { text: p, className: "text-stone-700 dark:text-stone-300" };
  });
}

function AssistantIcon() {
  return <PhSparkle size={13} weight="fill" aria-hidden />;
}

function FileIcon() {
  return <PhFile size={11} aria-hidden />;
}

function ChevronIcon() {
  return <PhCaretDown size={11} weight="bold" aria-hidden />;
}

export function FileHighlighter() {
  const shouldReduceMotion = useReducedMotion();
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const segments = useMemo(() => splitMessage(MESSAGE), []);
  const fileSegments = useMemo(() => segments.filter((s): s is FileSegment => s.type === "file"), [segments]);

  const toggleFile = (path: string) => {
    if (!FILE_META[path]) return;
    setExpandedPath((current) => (current === path ? null : path));
  };

  const expandedMeta = expandedPath ? FILE_META[expandedPath] : null;

  return (
    <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          <AssistantIcon />
        </span>
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">Assistant</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-500 dark:bg-white/[0.06] dark:text-stone-400">
          {fileSegments.length} files referenced
        </span>
      </div>

      <motion.p
        initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="text-sm leading-relaxed text-stone-600 dark:text-stone-300"
      >
        {segments.map((segment, i) => {
          if (segment.type === "text") return <span key={i}>{segment.value}</span>;

          const meta = FILE_META[segment.path];
          const badge = badgeFor(segment.path);
          const isExpanded = expandedPath === segment.path;
          const fileIndex = fileSegments.indexOf(segment);

          return (
            <motion.button
              key={i}
              type="button"
              onClick={() => toggleFile(segment.path)}
              disabled={!meta}
              aria-expanded={meta ? isExpanded : undefined}
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22, delay: 0.15 + Math.max(fileIndex, 0) * 0.08, ease: [0.16, 1, 0.3, 1] }}
              whileTap={meta && !shouldReduceMotion ? { scale: 0.97 } : undefined}
              className={`mx-0.5 inline-flex translate-y-[3px] items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
                isExpanded
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-stone-200 bg-stone-50 text-stone-600 hover:border-stone-300 hover:bg-stone-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300 dark:hover:bg-white/[0.08]"
              } ${!meta ? "cursor-default" : "cursor-pointer"}`}
            >
              <span aria-hidden className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-[2px] text-[6px] font-bold leading-none ${badge.className}`}>
                {badge.label}
              </span>
              {segment.path}
              {meta && (
                <motion.span animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="text-stone-500">
                  <ChevronIcon />
                </motion.span>
              )}
            </motion.button>
          );
        })}
      </motion.p>

      <AnimatePresence initial={false}>
        {expandedPath && expandedMeta && (
          <motion.div
            key={expandedPath}
            initial={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.32, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.22 } }}
            className="overflow-hidden"
          >
            <div className="mt-3 overflow-hidden rounded-lg border border-stone-200/70 dark:border-white/10">
              <div className="flex items-center gap-1.5 border-b border-stone-200/70 bg-stone-50 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.03]">
                <span className="text-stone-500">
                  <FileIcon />
                </span>
                <span className="truncate font-mono text-[11px] text-stone-500 dark:text-stone-400">{expandedPath}</span>
                <span className={`ml-auto shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] ${STATUS_TONE[expandedMeta.status]}`}>
                  {expandedMeta.status}
                </span>
              </div>
              <pre className="overflow-x-auto bg-white/60 px-3 py-2 text-[11.5px] leading-relaxed dark:bg-stone-900/60">
                <code>
                  {expandedMeta.snippet.map((line, i) => (
                    <div key={i}>
                      {line.length === 0 ? (
                        " "
                      ) : (
                        tokenizeLine(line).map((token, j) => (
                          <span key={j} className={token.className}>
                            {token.text}
                          </span>
                        ))
                      )}
                    </div>
                  ))}
                </code>
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
