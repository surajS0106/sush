"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  XIcon as PhX,
  CaretLeftIcon as PhCaretLeft,
  CaretRightIcon as PhCaretRight,
  CheckIcon as PhCheck,
  ArrowUUpLeftIcon as PhUndo,
  PencilSimpleIcon as PhPencil,
} from "@phosphor-icons/react";

const EASE_SMOOTH: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** The option id reserved for the visitor's own typed answer. */
const CUSTOM_ID = "__custom";

export interface ApprovalOption {
  id: string;
  label: string;
  /** One line naming what picking this costs or changes. */
  detail?: string;
}

export interface ApprovalQuestion {
  id: string;
  /** Two or three words, used as the label on the receipt chip. */
  header: string;
  question: string;
  options: ApprovalOption[];
  /** What the agent picks for itself when this question is skipped. */
  fallback?: string[];
  multiSelect?: boolean;
  /** Adds a "Something else" row that opens a text field. */
  allowCustom?: boolean;
}

export interface ApprovalCardProps {
  questions: ApprovalQuestion[];
  /** Answers per question id, plus the ids that fell through to the agent. */
  onSubmit?: (answers: Record<string, string[]>, assumed: string[]) => void;
  onDismiss?: () => void;
  className?: string;
}

type Status = "asking" | "sent" | "dismissed";

function isAnswered(_q: ApprovalQuestion, picked: string[], custom: string) {
  if (picked.length === 0) return false;
  if (picked.includes(CUSTOM_ID) && custom.trim() === "") return false;
  return true;
}

/** Reads back in the order the options are declared, not the order they were clicked. */
function labelsFor(q: ApprovalQuestion, picked: string[], custom: string) {
  const inOrder = q.options.filter((o) => picked.includes(o.id)).map((o) => o.label);
  return picked.includes(CUSTOM_ID) ? [...inOrder, custom.trim()] : inOrder;
}

export function ApprovalCard({ questions, onSubmit, onDismiss, className = "" }: ApprovalCardProps) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  const [skipHint, setSkipHint] = useState(false);
  const [status, setStatus] = useState<Status>("asking");
  const shouldReduceMotion = useReducedMotion();
  const groupName = useId();
  const customRef = useRef<HTMLInputElement | null>(null);

  const q = questions[index];
  const picked = answers[q.id] ?? [];
  const customText = custom[q.id] ?? "";
  const answered = isAnswered(q, picked, customText);
  const fallback = q.fallback ?? [];
  const last = index === questions.length - 1;

  useEffect(() => {
    if (customOpen[q.id]) customRef.current?.focus();
  }, [customOpen, q.id]);

  const choose = (id: string) => {
    setAnswers((prev) => {
      const current = prev[q.id] ?? [];
      if (!q.multiSelect) return { ...prev, [q.id]: [id] };
      return {
        ...prev,
        [q.id]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
      };
    });
    setSkipped((prev) => prev.filter((x) => x !== q.id));
    if (id === CUSTOM_ID) setCustomOpen((prev) => ({ ...prev, [q.id]: true }));
  };

  const move = (next: number) => {
    setDirection(next > index ? 1 : -1);
    setIndex(next);
    setSkipHint(false);
  };

  const finish = (clearedId?: string) => {
    const resolved: Record<string, string[]> = {};
    const assumed: string[] = [];
    for (const item of questions) {
      const chosen = item.id === clearedId ? [] : (answers[item.id] ?? []);
      if (isAnswered(item, chosen, custom[item.id] ?? "")) {
        resolved[item.id] = chosen;
      } else {
        resolved[item.id] = item.fallback ?? [];
        assumed.push(item.id);
      }
    }
    setSkipped(assumed);
    setStatus("sent");
    onSubmit?.(resolved, assumed);
  };

  const advance = () => (last ? finish() : move(index + 1));

  const skip = () => {
    setAnswers((prev) => ({ ...prev, [q.id]: [] }));
    setSkipped((prev) => (prev.includes(q.id) ? prev : [...prev, q.id]));
    setCustomOpen((prev) => ({ ...prev, [q.id]: false }));
    if (last) finish(q.id);
    else move(index + 1);
  };

  const dismiss = () => {
    setStatus("dismissed");
    onDismiss?.();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" && (target as HTMLInputElement).type === "text";
    if (event.key === "Escape") {
      event.preventDefault();
      skip();
      return;
    }
    if (event.key === "Enter" && target.tagName !== "BUTTON") {
      if (!answered) return;
      event.preventDefault();
      advance();
      return;
    }
    if (typing) return;
    const n = Number(event.key);
    const rows = q.allowCustom ? q.options.length + 1 : q.options.length;
    if (Number.isInteger(n) && n >= 1 && n <= rows) {
      event.preventDefault();
      choose(n > q.options.length ? CUSTOM_ID : q.options[n - 1].id);
    }
  };

  const segmentState = (i: number) => {
    const item = questions[i];
    if (isAnswered(item, answers[item.id] ?? [], custom[item.id] ?? "")) return "answered";
    if (i === index && status === "asking") return "current";
    if (skipped.includes(item.id)) return "skipped";
    return "not answered yet";
  };

  const segmentClass = (i: number) => {
    switch (segmentState(i)) {
      case "answered":
        return "bg-emerald-600";
      case "skipped":
        return "bg-amber-500";
      case "current":
        return "bg-stone-400 dark:bg-stone-600";
      default:
        return "bg-stone-200 dark:bg-stone-800";
    }
  };

  const enter = shouldReduceMotion
    ? { opacity: 0 }
    : { opacity: 0, y: direction > 0 ? 8 : -8 };

  return (
    <div
      onKeyDown={onKeyDown}
      className={`w-full rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900 ${className}`}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {status === "sent"
          ? `${questions.length} answers sent.`
          : status === "dismissed"
            ? "Card dismissed. The agent will use its own picks."
            : `Question ${index + 1} of ${questions.length}. ${q.question}`}
      </p>

      {questions.length > 1 && status === "asking" && (
        <div className="mb-4 flex items-center gap-1" aria-hidden>
          {questions.map((item, i) => (
            <span
              key={item.id}
              className={`flex-1 rounded-full transition-colors duration-150 ${i === index ? "h-1" : "h-0.5"} ${segmentClass(i)}`}
            />
          ))}
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {status === "asking" ? (
          <motion.div
            key={`ask-${q.id}`}
            initial={enter}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: EASE_SMOOTH }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">
                  Waiting on you
                  {questions.length > 1 && (
                    <span className="tabular-nums"> · {index + 1} of {questions.length}</span>
                  )}
                </p>
                <h3 className="mt-2 text-base font-semibold text-stone-900 dark:text-stone-100">{q.question}</h3>
                {q.multiSelect && (
                  <p id={`${groupName}-${q.id}-hint`} className="mt-1 text-xs text-stone-500 dark:text-stone-500">
                    Pick as many as apply.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss and let the agent decide"
                className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors duration-150 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
              >
                <PhX size={14} aria-hidden />
              </button>
            </div>

            <p className="sr-only">
              Press 1 to {q.allowCustom ? q.options.length + 1 : q.options.length} to choose, Enter to continue, Escape to
              skip.
            </p>

            <div
              role={q.multiSelect ? "group" : "radiogroup"}
              aria-label={q.question}
              aria-describedby={q.multiSelect ? `${groupName}-${q.id}-hint` : undefined}
              className="mt-4 flex flex-col gap-2"
            >
              {q.options.map((option) => {
                const on = picked.includes(option.id);
                const hinted = skipHint && !answered && fallback.includes(option.id);
                return (
                  <label key={option.id} className="block cursor-pointer">
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={q.multiSelect ? undefined : `${groupName}-${q.id}`}
                      checked={on}
                      onChange={() => choose(option.id)}
                      className="peer sr-only"
                    />
                    <span
                      className={`flex items-start gap-3 rounded-xl border p-3 transition-colors duration-150 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-600 dark:peer-focus-visible:outline-emerald-400 ${
                        on
                          ? "border-emerald-600 bg-emerald-500/10"
                          : hinted
                            ? "border-amber-600 bg-amber-500/10"
                            : "border-stone-200 hover:bg-stone-100 dark:border-stone-800 dark:hover:bg-stone-800"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors duration-150 ${
                          q.multiSelect ? "rounded-md" : "rounded-full"
                        } ${
                          on
                            ? "border-emerald-700 bg-emerald-700 text-white dark:border-emerald-600 dark:bg-emerald-700"
                            : "border-stone-300 dark:border-stone-700"
                        }`}
                      >
                        {on &&
                          (q.multiSelect ? (
                            <PhCheck size={10} weight="bold" aria-hidden />
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-white" />
                          ))}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-2">
                          <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{option.label}</span>
                          {fallback.includes(option.id) && (
                            <span
                              className={`text-[11px] transition-colors duration-150 ${
                                hinted ? "text-amber-700 dark:text-amber-400" : "text-stone-500 dark:text-stone-500"
                              }`}
                            >
                              agent&rsquo;s pick
                            </span>
                          )}
                        </span>
                        {option.detail && (
                          <span className="mt-1 block text-xs text-stone-600 dark:text-stone-400">{option.detail}</span>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}

              {q.allowCustom && (
                <label className="block cursor-pointer">
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={q.multiSelect ? undefined : `${groupName}-${q.id}`}
                    checked={picked.includes(CUSTOM_ID)}
                    onChange={() => choose(CUSTOM_ID)}
                    className="peer sr-only"
                  />
                  <span
                    className={`flex items-start gap-3 rounded-xl border p-3 transition-colors duration-150 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-600 dark:peer-focus-visible:outline-emerald-400 ${
                      picked.includes(CUSTOM_ID)
                        ? "border-emerald-600 bg-emerald-500/10"
                        : "border-stone-200 hover:bg-stone-100 dark:border-stone-800 dark:hover:bg-stone-800"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-stone-500 dark:text-stone-500"
                    >
                      <PhPencil size={12} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-stone-600 dark:text-stone-400">Something else</span>
                      {customOpen[q.id] && (
                        <input
                          ref={customRef}
                          type="text"
                          value={customText}
                          onChange={(event) => setCustom((prev) => ({ ...prev, [q.id]: event.target.value }))}
                          onClick={(event) => event.stopPropagation()}
                          placeholder="Type your answer"
                          className="mt-2 h-9 w-full rounded-md border border-stone-300 bg-stone-100 px-3 text-sm text-stone-900 outline-none placeholder:text-stone-400 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/25 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-emerald-400 dark:focus:ring-emerald-400/25"
                        />
                      )}
                    </span>
                  </span>
                </label>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-3">
              {questions.length > 1 && (
                <div className="flex h-8 items-stretch rounded-md border border-stone-300 dark:border-stone-700">
                  <PagerButton label="Previous question" disabled={index === 0} onClick={() => move(index - 1)}>
                    <PhCaretLeft size={12} weight="bold" aria-hidden />
                  </PagerButton>
                  <span className="w-px bg-stone-200 dark:bg-stone-800" aria-hidden />
                  <PagerButton label="Next question" disabled={last} onClick={() => move(index + 1)}>
                    <PhCaretRight size={12} weight="bold" aria-hidden />
                  </PagerButton>
                </div>
              )}
              <button
                type="button"
                onClick={skip}
                onMouseEnter={() => setSkipHint(true)}
                onMouseLeave={() => setSkipHint(false)}
                onFocus={() => setSkipHint(true)}
                onBlur={() => setSkipHint(false)}
                className="h-8 rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-700 transition-colors duration-150 hover:bg-stone-100 active:scale-[0.98] dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={advance}
                disabled={!answered}
                className="h-8 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-emerald-800 active:bg-emerald-900 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
              >
                {last ? "Send" : "Continue"}
              </button>
            </div>
          </motion.div>
        ) : status === "sent" ? (
          <motion.div
            key="sent"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: EASE_SMOOTH }}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                <PhCheck size={13} weight="bold" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  {questions.length === 1 ? "Answer sent" : `${questions.length} answers sent`}
                </p>
                <ul className="mt-3 flex flex-col gap-2">
                  {questions.map((item) => {
                    const chosen = answers[item.id] ?? [];
                    const text = custom[item.id] ?? "";
                    const real = isAnswered(item, chosen, text);
                    const values = real
                      ? labelsFor(item, chosen, text)
                      : labelsFor(item, item.fallback ?? [], "");
                    return (
                      <li key={item.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                        <span className="text-stone-500 dark:text-stone-500">{item.header}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 ${
                            real
                              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                              : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          }`}
                        >
                          {values.length > 0 ? values.join(", ") : "nothing"}
                        </span>
                        {!real && <span className="text-stone-500 dark:text-stone-500">assumed</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setStatus("asking");
                  move(0);
                }}
                className="flex h-8 items-center gap-2 rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-700 transition-colors duration-150 hover:bg-stone-100 active:scale-[0.98] dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
              >
                <PhUndo size={12} aria-hidden />
                Change an answer
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="dismissed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: EASE_SMOOTH }}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Dismissed. The run continues on the agent&rsquo;s own picks.
            </p>
            <button
              type="button"
              onClick={() => setStatus("asking")}
              className="h-8 rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-700 transition-colors duration-150 hover:bg-stone-100 active:scale-[0.98] dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
            >
              Bring it back
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="relative flex w-8 items-center justify-center rounded-md text-stone-500 transition-colors duration-150 hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-50 dark:text-stone-400 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400"
    >
      {children}
    </button>
  );
}
