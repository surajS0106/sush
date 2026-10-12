// Slide decks written by `slides_write` (lib/slides.ts): the card in the chat,
// the side panel that shows the open deck, and full-screen presenting.
//
// Slides render into shadow roots rather than iframes: the deck's CSS stays
// scoped to it, and the app's bundled fonts (document-level @font-face) still
// apply. The markup is sanitized and the CSP blocks scripts either way.

import type { DynamicToolUIPart } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  DownloadIcon,
  LayoutGridIcon,
  Maximize2Icon,
  MessageCircleIcon,
  Minimize2Icon,
  PlayIcon,
  PresentationIcon,
  SquareIcon,
  StickyNoteIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { ToolResultRow } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PANEL, setLayout, useLayout } from "@/lib/layout";
import { sendMessage } from "@/lib/sessions";
import {
  closeDeck,
  deckFileName,
  exportDeckHtml,
  loadRemoteImages,
  openDeck,
  setDeckExpanded,
  SLIDE_H,
  SLIDE_W,
  slideMarkup,
  useDeckPanel,
  type DeckVersion,
  type DeckView,
  type Slide,
} from "@/lib/slides";
import { api, errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- one slide ------------------------------------------------------------------------

interface SlideViewProps {
  css: string;
  slide: Slide;
  /** Thumbnails repeat the canvas, so they're hidden from screen readers. */
  decorative?: boolean;
  className?: string;
}

/** A 1920×1080 slide scaled to the width it's given. */
export function SlideView({ css, slide, decorative, className }: SlideViewProps) {
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  // Slides are rebuilt on every streamed token; only re-render the ones whose markup changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const markup = useMemo(() => slideMarkup(css, slide), [css, slide.html, slide.className]);

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / SLIDE_W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.innerHTML = markup;
    void loadRemoteImages(root);
  }, [markup]);

  return (
    <div ref={outer} className={cn("relative aspect-video overflow-hidden bg-white", className)}>
      <div
        ref={host}
        aria-hidden={decorative}
        className="pointer-events-none absolute top-0 left-0 origin-top-left select-none"
        style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})` }}
      />
    </div>
  );
}

/** Where the next slide will land while the model is still writing it. */
function PendingSlide({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn("relative flex aspect-video items-center justify-center overflow-hidden bg-muted", className)}>
      <div className="absolute inset-0 animate-pulse bg-foreground/[0.03]" />
      {label && <LoadingState label={label} />}
    </div>
  );
}

async function saveDeck(version: DeckVersion, format: "html" | "pptx") {
  try {
    if (format === "html") {
      await api.saveTextFileAs(deckFileName(version.title, "html"), await exportDeckHtml(version));
      return;
    }
    // Loaded on first use: the PowerPoint writer is large and most chats never need it.
    const building = toast.loading("Building the PowerPoint file…");
    let data: string;
    try {
      const { exportDeckPptx } = await import("@/lib/pptx");
      data = await exportDeckPptx(version);
    } finally {
      toast.dismiss(building);
    }
    await api.saveBytesFileAs(deckFileName(version.title, "pptx"), data);
  } catch (e) {
    toast.error(`Couldn't save ${version.title}: ${errorMessage(e)}`);
  }
}

/** The formats a deck saves as, for the panel's Export menu and the card's download menu. */
function ExportItems({ version }: { version: DeckVersion }) {
  return (
    <>
      <DropdownMenuItem onSelect={() => void saveDeck(version, "pptx")}>
        <PresentationIcon /> PowerPoint (.pptx)…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void saveDeck(version, "html")}>
        <CodeIcon /> Web page (.html)…
      </DropdownMenuItem>
    </>
  );
}

function IconButton({
  label,
  pressed,
  onClick,
  disabled,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn("text-muted-foreground hover:text-foreground", pressed && "bg-accent text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// --- the card in the chat -------------------------------------------------------------

export function DeckCard({
  threadId,
  part,
  view,
  latest,
}: {
  threadId: string;
  part: DynamicToolUIPart;
  /** The deck as of this call. */
  view?: DeckView;
  /** The deck with all its versions. */
  latest?: DeckView;
}) {
  const panel = useDeckPanel(threadId);
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <PresentationIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't show the slides</span>
          </>
        }
      />
    );
  }
  if (!view) return null;
  const index = view.versions.length - 1;
  const version = view.versions[index];
  // The newest call's card follows later versions; an older one opens its own.
  const pinned = !latest || index === latest.versions.length - 1 ? null : index;
  const shown = panel?.deckId === view.id && panel.version === pinned;
  const toggle = () => (shown ? closeDeck(threadId) : openDeck(threadId, view.id, pinned));
  const first = version.slides[0];
  const count = version.slides.length;

  return (
    <div className="flex items-center gap-4 rounded-2xl border bg-card p-2.5 pr-3">
      <button
        type="button"
        onClick={() => openDeck(threadId, view.id, pinned)}
        aria-label={`Open ${version.title}`}
        className="w-28 shrink-0 overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {first ? (
          <SlideView decorative css={version.css} slide={first} />
        ) : (
          <div className="flex aspect-video items-center justify-center bg-brand/10 text-brand">
            <PresentationIcon className="size-5" />
          </div>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{version.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {view.building
            ? count > 0
              ? `Building slide ${count}…`
              : "Starting your slides…"
            : `Slides · ${version.label} · ${count} ${count === 1 ? "slide" : "slides"}`}
        </p>
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Download" disabled={view.building || count === 0}>
                <DownloadIcon />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-52">
          <ExportItems version={version} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="secondary"
        onClick={toggle}
        className="min-w-16"
      >
        {shown ? "Hide" : "Open"}
      </Button>
    </div>
  );
}

// --- the side panel -------------------------------------------------------------------

type Zoom = "fit" | 0.5 | 0.75 | 1;
const ZOOMS: Zoom[] = ["fit", 0.5, 0.75, 1];

interface SlidesPanelProps {
  threadId: string;
  deck: DeckView;
  /** A run is going; comments wait for it. */
  busy: boolean;
}

export function SlidesPanel({ threadId, deck, busy }: SlidesPanelProps) {
  const state = useDeckPanel(threadId);
  const { panel: width } = useLayout();
  const ref = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const versionIndex = Math.min(state?.version ?? deck.versions.length - 1, deck.versions.length - 1);
  const version = deck.versions[versionIndex];
  const latest = versionIndex === deck.versions.length - 1;
  const building = deck.building && latest;
  const slides = version.slides;
  const expanded = !!state?.expanded;

  const [index, setIndex] = useState(0);
  const [view, setView] = useState<"single" | "grid">("single");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [stripOpen, setStripOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const at = Math.max(0, Math.min(index, slides.length - 1));
  const slide = slides[at] as Slide | undefined;

  // Follow the slide being written.
  useEffect(() => {
    if (building && slides.length > 0) setIndex(slides.length - 1);
  }, [building, slides.length]);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const PAD = 48;
  const fitWidth = Math.max(0, Math.min(box.w - PAD, ((box.h - PAD) * SLIDE_W) / SLIDE_H));
  const slideWidth = zoom === "fit" ? fitWidth : SLIDE_W * zoom;
  const zoomLabel = `${Math.round((slideWidth / SLIDE_W) * 100)}%`;

  const go = (i: number) => setIndex(Math.max(0, Math.min(slides.length - 1, i)));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input, [role=menu]")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") go(at + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(slides.length - 1);
    else return;
    e.preventDefault();
  };

  const comment = (where: string, text: string) => {
    setCommenting(false);
    sendMessage(threadId, `On slide ${at + 1} of "${version.title}" (${where}): ${text}`, []);
  };

  return (
    <aside
      ref={ref}
      aria-label={`${version.title} slides`}
      className={cn(
        "relative flex min-w-[320px] shrink-0 flex-col p-2",
        expanded ? "flex-1" : "max-w-[calc(100%-360px)] pl-0",
        !expanded && width === null && "w-[56%] max-w-[min(1100px,calc(100%-360px))]",
      )}
      style={expanded || width === null ? undefined : { width }}
    >
      {!expanded && (
        <ResizeHandle
          label="Resize slides panel"
          edge="left"
          min={PANEL.min}
          max={() => Math.min(PANEL.max, (ref.current?.parentElement?.clientWidth ?? Infinity) - PANEL.chatMin)}
          measure={() => ref.current?.offsetWidth ?? PANEL.min}
          preview={(w) => {
            if (!ref.current) return;
            ref.current.style.width = `${w}px`;
            ref.current.classList.remove("w-[56%]", "max-w-[min(1100px,calc(100%-360px))]");
          }}
          onResize={(panel) => setLayout({ panel })}
          onReset={() => setLayout({ panel: null })}
        />
      )}
      <section
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background"
      >
        {/* Title, versions, and what can be done with the deck. */}
        <header className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 gap-1 px-2 text-sm font-medium">
                <span className="truncate">{version.title}</span>
                {!latest && <span className="shrink-0 text-xs font-normal text-muted-foreground">{version.label}</span>}
                <ChevronDownIcon className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              <DropdownMenuLabel>Versions</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(versionIndex)}
                onValueChange={(v) => {
                  const i = Number(v);
                  openDeck(threadId, deck.id, i === deck.versions.length - 1 ? null : i);
                }}
              >
                {deck.versions
                  .map((v, i) => (
                    <DropdownMenuRadioItem key={v.label} value={String(i)}>
                      <span className="font-medium">{v.label}</span>
                      <span className="truncate text-muted-foreground">{v.note}</span>
                    </DropdownMenuRadioItem>
                  ))
                  .reverse()}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex-1" />
          <IconButton
            label={commenting ? "Stop commenting" : "Comment on a slide"}
            pressed={commenting}
            disabled={!slide || building}
            onClick={() => setCommenting((c) => !c)}
          >
            <MessageCircleIcon />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="mx-1 bg-foreground text-background hover:bg-foreground/90" disabled={slides.length === 0}>
                <DownloadIcon /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <ExportItems version={version} />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  void navigator.clipboard
                    .writeText(slides.map((s, i) => `Slide ${i + 1}\n${s.notes || "(no notes)"}`).join("\n\n"))
                    .then(() => toast.success("Speaker notes copied"))
                }
              >
                <StickyNoteIcon /> Copy speaker notes
              </DropdownMenuItem>
              <p className="max-w-56 px-2 pt-2 pb-1.5 text-xs text-muted-foreground">For a PDF, open the web page in a browser and print it.</p>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton label={expanded ? "Show the chat" : "Expand"} onClick={() => setDeckExpanded(threadId, !expanded)}>
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </IconButton>
          <IconButton label="Close" onClick={() => closeDeck(threadId)}>
            <XIcon />
          </IconButton>
        </header>

        {/* Navigation on the left, viewing on the right. */}
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
          <div className="flex items-center rounded-lg border p-0.5">
            <IconButton label="Previous slide" disabled={at === 0} onClick={() => go(at - 1)}>
              <ChevronLeftIcon />
            </IconButton>
            <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {slides.length ? `${at + 1} / ${slides.length}` : "–"}
            </span>
            <IconButton label="Next slide" disabled={at >= slides.length - 1} onClick={() => go(at + 1)}>
              <ChevronRightIcon />
            </IconButton>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
            <IconButton label="Present" disabled={slides.length === 0} onClick={() => setPresenting(true)}>
              <PlayIcon />
            </IconButton>
            <IconButton label={notesOpen ? "Hide speaker notes" : "Speaker notes"} pressed={notesOpen} onClick={() => setNotesOpen((o) => !o)}>
              <StickyNoteIcon />
            </IconButton>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs tabular-nums" disabled={view === "grid"}>
                  {zoomLabel}
                  <ChevronDownIcon className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {ZOOMS.map((z) => (
                  <DropdownMenuItem key={String(z)} onSelect={() => setZoom(z)}>
                    <CheckIcon className={cn(zoom !== z && "invisible")} />
                    {z === "fit" ? "Fit to panel" : `${z * 100}%`}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* The slide, or every slide in a grid. */}
        <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-auto">
          {view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 p-6">
              {slides.map((s, i) => (
                <Thumb key={i} n={i + 1} css={version.css} slide={s} selected={i === at} onClick={() => (go(i), setView("single"))} />
              ))}
              {building && <PendingSlide className="rounded-lg" />}
            </div>
          ) : (
            <div className="flex min-h-full min-w-fit items-center justify-center p-6">
              <div className="relative shrink-0" style={{ width: slideWidth }}>
                {slide ? (
                  <SlideView key={`${versionIndex}-${at}`} css={version.css} slide={slide} className="rounded-sm shadow-lg ring-1 ring-black/5" />
                ) : (
                  <PendingSlide className="rounded-sm" label={building ? "Building your slides" : undefined} />
                )}
                {commenting && slide && <CommentLayer disabled={busy} onSubmit={comment} onCancel={() => setCommenting(false)} />}
              </div>
            </div>
          )}
          {building && view === "single" && (
            <p className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit animate-[fade-up_0.3s_ease-out] rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-md">
              Comment on any slide, and Sush can revise it.
            </p>
          )}
        </div>

        {notesOpen && (
          <div className="max-h-40 shrink-0 overflow-y-auto border-t px-4 py-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Speaker notes · slide {at + 1}</p>
            <p className="text-sm whitespace-pre-wrap">{slide?.notes || <span className="text-muted-foreground">No notes for this slide.</span>}</p>
          </div>
        )}

        {/* The filmstrip. */}
        <footer className="shrink-0 border-t">
          <div className="flex h-10 items-center gap-1 px-3">
            <span className="text-xs text-muted-foreground">
              {slides.length} {slides.length === 1 ? "slide" : "slides"}
              {building && " · writing…"}
            </span>
            <div className="flex-1" />
            <div className="flex items-center rounded-md bg-muted p-0.5">
              <IconButton label="One slide" pressed={view === "single"} onClick={() => setView("single")}>
                <SquareIcon />
              </IconButton>
              <IconButton label="All slides" pressed={view === "grid"} onClick={() => setView("grid")}>
                <LayoutGridIcon />
              </IconButton>
            </div>
            <IconButton label={stripOpen ? "Hide thumbnails" : "Show thumbnails"} onClick={() => setStripOpen((o) => !o)}>
              <ChevronDownIcon className={cn("transition-transform", !stripOpen && "rotate-180")} />
            </IconButton>
          </div>
          {stripOpen && view === "single" && (
            <div role="listbox" aria-label="Slides" aria-orientation="horizontal" className="flex gap-2.5 overflow-x-auto px-3 pt-0.5 pb-3">
              {slides.map((s, i) => (
                <Thumb key={i} n={i + 1} css={version.css} slide={s} selected={i === at} onClick={() => go(i)} className="w-36" />
              ))}
              {building && <PendingSlide className="w-36 shrink-0 rounded-lg" />}
            </div>
          )}
        </footer>
      </section>

      {presenting && slides.length > 0 && (
        <Presenter css={version.css} slides={slides} start={at} onClose={(i) => (setPresenting(false), go(i))} />
      )}
    </aside>
  );
}

function Thumb({
  n,
  css,
  slide,
  selected,
  onClick,
  className,
}: {
  n: number;
  css: string;
  slide: Slide;
  selected: boolean;
  onClick: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={`Slide ${n}`}
      onClick={onClick}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-lg outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "ring-2 ring-brand" : "ring-1 ring-border hover:ring-foreground/30",
        className,
      )}
    >
      <SlideView decorative css={css} slide={slide} />
      <span className="absolute bottom-1 left-1 flex size-5 items-center justify-center rounded bg-black/60 text-[10px] font-medium tabular-nums text-white">
        {n}
      </span>
    </button>
  );
}

// --- comments -------------------------------------------------------------------------

/** Where on a slide a click landed, in words the model can act on. */
function describeSpot(x: number, y: number) {
  const row = y < 1 / 3 ? "top" : y > 2 / 3 ? "bottom" : "";
  const col = x < 1 / 3 ? "left" : x > 2 / 3 ? "right" : "";
  return row || col ? `near the ${[row, col].filter(Boolean).join("-")}` : "near the center";
}

/** Click a spot on the slide, then say what should change there. */
function CommentLayer({
  disabled,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  onSubmit: (where: string, text: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const send = () => {
    if (pin && text.trim() && !disabled) onSubmit(describeSpot(pin.x, pin.y), text.trim());
  };

  return (
    <div
      className="absolute inset-0 cursor-crosshair rounded-sm ring-2 ring-brand/60"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        setPin({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
      }}
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
    >
      {!pin && (
        <p className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background shadow">
          Click where you want a change
        </p>
      )}
      {pin && (
        <>
          <span
            className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand shadow"
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          />
          <div
            className="absolute z-10 w-64 cursor-auto rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg animate-[pop-in_0.15s_ease-out]"
            style={{
              left: `clamp(8px, calc(${pin.x * 100}% - 128px), calc(100% - 264px))`,
              ...(pin.y > 0.55 ? { bottom: `calc(${(1 - pin.y) * 100}% + 14px)` } : { top: `calc(${pin.y * 100}% + 14px)` }),
            }}
          >
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What should change here?"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setPin(null);
                }
              }}
              className="min-h-16 resize-none border-none bg-transparent p-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center justify-end gap-1.5">
              {disabled && <span className="mr-auto text-xs text-muted-foreground">Wait for the reply to finish</span>}
              <Button size="xs" variant="ghost" onClick={() => setPin(null)}>
                Cancel
              </Button>
              <Button size="xs" onClick={send} disabled={!text.trim() || disabled}>
                Comment
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- presenting -----------------------------------------------------------------------

/** Full-window slideshow. Arrows, Space and clicks advance; Escape returns to the slide it ended on. */
function Presenter({ css, slides, start, onClose }: { css: string; slides: Slide[]; start: number; onClose: (at: number) => void }) {
  const [at, setAt] = useState(start);
  const atRef = useRef(at);
  atRef.current = at;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const last = slides.length - 1;
      if (e.key === "Escape") closeRef.current(atRef.current);
      else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) setAt((i) => Math.min(last, i + 1));
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) setAt((i) => Math.max(0, i - 1));
      else if (e.key === "Home") setAt(0);
      else if (e.key === "End") setAt(last);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [slides.length]);

  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Presenting"
      className="group fixed inset-0 z-[100] flex items-center justify-center bg-black outline-none"
      onClick={() => setAt((i) => Math.min(slides.length - 1, i + 1))}
    >
      <SlideView key={at} css={css} slide={slides[at]} className="w-[min(100vw,calc(100vh*16/9))] animate-[pop-in_0.2s_ease-out]" />
      <div className="absolute right-4 bottom-4 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs tabular-nums text-white/80">
          {at + 1} / {slides.length}
        </span>
        <button
          type="button"
          aria-label="Stop presenting"
          onClick={(e) => (e.stopPropagation(), onClose(at))}
          className="rounded-full bg-white/10 p-1.5 text-white/80 hover:bg-white/20"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
