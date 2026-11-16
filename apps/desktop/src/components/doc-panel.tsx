// Docs written by `doc_write` (lib/docs.ts): the card in the chat and the side
// panel the open doc is read and edited in. The panel shows the doc as Sush
// writes it, then hands over to the block editor (doc-editor.tsx); older
// versions open read-only with a Restore button. The Docs page reuses the
// body (`DocBody`) on its own.

import type { DynamicToolUIPart } from "ai";
import {
  ChevronDownIcon,
  CodeIcon,
  CopyIcon,
  FileTextIcon,
  FileTypeIcon,
  HistoryIcon,
  ListIcon,
  Maximize2Icon,
  Minimize2Icon,
  Share2Icon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { ToolResultRow } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  closeDoc,
  useDocs,
  copyDocMarkdown,
  copyDocRichText,
  downloadDoc,
  headings,
  openDoc,
  restoreDocVersion,
  setDocExpanded,
  useDoc,
  useDocPanel,
  wordCount,
  type DocCall,
} from "@/lib/docs";
import { parseDiagram, renderDiagram, splitDiagrams } from "@/lib/diagram";
import { PANEL, setLayout, useLayout } from "@/lib/layout";
import { isSharedThread, type Doc, type DocVersion } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const DocEditor = lazy(() => import("@/components/doc-editor"));

export function relativeTime(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function DocIcon({ icon, className }: { icon?: string | null; className?: string }) {
  return icon ? (
    <span aria-hidden className={cn("flex items-center justify-center leading-none", className)}>
      {icon}
    </span>
  ) : (
    <FileTextIcon aria-hidden className={cn("text-muted-foreground", className)} />
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="text-muted-foreground hover:text-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// --- the card in the chat -------------------------------------------------------------

export function DocCard({ threadId, part, call }: { threadId: string; part: DynamicToolUIPart; call?: DocCall }) {
  const panel = useDocPanel(threadId);
  const doc = useDoc(call?.docId);
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <FileTextIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't write the doc</span>
          </>
        }
      />
    );
  }
  if (!call) return null;
  const shown = panel?.docId === call.docId || (!!panel?.callId && panel.callId === call.callId);
  const title = call.streaming ? call.title : (doc?.title ?? call.title);
  const icon = call.streaming ? call.icon : (doc?.icon ?? call.icon);
  const version = doc?.versions.at(-1);
  const detail = call.streaming
    ? call.content
      ? `Writing… ${wordCount(call.content).toLocaleString()} words`
      : "Starting your doc…"
    : doc
      ? `Doc · v${version?.number ?? 1} · ${wordCount(doc.content).toLocaleString()} words${version?.author === "user" ? " · edited by you" : ""}`
      : isSharedThread(threadId)
        ? "Doc · read-only copy"
        : "Doc · deleted";

  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card p-2.5 pr-3">
      <button
        type="button"
        onClick={() => openDoc(threadId, call.docId, call.callId)}
        aria-label={`Open ${title}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <DocIcon icon={icon} className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <Button
        variant="secondary"
        onClick={() => (shown ? closeDoc(threadId) : openDoc(threadId, call.docId, call.callId))}
        className="min-w-16"
      >
        {shown ? "Hide" : "Open"}
      </Button>
    </div>
  );
}

// --- the top bar --------------------------------------------------------------------

/**
 * The chat's docs, in the window's top bar: opens or closes the doc panel. One doc toggles
 * straight away; several open a menu. Hidden until the chat has a doc.
 */
export function DocsButton({ threadId }: { threadId: string }) {
  const all = useDocs();
  const panel = useDocPanel(threadId);
  const docs = all.filter((d) => d.threadId === threadId);
  if (docs.length === 0) return null;
  const open = !!panel;
  const trigger = (props: React.ComponentProps<typeof Button>) => (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={open}
      className={cn("h-7 gap-1.5 rounded-full px-2.5 text-xs", open && "bg-accent text-foreground")}
      {...props}
    >
      <FileTextIcon className="size-3.5" /> {docs.length === 1 ? "Doc" : `Docs · ${docs.length}`}
    </Button>
  );
  if (docs.length === 1) {
    const doc = docs[0];
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger({ onClick: () => (open ? closeDoc(threadId) : openDoc(threadId, doc.id)) })}</TooltipTrigger>
        <TooltipContent side="bottom">{open ? "Hide the doc" : `Open ${doc.title}`}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger({})}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Docs in this chat</DropdownMenuLabel>
        {docs.map((d) => (
          <DropdownMenuItem key={d.id} onSelect={() => openDoc(threadId, d.id)} className="gap-2">
            <DocIcon icon={d.icon} className="size-4 shrink-0 text-base" />
            <span className="min-w-0 flex-1 truncate">{d.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{panel?.docId === d.id ? "Open" : relativeTime(d.updatedAt)}</span>
          </DropdownMenuItem>
        ))}
        {open && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => closeDoc(threadId)}>
              <XIcon /> Hide the doc
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- sharing --------------------------------------------------------------------------

export function ShareMenu({ doc, disabled }: { doc: Doc; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="mx-1 bg-foreground text-background hover:bg-foreground/90" disabled={disabled}>
          <Share2Icon /> Share
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuLabel>Copy</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void copyDocRichText(doc)}>
          <CopyIcon /> Copy doc
          <span className="ml-auto text-xs text-muted-foreground">Notion, Docs, email</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyDocMarkdown(doc)}>
          <FileTypeIcon /> Copy as Markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Download</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void downloadDoc(doc, "doc")}>
          <FileTextIcon /> Word (.doc)…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void downloadDoc(doc, "html")}>
          <CodeIcon /> Web page (.html)…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void downloadDoc(doc, "md")}>
          <FileTypeIcon /> Markdown (.md)…
        </DropdownMenuItem>
        <p className="max-w-60 px-2 pt-2 pb-1.5 text-xs text-muted-foreground">For a PDF, open the web page in a browser and print it.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- the doc itself -------------------------------------------------------------------

/** A read-only rendering: the doc while it's written, or an older version. */
function DocReading({ title, icon, content, streaming }: { title: string; icon?: string | null; content: string; streaming?: boolean }) {
  return (
    <div className="doc-gutter pb-24">
      {icon && <div className="mb-2 p-1 text-4xl leading-none">{icon}</div>}
      <h1 className="doc-title mb-6">{title}</h1>
      {splitDiagrams(content).map((seg, i, all) =>
        seg.kind === "text" ? (
          <MessageResponse key={i} className="doc-reading" isAnimating={streaming && i === all.length - 1}>
            {seg.text}
          </MessageResponse>
        ) : (
          <DiagramFigure key={i} source={seg.source} drawing={!seg.complete} />
        ),
      )}
    </div>
  );
}

/** A ```diagram block drawn read-only; "Drawing…" while its source is still streaming in. */
function DiagramFigure({ source, drawing }: { source: string; drawing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const spec = useMemo(() => (drawing ? null : parseDiagram(source)), [source, drawing]);
  useEffect(() => {
    const host = ref.current;
    if (!host || !spec || "error" in spec) return;
    host.replaceChildren(renderDiagram(spec));
  }, [spec]);
  if (drawing) return <div className="doc-widget my-4 text-sm text-muted-foreground">Drawing a diagram…</div>;
  if (!spec || "error" in spec) return <div className="doc-widget doc-diagram-error my-4">{spec?.error}</div>;
  return <div ref={ref} className="doc-widget my-4" />;
}

interface DocBodyProps {
  doc: Doc | undefined;
  /** The newest `doc_write` call for it, while it streams. */
  writing?: DocCall;
  /** The newest `doc_write` call, shown read-only where the doc isn't kept here (a shared session's guest, or deleted). */
  fallback?: DocCall;
  /** An older version to show read-only. */
  preview?: DocVersion | null;
  onLeavePreview?: () => void;
  onAsk?: (selection: string) => void;
  scrollRef?: React.Ref<HTMLDivElement>;
}

/** The scrolling page: the doc being written, an older version, or the editor. */
export function DocBody({ doc, writing, fallback, preview, onLeavePreview, onAsk, scrollRef }: DocBodyProps) {
  const latest = doc?.versions.at(-1);
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {writing ? (
        <>
          <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/70 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
            <LoadingState label="Sush is writing" />
          </div>
          <div className="pt-10">
            <DocReading title={writing.title} icon={writing.icon} content={writing.content} streaming />
          </div>
        </>
      ) : preview && doc && preview.number !== latest?.number ? (
        <>
          <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/70 px-4 py-2 text-sm backdrop-blur">
            <HistoryIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              Viewing v{preview.number} · {preview.note} · {relativeTime(preview.at)}
            </span>
            <Button size="sm" variant="ghost" onClick={onLeavePreview}>
              Back to current
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void restoreDocVersion(doc, preview.number);
                onLeavePreview?.();
              }}
            >
              Restore
            </Button>
          </div>
          <div className="pt-10">
            <DocReading title={preview.title} icon={doc.icon} content={preview.content} />
          </div>
        </>
      ) : doc ? (
        <div className="pt-12 pb-32">
          <Suspense fallback={<div className="doc-gutter text-sm text-muted-foreground">Opening the editor…</div>}>
            <DocEditor key={doc.id} doc={doc} onAsk={onAsk} />
          </Suspense>
        </div>
      ) : fallback ? (
        <>
          <div className="sticky top-0 z-10 bg-background/70 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
            Read-only: the doc as Sush last wrote it in this chat.
          </div>
          <div className="pt-10">
            <DocReading title={fallback.title} icon={fallback.icon} content={fallback.content} />
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
          <FileTextIcon className="size-6" />
          This doc was deleted.
        </div>
      )}
    </div>
  );
}

/** The outline: the doc's headings, each scrolling to its place. */
export function OutlineMenu({ doc, scroller }: { doc: Doc; scroller: React.RefObject<HTMLDivElement | null> }) {
  const list = headings(doc.content);
  const jump = (i: number) => {
    const root = scroller.current;
    const el =
      root?.querySelectorAll('[data-content-type="heading"]')[i] ?? root?.querySelectorAll(".doc-reading :is(h1, h2, h3)")[i];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Outline" className="text-muted-foreground hover:text-foreground">
              <ListIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Outline</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
        <DropdownMenuLabel>{doc.title}</DropdownMenuLabel>
        {list.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No headings yet.</p>}
        {list.map((h, i) => (
          <DropdownMenuItem key={i} onSelect={() => jump(i)} style={{ paddingLeft: 8 + (h.level - 1) * 14 }}>
            <span className={cn("truncate", h.level === 1 ? "font-medium" : "text-muted-foreground")}>{h.text}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pick an older version to look at. */
export function VersionsMenu({ doc, preview, onPreview }: { doc: Doc; preview: DocVersion | null; onPreview: (v: DocVersion | null) => void }) {
  const latest = doc.versions.at(-1);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 gap-1.5 px-2 text-sm font-medium">
          <DocIcon icon={doc.icon} className="size-4 text-base" />
          <span className="truncate">{doc.title}</span>
          {preview && preview.number !== latest?.number && <span className="shrink-0 text-xs font-normal text-muted-foreground">v{preview.number}</span>}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        <DropdownMenuLabel>Version history</DropdownMenuLabel>
        {[...doc.versions].reverse().map((v) => (
          <DropdownMenuItem key={v.number} onSelect={() => onPreview(v.number === latest?.number ? null : v)} className="items-start">
            <span className="w-8 shrink-0 font-medium tabular-nums">v{v.number}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{v.note}</span>
              <span className="block text-xs text-muted-foreground">
                {v.author === "user" ? "You" : "Sush"} · {relativeTime(v.at)}
                {v.number === latest?.number ? " · current" : ""}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- the side panel -------------------------------------------------------------------

interface DocPanelProps {
  threadId: string;
  docId: string;
  /** The newest `doc_write` call for this doc in the chat. */
  call?: DocCall;
}

export function DocPanel({ threadId, docId, call }: DocPanelProps) {
  const state = useDocPanel(threadId);
  const doc = useDoc(docId);
  const { panel: width } = useLayout();
  const ref = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const expanded = !!state?.expanded;
  const writing = call?.streaming ? call : undefined;
  const [preview, setPreview] = useState<DocVersion | null>(null);
  const { textInput } = usePromptInputController();

  // A new version (or another doc) leaves an older one being looked at.
  useEffect(() => setPreview(null), [docId, doc?.versions.at(-1)?.number]);

  // Ask about a passage: it goes into the composer as a quote, ready for the question.
  const ask = (selection: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    const quote = selection
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const title = doc?.title ?? "the doc";
    const text = `In "${title}":\n${quote}\n\n`;
    textInput.setInput(text);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(text.length, text.length);
    });
  };

  const title = writing?.title ?? doc?.title ?? "Doc";

  return (
    <aside
      ref={ref}
      aria-label={`${title} doc`}
      className={cn(
        "relative flex min-w-[320px] shrink-0 flex-col p-2",
        expanded ? "flex-1" : "max-w-[calc(100%-360px)] pl-0",
        !expanded && width === null && "w-[56%] max-w-[min(1100px,calc(100%-360px))]",
      )}
      style={expanded || width === null ? undefined : { width }}
    >
      {!expanded && (
        <ResizeHandle
          label="Resize doc panel"
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
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-3">
          {doc && !writing ? (
            <VersionsMenu doc={doc} preview={preview} onPreview={setPreview} />
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 px-2 text-sm font-medium">
              <DocIcon icon={writing?.icon} className="size-4 text-base" />
              <span className="truncate">{title}</span>
            </span>
          )}
          <div className="flex-1" />
          {doc && <OutlineMenu doc={doc} scroller={scroller} />}
          {doc && <ShareMenu doc={doc} disabled={!!writing} />}
          <IconButton label={expanded ? "Show the chat" : "Expand"} onClick={() => setDocExpanded(threadId, !expanded)}>
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </IconButton>
          <IconButton label="Close" onClick={() => closeDoc(threadId)}>
            <XIcon />
          </IconButton>
        </header>
        <DocBody doc={doc} writing={writing} fallback={call} preview={preview} onLeavePreview={() => setPreview(null)} onAsk={ask} scrollRef={scroller} />
      </section>
    </aside>
  );
}
