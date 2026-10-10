// Human-in-the-loop questions for the `ask_user` tool, adapted from Beautiful
// UI's ApprovalCard (beautifului.dev/r/approval-card.json) onto our tokens.
//
// One question at a time. The stack slides vertically as you move between
// questions (the card's height animates to fit), the step counter rolls like an
// odometer, and the footer uses pill actions: a quiet Skip and a dark Continue.
// Single-choice answers auto-advance; multi-select waits.

import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CornerDownLeftIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import type { AskUserOutput, AskUserQuestion } from "@/lib/ask-user";
import { cn } from "@/lib/utils";

const ROLL_MS = 400;
const SLIDE = "360ms cubic-bezier(0.22, 1, 0.36, 1)";

/** Odometer digits: each character that changes rolls up (or down). */
function RollingDigits({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up");
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <>
      {Array.from({ length: chars.length }, (_, i) => {
        const o = oldVal[i] ?? "";
        const n = chars[i] ?? "";
        if (!rolling || o === n) return <span key={`${i}-${n}`}>{n}</span>;
        const top = dir === "down" ? n : o;
        const bottom = dir === "down" ? o : n;
        const restY = dir === "down" ? "0" : "-1em";
        const startY = dir === "down" ? "-1em" : "0";
        return (
          <span
            key={`${i}-${o}-${n}-${dir}`}
            className="relative inline-block h-[1em] overflow-hidden align-[-0.05em] leading-[1em]"
          >
            <span
              className="flex flex-col"
              style={{
                transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
                transform: `translateY(${shifted ? restY : startY})`,
              }}
            >
              <span className="h-[1em] leading-[1em]">{top}</span>
              <span className="h-[1em] leading-[1em]">{bottom}</span>
            </span>
          </span>
        );
      })}
    </>
  );
}

interface AskUserCardProps {
  questions: AskUserQuestion[];
  onSubmit: (output: AskUserOutput) => void;
  onDismiss: () => void;
}

export function AskUserCard({ questions, onSubmit, onDismiss }: AskUserCardProps) {
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const measured = useRef(false);
  const [viewportH, setViewportH] = useState<number | undefined>(undefined);
  const [trackY, setTrackY] = useState(0);
  const [animate, setAnimate] = useState(false);
  // Until the first question is measured, render only the active one so the
  // card opens at Q1's height instead of flashing to all questions stacked.
  const [ready, setReady] = useState(false);

  const last = qi === questions.length - 1;
  const selected = answers[qi] ?? [];
  const hasAnswer = selected.length > 0 || Boolean(custom[qi]?.trim());

  const sync = (withAnim: boolean) => {
    const item = questionRefs.current[qi];
    if (!item) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setViewportH(item.offsetHeight);
    setTrackY(item.offsetTop);
    setAnimate(withAnim && !reduce);
  };

  useLayoutEffect(() => {
    const withAnim = measured.current;
    measured.current = true;
    sync(withAnim);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi, answers, custom]);

  useEffect(() => {
    const id = requestAnimationFrame(() => sync(measured.current));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi]);

  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    },
    [],
  );

  const goTo = (next: number) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setQi(Math.min(Math.max(next, 0), questions.length - 1));
  };

  // Read the latest answers even when called from the auto-advance timer.
  const latest = useRef({ answers, custom });
  latest.current = { answers, custom };

  const send = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    const { answers, custom } = latest.current;
    onSubmit(
      questions.map((q, i) => {
        const picked = (answers[i] ?? []).map((o) => q.options[o]);
        const typed = custom[i]?.trim();
        const answer = typed ? [...picked, typed] : picked;
        return { question: q.question, answer: answer.length > 0 ? answer : null };
      }),
    );
  };

  const advance = () => {
    if (last) send();
    else goTo(qi + 1);
  };

  const toggle = (index: number) => {
    const multi = questions[qi].multiSelect;
    setAnswers((current) => {
      const picked = current[qi] ?? [];
      const next = !multi
        ? [index]
        : picked.includes(index)
          ? picked.filter((item) => item !== index)
          : [...picked, index];
      return { ...current, [qi]: next };
    });
    if (!multi) {
      setCustom((current) => ({ ...current, [qi]: "" }));
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(advance, 480);
    }
  };

  return (
    <div className="w-full max-w-96">
      <div
        className="relative overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm"
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="absolute top-2 right-2 z-10 text-muted-foreground"
        >
          <XIcon />
        </Button>
        <div className="p-3">
          {/* the question itself is the heading */}
          <div
            className="overflow-hidden"
            style={{ height: viewportH, transition: animate ? `height ${SLIDE}` : undefined }}
            aria-live="polite"
          >
            <div
              className="flex flex-col gap-[26px] will-change-transform"
              style={{
                transform: `translate3d(0, ${-trackY}px, 0)`,
                transition: animate ? `transform ${SLIDE}` : undefined,
              }}
            >
              {questions.map((question, qIdx) => {
                const active = qIdx === qi;
                if (!ready && !active) return null;
                const picked = answers[qIdx] ?? [];
                const questionStyle: CSSProperties = {
                  opacity: active ? 1 : 0,
                  transition: animate ? `opacity ${SLIDE}` : undefined,
                  pointerEvents: active ? undefined : "none",
                };
                return (
                  <div
                    key={qIdx}
                    ref={(el) => {
                      questionRefs.current[qIdx] = el;
                    }}
                    aria-hidden={active ? undefined : true}
                    style={questionStyle}
                  >
                    <div className="pr-7 text-sm font-medium">{question.question}</div>
                    {question.multiSelect && (
                      <div className="mt-0.5 text-xs text-muted-foreground">Pick any that apply</div>
                    )}
                    <div className="mt-2.5 flex flex-col gap-0.5">
                      {question.options.map((option, i) => {
                        const on = picked.includes(i);
                        return (
                          <button
                            key={option}
                            type="button"
                            aria-pressed={on}
                            tabIndex={active ? 0 : -1}
                            onClick={() => active && toggle(i)}
                            className="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-left transition-colors duration-100 hover:bg-accent"
                          >
                            <span
                              className={cn(
                                "flex size-4 shrink-0 items-center justify-center transition-colors duration-200",
                                question.multiSelect ? "rounded-[5px]" : "rounded-full",
                                on
                                  ? "bg-foreground text-background"
                                  : "border-[1.5px] border-muted-foreground/40 text-transparent",
                              )}
                            >
                              {question.multiSelect ? (
                                <CheckIcon className="size-3" strokeWidth={3} />
                              ) : (
                                <span
                                  className="size-1.5 rounded-full bg-background transition-transform duration-200"
                                  style={{ transform: on ? "scale(1)" : "scale(0)" }}
                                />
                              )}
                            </span>
                            <span
                              className={cn(
                                "text-[13px] transition-colors duration-200",
                                on ? "text-foreground" : "text-foreground/75",
                              )}
                            >
                              {option}
                            </span>
                          </button>
                        );
                      })}
                      <input
                        value={custom[qIdx] ?? ""}
                        tabIndex={active ? 0 : -1}
                        onChange={(event) => {
                          if (!active) return;
                          setCustom((current) => ({ ...current, [qIdx]: event.target.value }));
                          if (!question.multiSelect) setAnswers((current) => ({ ...current, [qIdx]: [] }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && hasAnswer) {
                            event.preventDefault();
                            advance();
                          }
                        }}
                        placeholder="Something else…"
                        aria-label="Custom answer"
                        className="rounded-md py-1.5 pr-2 pl-[30px] text-[13px] outline-none transition-colors duration-100 placeholder:text-muted-foreground hover:bg-accent focus:bg-accent"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* footer: step nav (rolling counter) + pill actions */}
        <div className="flex items-center justify-between gap-3 border-t p-2.5">
          <div className="flex items-center gap-1 text-muted-foreground">
            <button
              type="button"
              aria-label="Previous question"
              disabled={qi <= 0}
              onClick={() => goTo(qi - 1)}
              className="flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-foreground disabled:opacity-30"
            >
              <ChevronUpIcon className="size-3.5" />
            </button>
            <span className="inline-flex items-center text-xs leading-none font-medium tabular-nums">
              <RollingDigits value={`${qi + 1} / ${questions.length}`} />
            </span>
            <button
              type="button"
              aria-label="Next question"
              disabled={last}
              onClick={() => goTo(qi + 1)}
              className="flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-foreground disabled:opacity-30"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="rounded-full" onClick={advance}>
              Skip
            </Button>
            <Button size="sm" className="rounded-full" disabled={!hasAnswer} onClick={advance}>
              {last ? "Send" : "Continue"} <CornerDownLeftIcon className="size-3.5 opacity-60" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** What an answered (or dismissed) `ask_user` call looks like in the transcript. */
export function AskUserSummary({ output }: { output: AskUserOutput | null }) {
  return (
    <div className="flex w-full max-w-96 flex-col gap-2" style={{ animation: "pop-in 260ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted py-1 pr-2.5 pl-1 text-xs font-medium">
        <span className="flex size-4.5 items-center justify-center rounded-full bg-foreground text-background">
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
        {output ? "Answers sent" : "Questions dismissed"}
      </span>
      {output && (
        <dl className="space-y-1.5 pl-1 text-[13px]">
          {output.map(({ question, answer }, i) => (
            <div key={i}>
              <dt className="text-muted-foreground">{question}</dt>
              <dd className={cn(!answer && "text-muted-foreground italic")}>{answer ? answer.join(", ") : "Skipped"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
