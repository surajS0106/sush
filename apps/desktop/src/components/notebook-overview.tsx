// A notebook's overview (cover, emoji, title, a summary of its sources and
// questions to ask), the dialog that customizes it, and the guide at the top
// of the source viewer. Summaries and guides are written by `lib/notebook-guides.ts`.

import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  CornerDownRightIcon,
  CropIcon,
  ImageIcon,
  ImageUpIcon,
  MoveIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { toast } from "sonner";

import { MessageResponse } from "@/components/ai-elements/message";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { sourceCount } from "@/components/notebook-sources";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatWhen } from "@/lib/automations";
import { generateGuide, generateOverview, guideDue, overviewDue, useGuideBusy } from "@/lib/notebook-guides";
import { openAddSources } from "@/lib/notebooks";
import { api, errorMessage, type CoverPosition, type Notebook, type NotebookSource } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- the overview --------------------------------------------------------------------

/** An empty chat's opening: the notebook, what its sources say, and what to ask. */
export function NotebookOverview({ notebook, ask, onCustomize }: { notebook: Notebook; ask: (text: string) => void; onCustomize: () => void }) {
  const generating = useGuideBusy(notebook.id);
  const checked = notebook.sources.filter((s) => s.checked);
  const ready = checked.filter((s) => s.status === "ready").length;
  const reading = checked.filter((s) => s.status === "reading").length;
  const summary = notebook.customSummary ?? notebook.overview?.summary;
  const questions = notebook.overview?.questions ?? [];

  const status =
    notebook.sources.length === 0
      ? "Add PDFs, web pages, papers or pasted text, then ask about them. Every answer cites the passage it comes from."
      : checked.length === 0
        ? "No sources are checked. Check the ones answers should use."
        : reading > 0 && ready === 0
          ? `Reading ${sourceCount(reading)}…`
          : null;

  return (
    <div className="mb-6 flex flex-col gap-5 text-left">
      <div className="group/cover relative overflow-hidden rounded-2xl border bg-card">
        {notebook.cover ? (
          <CoverImage src={notebook.cover} position={notebook.coverPosition} />
        ) : (
          <div aria-hidden className="absolute inset-0 bg-[radial-gradient(120%_120%_at_100%_0%,color-mix(in_oklch,var(--brand)_22%,transparent),transparent_60%)]" />
        )}
        {/* Keeps the title readable over any photo. */}
        {notebook.cover && <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/40 to-transparent" />}
        <div className="relative flex min-h-36 flex-col justify-end gap-1 p-5">
          <span className="text-4xl leading-none" aria-hidden>
            {notebook.emoji ?? "📓"}
          </span>
          <h2 className="mt-2 text-[26px] leading-tight font-medium tracking-tight text-balance">{notebook.title}</h2>
          <p className="text-xs text-muted-foreground">
            {sourceCount(notebook.sources.length)} · {formatWhen(new Date(notebook.updatedAt))}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="absolute top-3 right-3 opacity-80 group-hover/cover:opacity-100 focus-visible:opacity-100"
          onClick={onCustomize}
        >
          <PencilIcon /> Customize
        </Button>
      </div>

      {status ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{status}</p>
          {notebook.sources.length === 0 && (
            <Button variant="outline" className="rounded-full" onClick={() => openAddSources(notebook.id)}>
              <PlusIcon /> Add sources
            </Button>
          )}
        </div>
      ) : (
        <>
          {summary ? (
            <div className={cn("text-[15px] leading-relaxed transition-opacity", generating && !notebook.customSummary && "opacity-60")}>
              <MessageResponse>{summary}</MessageResponse>
            </div>
          ) : generating ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Writing the overview">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Ask about your {ready === 1 ? "source" : `${ready} sources`}; answers cite the passage behind each claim.</p>
          )}

          <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
            {summary && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(summary).then(() => toast.success("Summary copied"))}
              >
                <CopyIcon /> Copy
              </Button>
            )}
            {!notebook.customSummary && (
              <Button variant="ghost" size="sm" disabled={generating} onClick={() => void generateOverview(notebook, true)}>
                {generating ? <Spinner /> : <RotateCcwIcon />} {generating ? "Writing…" : summary ? "Rewrite" : "Write overview"}
              </Button>
            )}
            {generating && summary && <span className="text-xs">Updating for your latest sources…</span>}
            {!generating && overviewDue(notebook) && summary && !notebook.customSummary && (
              <span className="text-xs">Sources changed since this was written.</span>
            )}
          </div>

          {questions.length > 0 && (
            <ul className="grid gap-2 sm:grid-cols-3" aria-label="Suggested questions">
              {questions.map((q) => (
                <li key={q}>
                  <button
                    type="button"
                    onClick={() => ask(q)}
                    className="flex h-full w-full flex-col justify-between gap-4 rounded-xl border bg-card p-3 text-left text-sm transition-colors outline-none hover:border-brand/40 hover:bg-brand/5 focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    {q}
                    <CornerDownRightIcon className="size-4 text-brand" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// --- customizing ---------------------------------------------------------------------

const EMOJI = ["📓", "📚", "🧠", "🎨", "🔬", "💡", "📈", "🌍", "🩺", "⚖️", "💻", "🎧", "🧭", "✍️", "🏛️", "🌱"];

export function CustomizeDialog({ notebook, open, onOpenChange }: { notebook: Notebook; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState(notebook.title);
  const [emoji, setEmoji] = useState(notebook.emoji ?? "");
  const [custom, setCustom] = useState(!!notebook.customSummary);
  const [summary, setSummary] = useState(notebook.customSummary ?? notebook.overview?.summary ?? "");
  const [saving, setSaving] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  // The cover as it will be saved: the notebook keeps its own until Done.
  const [coverUrl, setCoverUrl] = useState<string | null>(notebook.cover ?? null);
  const [position, setPosition] = useState<CoverPosition>(notebook.coverPosition ?? CENTRED);
  const [adjusting, setAdjusting] = useState(false);
  // What adjusting started from, for its Cancel: the picture and framing before a new one was picked or moved.
  const before = useRef<{ cover: string | null; position: CoverPosition }>({ cover: null, position: CENTRED });

  useEffect(() => {
    if (!open) return;
    setCoverUrl(notebook.cover ?? null);
    setPosition(notebook.coverPosition ?? CENTRED);
    setAdjusting(false);
    setTitle(notebook.title);
    setEmoji(notebook.emoji ?? "");
    setCustom(!!notebook.customSummary);
    setSummary(notebook.customSummary ?? notebook.overview?.summary ?? "");
    // Only when it opens: the notebook changing underneath (a source read) mustn't wipe what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startAdjusting = () => {
    before.current = { cover: coverUrl, position };
    setAdjusting(true);
  };
  const cancelAdjusting = () => {
    setCoverUrl(before.current.cover);
    setPosition(before.current.position);
    setAdjusting(false);
  };

  // A new picture starts centred, ready to frame; Cancel brings the previous one back.
  const pickCover = async () => {
    setCoverBusy(true);
    try {
      const url = await api.notebookPickCover();
      if (url) {
        before.current = { cover: coverUrl, position };
        setCoverUrl(url);
        setPosition(CENTRED);
        setAdjusting(true);
      }
    } catch (e) {
      toast.error("Couldn’t use that image", { description: errorMessage(e) });
    }
    setCoverBusy(false);
  };

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await api.notebookCustomize(notebook.id, title, emoji.trim() || null, custom && summary.trim() ? summary : null, coverUrl, coverUrl ? position : null);
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn’t save that", { description: errorMessage(e) });
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Customize notebook</DialogTitle>
          <DialogDescription>How it looks, what it's called, and the summary at the start of its chats.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {coverUrl && adjusting ? (
            <CoverAdjuster
              src={coverUrl}
              value={position}
              onChange={setPosition}
              onDone={() => setAdjusting(false)}
              onCancel={cancelAdjusting}
              cancelLabel={before.current.cover !== coverUrl ? (before.current.cover ? "Keep the old cover" : "Don’t add it") : "Cancel"}
            />
          ) : (
            <div className="relative flex aspect-[4/1] items-end overflow-hidden rounded-xl border bg-card">
              {coverUrl ? (
                <CoverImage src={coverUrl} position={position} alt="Cover" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(120%_120%_at_100%_0%,color-mix(in_oklch,var(--brand)_22%,transparent),transparent_60%)]">
                  <ImageIcon className="size-6 text-muted-foreground/60" aria-hidden />
                </div>
              )}
              <div className="relative ml-auto flex gap-2 p-3">
                {coverUrl && (
                  <>
                    <Button type="button" variant="secondary" size="sm" disabled={coverBusy} onClick={() => setCoverUrl(null)}>
                      <Trash2Icon /> Remove
                    </Button>
                    <Button type="button" variant="secondary" size="sm" disabled={coverBusy} onClick={startAdjusting}>
                      <CropIcon /> Adjust
                    </Button>
                  </>
                )}
                {!coverUrl && notebook.cover && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => {
                    setCoverUrl(notebook.cover ?? null);
                    setPosition(notebook.coverPosition ?? CENTRED);
                  }}>
                    <RotateCcwIcon /> Undo remove
                  </Button>
                )}
                <Button type="button" variant="secondary" size="sm" disabled={coverBusy} onClick={() => void pickCover()}>
                  {coverBusy ? <Spinner /> : <ImageUpIcon />} {coverUrl ? "Change" : "Add a cover"}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="notebook-title" className="text-sm font-medium">
              Title
            </label>
            <Input id="notebook-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Emoji</legend>
            <div className="flex flex-wrap items-center gap-1">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={e}
                  aria-pressed={emoji === e}
                  onClick={() => setEmoji(e)}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg text-lg transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand/40",
                    emoji === e && "bg-brand/10 ring-1 ring-brand/40",
                  )}
                >
                  {e}
                </button>
              ))}
              <Input
                value={EMOJI.includes(emoji) ? "" : emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="Other"
                aria-label="Another emoji"
                className="h-9 w-20 text-center"
              />
            </div>
          </fieldset>

          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <label htmlFor="custom-summary" className="text-sm font-medium">
                  Write my own summary
                </label>
                <p className="text-xs text-muted-foreground">
                  Otherwise Sush writes one from your sources and rewrites it when they change.
                </p>
              </div>
              <Switch id="custom-summary" checked={custom} onCheckedChange={setCustom} />
            </div>
            {custom && (
              <Textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="What this notebook is about. Markdown works: **bold** a key term."
                aria-label="Summary"
                className="min-h-28 text-sm"
              />
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {saving && <Spinner />} Done
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- the cover -----------------------------------------------------------------------

const CENTRED: CoverPosition = { x: 50, y: 50, zoom: 1 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A cover filling its (relative, overflow-hidden) parent, framed as the user set it. */
export function CoverImage({ src, position, alt = "", imgRef }: { src: string; position?: CoverPosition; alt?: string; imgRef?: Ref<HTMLImageElement> }) {
  const p = position ?? CENTRED;
  return (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      draggable={false}
      className="absolute inset-0 size-full object-cover select-none"
      style={{
        objectPosition: `${p.x}% ${p.y}%`,
        transform: p.zoom !== 1 ? `scale(${p.zoom})` : undefined,
        transformOrigin: `${p.x}% ${p.y}%`,
      }}
    />
  );
}

/**
 * Framing a cover: drag the picture (or use the arrow keys) to choose what
 * stays in view, zoom with the slider (or + and −). The frame has the
 * overview's proportions, so what's seen here is what the notebook shows.
 */
function CoverAdjuster({
  src,
  value,
  onChange,
  onDone,
  onCancel,
  cancelLabel,
}: {
  src: string;
  value: CoverPosition;
  onChange: (p: CoverPosition) => void;
  onDone: () => void;
  /** Back to the picture and framing from before. */
  onCancel: () => void;
  cancelLabel: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ px: number; py: number; from: CoverPosition } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** How far, in pixels, the picture can travel across and down: its overflow past the frame, plus what zoom adds. */
  const travel = () => {
    const box = frame.current?.getBoundingClientRect();
    const el = img.current;
    if (!box || !el?.naturalWidth) return { x: 0, y: 0 };
    const ratio = el.naturalWidth / el.naturalHeight;
    const wide = ratio > box.width / box.height;
    const w = wide ? box.height * ratio : box.width;
    const h = wide ? box.height : box.width / ratio;
    return { x: w - box.width + box.width * (value.zoom - 1), y: h - box.height + box.height * (value.zoom - 1) };
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, from: value };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = travel();
    // Dragging the picture right brings its left side into view.
    const x = t.x > 1 ? d.from.x - ((e.clientX - d.px) / t.x) * 100 : d.from.x;
    const y = t.y > 1 ? d.from.y - ((e.clientY - d.py) / t.y) * 100 : d.from.y;
    onChange({ ...d.from, x: clamp(x, 0, 100), y: clamp(y, 0, 100) });
  };
  const up = () => {
    drag.current = null;
    setDragging(false);
  };
  const zoom = (z: number) => onChange({ ...value, zoom: clamp(Math.round(z * 100) / 100, 1, 3) });
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      onChange({ ...value, x: clamp(value.x + dx, 0, 100), y: clamp(value.y + dy, 0, 100) });
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoom(value.zoom + 0.1);
    } else if (e.key === "-") {
      e.preventDefault();
      zoom(value.zoom - 0.1);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={frame}
        role="application"
        tabIndex={0}
        aria-label="Cover framing. Drag, or use the arrow keys, to move the picture; plus and minus zoom."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        className={cn(
          "relative aspect-[4/1] touch-none overflow-hidden rounded-xl border bg-card outline-none ring-brand/60 focus-visible:ring-2",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <CoverImage src={src} position={value} imgRef={img} />
        <span
          className={cn(
            "pointer-events-none absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-xs backdrop-blur transition-opacity",
            dragging && "opacity-0",
          )}
        >
          <MoveIcon className="size-3.5" aria-hidden /> Drag to reposition
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={value.zoom <= 1} onClick={() => zoom(value.zoom - 0.25)}>
          <ZoomOutIcon />
        </Button>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={value.zoom}
          onChange={(e) => zoom(Number(e.target.value))}
          aria-label="Zoom"
          aria-valuetext={`${Math.round(value.zoom * 100)}%`}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-brand"
        />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={value.zoom >= 3} onClick={() => zoom(value.zoom + 0.25)}>
          <ZoomInIcon />
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={value.x === 50 && value.y === 50 && value.zoom === 1} onClick={() => onChange(CENTRED)}>
          <RotateCcwIcon /> Reset
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <XIcon /> {cancelLabel}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onDone}>
          <CheckIcon /> Use this
        </Button>
      </div>
    </div>
  );
}

// --- a source's guide ----------------------------------------------------------------

/** At the top of the source viewer: what the source is, and its key topics, each a question to ask. */
export function SourceGuideCard({ source }: { source: NotebookSource }) {
  const [open, setOpen] = useState(true);
  const generating = useGuideBusy(source.id);
  const { textInput } = usePromptInputController();
  const guide = source.guide;

  useEffect(() => {
    if (guideDue(source)) void generateGuide(source);
  }, [source]);

  const askAbout = (topic: string) => {
    textInput.setInput(`What does ${source.title} say about ${topic}?`);
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
  };

  if (!guide && !generating) {
    return (
      <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 text-sm text-muted-foreground">
        No guide yet.
        <Button variant="ghost" size="sm" onClick={() => void generateGuide(source, true)}>
          <SparklesIcon /> Write one
        </Button>
      </div>
    );
  }

  return (
    <section aria-label="Source guide" className="mb-4 rounded-xl border bg-brand/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <SparklesIcon className="size-4 text-brand" aria-hidden />
        <span className="flex-1">Source guide</span>
        {generating && <Spinner className="size-3.5" />}
        <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {guide ? (
            <div className={cn("text-sm leading-relaxed", generating && "opacity-60")}>
              <MessageResponse>{guide.summary}</MessageResponse>
            </div>
          ) : (
            <div className="flex flex-col gap-2" role="status" aria-label="Writing the guide">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          )}
          {guide && guide.topics.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">Key topics: pick one to ask about it</p>
              <ul className="flex flex-wrap gap-1.5">
                {guide.topics.map((t) => (
                  <li key={t}>
                    <button
                      type="button"
                      onClick={() => askAbout(t)}
                      className="rounded-full border bg-background px-2.5 py-1 text-xs transition-colors outline-none hover:border-brand/40 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
