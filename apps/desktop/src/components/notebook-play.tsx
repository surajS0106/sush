// Studio outputs you use rather than read: a quiz to take, flashcards to
// drill, a mind map to explore. Every question, card and node can name the
// passage it came from, which opens in the source viewer.

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  MaximizeIcon,
  MessageSquareTextIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  ShuffleIcon,
  TextQuoteIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { openPassage, parsePassageUrl, sourceTitle } from "@/lib/notebooks";
import type { FlashcardsData, MindMapData, MindMapNode, QuizData } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** "From <source>": opens the passage an item came from. */
export function SourceChip({ source, className }: { source?: string | null; className?: string }) {
  const ref = source ? parsePassageUrl(source) : null;
  if (!source || !ref) return null;
  const title = sourceTitle(ref.sourceId) ?? "the source";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openPassage(source);
      }}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:border-brand/40 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/40",
        className,
      )}
    >
      <TextQuoteIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">From {title}</span>
    </button>
  );
}

// --- quiz ----------------------------------------------------------------------------

export function QuizView({ data }: { data: QuizData }) {
  const questions = data.questions;
  const [at, setAt] = useState(0);
  const [picks, setPicks] = useState<(number | null)[]>(() => questions.map(() => null));
  const [done, setDone] = useState(false);
  const score = picks.filter((p, i) => p === questions[i]?.answer).length;

  const restart = () => {
    setPicks(questions.map(() => null));
    setAt(0);
    setDone(false);
  };

  if (done) {
    const missed = questions.flatMap((q, i) => (picks[i] !== q.answer ? [i] : []));
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border bg-card p-5 text-center">
          <p className="text-sm text-muted-foreground">Your score</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {score} <span className="text-lg text-muted-foreground">of {questions.length}</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {score === questions.length ? "Every one right." : score >= questions.length * 0.7 ? "Nicely done." : "Worth another look at the sources."}
          </p>
        </div>
        {missed.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">To review</p>
            {missed.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setAt(i);
                  setDone(false);
                }}
                className="truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
              >
                {i + 1}. {questions[i].question}
              </button>
            ))}
          </div>
        )}
        <Button variant="outline" onClick={restart}>
          <RotateCcwIcon /> Take it again
        </Button>
      </div>
    );
  }

  const q = questions[at];
  const picked = picks[at];
  const answered = picked !== null;
  const pick = (i: number) => !answered && setPicks((p) => p.map((v, j) => (j === at ? i : v)));
  const last = at === questions.length - 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          Question {at + 1} of {questions.length}
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${((at + (answered ? 1 : 0)) / questions.length) * 100}%` }} />
        </div>
        <span>{score} right</span>
      </div>
      <p className="text-[15px] leading-relaxed font-medium">{q.question}</p>
      <ul className="flex flex-col gap-2" aria-label="Options">
        {q.options.map((o, i) => {
          const right = i === q.answer;
          const mine = i === picked;
          return (
            <li key={i}>
              <button
                type="button"
                disabled={answered}
                aria-pressed={mine}
                onClick={() => pick(i)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                  !answered && "hover:border-brand/40 hover:bg-brand/5",
                  answered && right && "border-brand bg-brand/10",
                  answered && mine && !right && "border-destructive/60 bg-destructive/10",
                  answered && !right && !mine && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                    answered && right && "border-brand bg-brand text-brand-foreground",
                    answered && mine && !right && "border-destructive bg-destructive text-white",
                  )}
                  aria-hidden
                >
                  {answered && right ? <CheckIcon className="size-3" /> : answered && mine ? <XIcon className="size-3" /> : String.fromCharCode(65 + i)}
                </span>
                <span className="flex-1">{o}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {answered && (
        <div className="flex flex-col items-start gap-2 rounded-xl bg-muted/50 p-3 text-sm" role="status">
          <p className="font-medium">{picked === q.answer ? "Right." : `Not quite: it’s ${String.fromCharCode(65 + q.answer)}.`}</p>
          {q.explanation && <p className="text-muted-foreground">{q.explanation}</p>}
          <SourceChip source={q.source} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" disabled={at === 0} onClick={() => setAt(at - 1)}>
          <ArrowLeftIcon /> Back
        </Button>
        <Button size="sm" disabled={!answered} onClick={() => (last ? setDone(true) : setAt(at + 1))}>
          {last ? "See your score" : "Next"} <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

// --- flashcards ----------------------------------------------------------------------

export function FlashcardsView({ data }: { data: FlashcardsData }) {
  const cards = data.cards;
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const left = order.filter((i) => !known.has(i));
  const current = left[Math.min(pos, left.length - 1)];
  const card = current === undefined ? null : cards[current];

  const go = (to: number) => {
    setFlipped(false);
    setPos(Math.max(0, Math.min(to, left.length - 1)));
  };
  const gotIt = () => {
    if (current === undefined) return;
    setKnown((k) => new Set(k).add(current));
    setFlipped(false);
    // The next card slides into this place; past the end, wrap to the start.
    if (pos >= left.length - 1) setPos(0);
  };
  const again = () => go(pos + 1 >= left.length ? 0 : pos + 1);
  const shuffle = () => {
    const next = [...order];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    setOrder(next);
    go(0);
  };
  const restart = () => {
    setKnown(new Set());
    go(0);
  };

  const keys = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setFlipped((f) => !f);
    } else if (e.key === "ArrowRight") go(pos + 1);
    else if (e.key === "ArrowLeft") go(pos - 1);
    else if (e.key === "1" && flipped) again();
    else if (e.key === "2" && flipped) gotIt();
  };

  if (!card) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center">
        <CheckIcon className="size-6 text-brand" aria-hidden />
        <p className="font-medium">You know all {cards.length} cards</p>
        <Button variant="outline" size="sm" onClick={restart}>
          <RotateCcwIcon /> Start over
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" onKeyDown={keys}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">
          Card {pos + 1} of {left.length}
          {known.size > 0 && ` · ${known.size} known`}
        </span>
        <Button variant="ghost" size="xs" onClick={shuffle}>
          <ShuffleIcon /> Shuffle
        </Button>
      </div>
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={flipped ? `Answer: ${card.back}. Press to see the question.` : `${card.front}. Press to see the answer.`}
        className="group relative aspect-[3/2] w-full outline-none [perspective:1200px] focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-brand/50"
      >
        <div
          className={cn(
            "relative size-full rounded-2xl transition-transform duration-500 [transform-style:preserve-3d] motion-reduce:transition-none",
            flipped && "[transform:rotateY(180deg)]",
          )}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl border bg-card p-5 text-center [backface-visibility:hidden]">
            <span className="text-[17px] leading-snug font-medium text-balance">{card.front}</span>
            <span className="absolute bottom-3 text-xs text-muted-foreground">Click or press Space to flip</span>
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto rounded-2xl border border-brand/40 bg-brand/5 p-5 text-center [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <span className="text-sm leading-relaxed text-balance">{card.back}</span>
            <SourceChip source={card.source} />
          </div>
        </div>
      </button>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Previous card" disabled={pos === 0} onClick={() => go(pos - 1)}>
          <ArrowLeftIcon />
        </Button>
        {flipped ? (
          <div className="flex flex-1 gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={again}>
              Again <kbd className="ml-1 text-[10px] text-muted-foreground">1</kbd>
            </Button>
            <Button size="sm" className="flex-1" onClick={gotIt}>
              Got it <kbd className="ml-1 text-[10px] opacity-70">2</kbd>
            </Button>
          </div>
        ) : (
          <p className="flex-1 text-center text-xs text-muted-foreground">Answer it in your head, then flip</p>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Next card" disabled={pos >= left.length - 1} onClick={() => go(pos + 1)}>
          <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

// --- mind map ------------------------------------------------------------------------

type Placed = { id: string; node: MindMapNode; depth: number; x: number; y: number; path: string[] };

/**
 * Lays the tree out left to right: each shown leaf gets a row, and a parent
 * sits centred on its children. Collapsed nodes hide their children.
 */
function layout(root: MindMapNode, collapsed: Set<string>, nodeW: number, rowH: number) {
  const placed: Placed[] = [];
  const links: { from: Placed; to: Placed }[] = [];
  let rows = 0;
  const place = (node: MindMapNode, depth: number, id: string, path: string[]): Placed => {
    const here = [...path, node.label];
    const open = node.children.length > 0 && !collapsed.has(id);
    const kids = open ? node.children.map((c, i) => place(c, depth + 1, `${id}.${i}`, here)) : [];
    const y = kids.length ? (kids[0].y + kids[kids.length - 1].y) / 2 : rows++ * rowH;
    const p: Placed = { id, node, depth, x: depth * (nodeW + 56), y, path };
    placed.push(p);
    for (const k of kids) links.push({ from: p, to: k });
    return p;
  };
  place(root, 0, "0", []);
  const depth = Math.max(...placed.map((p) => p.depth));
  return { placed, links, width: (depth + 1) * nodeW + depth * 56, height: Math.max(rows, 1) * rowH };
}

/** Every node id that has children, for "Collapse all", and those deeper than two levels, collapsed at first. */
function branchIds(node: MindMapNode, id = "0", depth = 0, out: { all: string[]; deep: string[] } = { all: [], deep: [] }) {
  if (node.children.length) {
    out.all.push(id);
    if (depth >= 2) out.deep.push(id);
  }
  node.children.forEach((c, i) => branchIds(c, `${id}.${i}`, depth + 1, out));
  return out;
}

export function MindMapView({ data, onAsk, title }: { data: MindMapData; onAsk: (text: string) => void; title: string }) {
  const [large, setLarge] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <MindMap data={data} onAsk={onAsk} nodeW={150} extra={
        <Button variant="ghost" size="xs" onClick={() => setLarge(true)}>
          <MaximizeIcon /> Open large
        </Button>
      } />
      <Dialog open={large} onOpenChange={setLarge}>
        <DialogContent className="flex h-[85vh] flex-col sm:max-w-[min(90vw,72rem)]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Click a topic to see its note and source, or ask about it in the chat.</DialogDescription>
          </DialogHeader>
          <MindMap data={data} onAsk={(t) => {
            setLarge(false);
            onAsk(t);
          }} nodeW={190} fill />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MindMap({ data, onAsk, nodeW, fill, extra }: { data: MindMapData; onAsk: (text: string) => void; nodeW: number; fill?: boolean; extra?: ReactNode }) {
  const branches = useMemo(() => branchIds(data.root), [data.root]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(branches.deep));
  const [selected, setSelected] = useState<string>("0");
  const rowH = 44;
  const nodeH = 32;
  const { placed, links, width, height } = useMemo(() => layout(data.root, collapsed, nodeW, rowH), [data.root, collapsed, nodeW]);
  const chosen = placed.find((p) => p.id === selected) ?? placed.find((p) => p.id === "0");
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", fill && "flex-1")}>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="xs" onClick={() => setCollapsed(new Set())}>
          <ChevronsUpDownIcon /> Expand all
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setCollapsed(new Set(branches.all.filter((id) => id !== "0")))}>
          <ChevronsDownUpIcon /> Collapse
        </Button>
        <span className="flex-1" />
        {extra}
      </div>
      <div className={cn("overflow-auto rounded-xl border bg-card/50 p-4", fill ? "min-h-0 flex-1" : "max-h-[26rem]")}>
        <div className="relative" style={{ width, height }}>
          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
            {links.map(({ from, to }) => {
              const x1 = from.x + nodeW;
              const y1 = from.y + nodeH / 2;
              const x2 = to.x;
              const y2 = to.y + nodeH / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={to.id}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  className="stroke-brand/40"
                  strokeWidth={1.5}
                />
              );
            })}
          </svg>
          {placed.map((p) => {
            const kids = p.node.children.length;
            const shut = collapsed.has(p.id);
            return (
              <div key={p.id} className="absolute flex items-center" style={{ left: p.x, top: p.y, width: nodeW + (kids ? 22 : 0), height: nodeH }}>
                <button
                  type="button"
                  onClick={() => setSelected(p.id)}
                  aria-pressed={selected === p.id}
                  title={p.node.note ?? p.node.label}
                  style={{ width: nodeW }}
                  className={cn(
                    "h-full truncate rounded-lg border px-2.5 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
                    p.depth === 0
                      ? "border-brand bg-brand font-medium text-brand-foreground"
                      : p.depth === 1
                        ? "border-brand/40 bg-brand/10 font-medium hover:bg-brand/15"
                        : "bg-background hover:border-brand/40",
                    selected === p.id && p.depth > 0 && "ring-2 ring-brand/50",
                  )}
                >
                  {p.node.label}
                </button>
                {kids > 0 && (
                  <button
                    type="button"
                    onClick={() => toggle(p.id)}
                    aria-expanded={!shut}
                    aria-label={`${shut ? "Show" : "Hide"} ${kids} under ${p.node.label}`}
                    className="-ml-2.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background text-[10px] text-muted-foreground shadow-xs transition-colors hover:text-brand"
                  >
                    {shut ? kids : <MinusIcon className="size-3" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {chosen && (
        <div className="flex flex-col items-start gap-2 rounded-xl border bg-card p-3 text-sm">
          {chosen.path.length > 0 && <p className="text-xs text-muted-foreground">{chosen.path.join(" › ")}</p>}
          <p className="font-medium">{chosen.node.label}</p>
          {chosen.node.note && <p className="text-muted-foreground">{chosen.node.note}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <SourceChip source={chosen.node.source} />
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                onAsk(
                  chosen.path.length
                    ? `Tell me about “${chosen.node.label}” (under ${chosen.path.join(" › ")}).`
                    : `Give me an overview of “${chosen.node.label}”.`,
                )
              }
            >
              <MessageSquareTextIcon /> Ask about this
            </Button>
            {chosen.node.children.length > 0 && collapsed.has(chosen.id) && (
              <Button variant="ghost" size="xs" onClick={() => toggle(chosen.id)}>
                <PlusIcon /> Show {chosen.node.children.length}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
