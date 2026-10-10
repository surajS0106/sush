"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CopyIcon as PhCopy, CheckIcon as PhCheck } from "@phosphor-icons/react";

interface CodeFile {
  name: string;
  lang: string;
  code: string;
}

const KEYWORDS = new Set([
  "import", "export", "async", "function", "const", "let", "return", "if", "from", "type", "new", "await", "of",
]);

const TOKEN_REGEX = /("(?:[^"\\]|\\.)*")|(\/\/.*$)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([^\sA-Za-z0-9_$]+)/g;

function tokenizeLine(line: string) {
  const tokens: { text: string; cls: string }[] = [];
  let m: RegExpExecArray | null;
  TOKEN_REGEX.lastIndex = 0;
  while ((m = TOKEN_REGEX.exec(line))) {
    const [, str, comment, word, space, punct] = m;
    if (str) tokens.push({ text: str, cls: "text-amber-700 dark:text-amber-300" });
    else if (comment) tokens.push({ text: comment, cls: "text-stone-500 italic dark:text-stone-500" });
    else if (word) tokens.push({ text: word, cls: KEYWORDS.has(word) ? "text-emerald-700 dark:text-emerald-400" : "text-stone-800 dark:text-stone-100" });
    else if (space) tokens.push({ text: space, cls: "" });
    else if (punct) tokens.push({ text: punct, cls: "text-stone-500 dark:text-stone-500" });
  }
  return tokens;
}

function CopyIcon() {
  return <PhCopy size={13} aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={13} weight="bold" aria-hidden />;
}

export function CodeBlock({ files, defaultTab = 0 }: { files: CodeFile[]; defaultTab?: number }) {
  const [activeTab, setActiveTab] = useState(defaultTab);
  const [copied, setCopied] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const file = files[activeTab];
  const lines = file.code.split("\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(file.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable ; no-op
    }
  };

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_25px_60px_-25px_rgba(0,0,0,0.15)] dark:border-white/10 dark:bg-stone-900 dark:shadow-[0_25px_60px_-25px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 pl-1 pr-2 dark:border-white/10 dark:bg-white/[0.02]">
        <div role="tablist" aria-label="Files" className="flex items-center gap-0.5 overflow-x-auto py-1.5 pl-1 scrollbar-hide">
          {files.map((f, i) => (
            <button
              key={f.name}
              type="button"
              role="tab"
              aria-selected={activeTab === i}
              onClick={() => setActiveTab(i)}
              className={`shrink-0 rounded-md px-2.5 py-1 font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
                activeTab === i
                  ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/25 dark:text-emerald-300"
                  : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
              }`}
            >
              {f.name}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          <span className="hidden text-[11px] text-stone-500 sm:inline">{file.lang}</span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Code copied" : "Copy code"}
            title={copied ? "Code copied" : "Copy code"}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:hover:bg-white/10 dark:hover:text-stone-200 dark:focus-visible:outline-emerald-400"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeTab}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="overflow-x-auto px-4 py-4"
        >
          <table className="border-collapse font-mono text-[13px] leading-relaxed">
            <tbody>
              {lines.map((line, i) => (
                <motion.tr
                  key={i}
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.02, ease: [0.16, 1, 0.3, 1] }}
                >
                  <td className="select-none pr-4 text-right text-stone-300 dark:text-stone-100/25">{i + 1}</td>
                  <td className="whitespace-pre">
                    {line.length === 0
                      ? " "
                      : tokenizeLine(line).map((t, ti) => (
                          <span key={ti} className={t.cls}>
                            {t.text}
                          </span>
                        ))}
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}