// Word files in a chat (lib/files.ts): the attachment chip and `docx_edit` card that open
// them, and the side panel that shows a version as pages, with the version history and a
// download. Pages are laid out by Word or LibreOffice into a PDF in Rust (`docx_pdf`) and drawn
// with pdf.js; without either, docx-preview draws an approximation in HTML, from a copy adjusted
// for what it draws differently from Word (lib/docx-preview-fixups.ts).

import type { DynamicToolUIPart } from "ai";
import { ChevronDownIcon, DownloadIcon, FileTextIcon, Loader2Icon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ToolResultRow } from "@/components/tool-approval-card";
import { FileChip } from "@/components/tool-parts";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  closeFile,
  downloadFile,
  fileBytes,
  fileKey,
  openFile,
  setFileExpanded,
  setFileVersion,
  useFilePanel,
  type FileVersion,
} from "@/lib/files";
import { PANEL, setLayout, useLayout } from "@/lib/layout";
import { api, errorMessage } from "@/lib/tauri";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { BackCloses } from "@/lib/back";
import { cn } from "@/lib/utils";

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

async function download(v: FileVersion) {
  try {
    await downloadFile(v);
  } catch (e) {
    toast.error(`Couldn’t save ${v.name}`, { description: errorMessage(e) });
  }
}

// --- in the chat ----------------------------------------------------------------------

/** An attached Word file: opens it beside the chat. */
export function FileAttachment({ threadId, name, mediaType, version }: { threadId: string; name: string; mediaType: string; version?: FileVersion }) {
  if (!version) return <FileChip name={name} mediaType={mediaType} />;
  return (
    <button
      type="button"
      onClick={() => openFile(threadId, name, version.number)}
      aria-label={`Open ${name}`}
      className="rounded-lg outline-none transition-opacity hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <FileChip name={name} mediaType={mediaType} />
    </button>
  );
}

/** A `docx_edit` call: the version it made, to open beside the chat. */
export function FileEditCard({ threadId, part, version }: { threadId: string; part: DynamicToolUIPart; version?: FileVersion }) {
  const panel = useFilePanel(threadId);
  const name = String((part.input as { file?: unknown } | undefined)?.file ?? "the document");
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <FileTextIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't edit {name}</span>
          </>
        }
      />
    );
  }
  if (part.state !== "output-available") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Editing {name}…
      </div>
    );
  }
  if (!version) return null;
  const shown = panel?.key === fileKey(version.name) && (panel.version === null || panel.version === version.number);
  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card p-2.5 pr-3">
      <button
        type="button"
        onClick={() => openFile(threadId, version.name, version.number)}
        aria-label={`Open ${version.name}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <FileTextIcon className="size-5 text-blue-600 dark:text-blue-400" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{version.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          Word · v{version.number} · {version.note}
        </p>
      </div>
      <IconButton label="Download" onClick={() => void download(version)}>
        <DownloadIcon />
      </IconButton>
      <Button variant="secondary" onClick={() => (shown ? closeFile(threadId) : openFile(threadId, version.name, version.number))} className="min-w-16">
        {shown ? "Hide" : "Open"}
      </Button>
    </div>
  );
}

// --- the side panel -------------------------------------------------------------------

function VersionsMenu({ threadId, versions, shown }: { threadId: string; versions: FileVersion[]; shown: FileVersion }) {
  const latest = versions[versions.length - 1];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 gap-1.5 px-2 text-sm font-medium">
          <FileTextIcon className="size-4 text-blue-600 dark:text-blue-400" />
          <span className="truncate">{shown.name}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">v{shown.number}</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        <DropdownMenuLabel>Version history</DropdownMenuLabel>
        {[...versions].reverse().map((v) => {
          const current = v.number === latest.number;
          return (
            <DropdownMenuItem key={v.number} onSelect={() => setFileVersion(threadId, current ? null : v.number)} className="items-start">
              <span className="w-8 shrink-0 font-medium tabular-nums">v{v.number}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{v.note}</span>
                <span className="block text-xs text-muted-foreground">
                  {v.callId ? "Edited by Sush" : "Attached by you"}
                  {current ? " · current" : ""}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Layout = { kind: "laying-out" } | { kind: "pdf"; data: Uint8Array } | { kind: "approximate"; why: string };

/**
 * A version's pages: laid out by Word or LibreOffice into a PDF (exact, as other AI apps preview
 * Office files), else drawn in HTML by docx-preview (approximate), with a note saying so.
 */
function Pages({ version }: { version: FileVersion }) {
  const [layout, setLayout] = useState<Layout>({ kind: "laying-out" });

  useEffect(() => {
    let cancelled = false;
    setLayout({ kind: "laying-out" });
    void (async () => {
      let next: Layout;
      try {
        const result = await api.docxPdf(version.url);
        next = result.url
          ? { kind: "pdf", data: await fileBytes(result.url) }
          : {
              kind: "approximate",
              why: result.noEngine
                ? "Approximate preview. Install Microsoft Word or LibreOffice to see the exact pages."
                : `Approximate preview: the exact pages couldn't be made (${result.error ?? "unknown error"}).`,
            };
      } catch (e) {
        next = { kind: "approximate", why: `Approximate preview: the exact pages couldn't be made (${errorMessage(e)}).` };
      }
      if (!cancelled) setLayout(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [version.url]);

  if (layout.kind === "laying-out") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 rounded-xl bg-muted text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Laying out {version.name}…
      </div>
    );
  }
  if (layout.kind === "pdf") return <PdfPages data={layout.data} name={version.name} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground">{layout.why}</p>
      <HtmlPages version={version} />
    </div>
  );
}

/** PDF pages drawn with pdf.js, scaled to the panel's width and redrawn sharp when it changes. */
function PdfPages({ data, name }: { data: Uint8Array; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let doc: PDFDocumentProxy | null = null;
    let drawing = 0;
    let lastWidth = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const draw = async () => {
      if (!doc) return;
      const width = Math.max(200, el.clientWidth - 32);
      if (width === lastWidth) return;
      lastWidth = width;
      const turn = ++drawing;
      const dpr = window.devicePixelRatio || 1;
      const pages: HTMLCanvasElement[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (turn !== drawing) return;
        const natural = page.getViewport({ scale: 1 });
        // Fit the width, but don't blow a page up past 1.6× its printed size.
        const scale = Math.min(width / natural.width, 1.6);
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        canvas.className = "mx-auto mb-4 block bg-white shadow-md";
        canvas.setAttribute("aria-label", `${name}, page ${n} of ${doc.numPages}`);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
        if (turn !== drawing) return;
        pages.push(canvas);
      }
      el.replaceChildren(...pages);
    };

    void (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        // pdf.js takes ownership of the buffer it's given, so it gets a copy.
        doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, useSystemFonts: true }).promise;
        await draw();
      } catch (e) {
        setError(errorMessage(e));
      }
    })();

    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void draw(), 150);
    });
    observer.observe(el);
    return () => {
      drawing++;
      clearTimeout(timer);
      observer.disconnect();
      void doc?.destroy();
    };
  }, [data, name]);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-muted p-4">
      {error ? (
        <p className="p-8 text-center text-sm text-muted-foreground">Couldn't show {name}: {error}</p>
      ) : (
        <div ref={host} />
      )}
    </div>
  );
}

/** The approximate pages: docx-preview's HTML, from a copy adjusted for what it draws differently. */
function HtmlPages({ version }: { version: FileVersion }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const [bytes, { renderAsync }, { previewFixups }] = await Promise.all([
          fileBytes(version.url),
          import("docx-preview"),
          import("@/lib/docx-preview-fixups"),
        ]);
        const shown = await previewFixups(bytes);
        if (cancelled || !host.current) return;
        host.current.innerHTML = "";
        await renderAsync(shown, host.current, undefined, {
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          // Fonts and images inline, so nothing needs a blob: URL.
          ignoreFonts: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          // Lays tabs out on the paragraph's tab stops (default ones too), so text pushed right with
          // tabs, like a résumé's dates, lands where Word puts it.
          experimental: true,
        });
        // Tab stops are measured 500ms after rendering, at full size; scaling the pages to fit
        // waits for that, since measuring scaled pages puts tabs in the wrong place.
        await new Promise((resolve) => setTimeout(resolve, 650));
        if (!cancelled) setState("ready");
      } catch (e) {
        if (!cancelled) setState({ error: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version.url]);

  // Pages are drawn at their real size; scale them down to fit the panel.
  useEffect(() => {
    const el = host.current;
    if (!el || state !== "ready") return;
    const fit = () => {
      const wrapper = el.querySelector<HTMLElement>(".docx-wrapper");
      const page = wrapper?.querySelector<HTMLElement>("section");
      if (!wrapper || !page) return;
      wrapper.style.zoom = "1";
      const available = el.clientWidth - 32;
      const zoom = Math.min(1, available / page.offsetWidth);
      wrapper.style.zoom = String(zoom);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state]);

  return (
    <div className="relative min-h-0 flex-1 overflow-auto rounded-xl bg-muted">
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> Opening {version.name}…
        </div>
      )}
      {typeof state === "object" && (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
          <p>Couldn't show {version.name}.</p>
          <p className="text-xs">{state.error}</p>
        </div>
      )}
      <div
        ref={host}
        className={cn(
          "[&_.docx-wrapper]:bg-transparent! [&_.docx-wrapper]:p-4! [&_.docx-wrapper>section.docx]:mb-4! [&_.docx-wrapper>section.docx]:shadow-md!",
          state !== "ready" && "invisible",
        )}
      />
    </div>
  );
}

export function FilePanel({ threadId, versions }: { threadId: string; versions: FileVersion[] }) {
  const state = useFilePanel(threadId);
  const { panel: width } = useLayout();
  const ref = useRef<HTMLElement>(null);
  const expanded = !!state?.expanded;
  const shown = versions.find((v) => v.number === state?.version) ?? versions[versions.length - 1];
  if (!shown) return null;

  return (
    <aside
      ref={ref}
      aria-label={shown.name}
      className={cn(
        "side-panel relative flex min-w-[320px] shrink-0 flex-col p-2",
        expanded ? "flex-1" : "max-w-[calc(100%-360px)] pl-0",
        !expanded && width === null && "w-[56%] max-w-[min(1100px,calc(100%-360px))]",
      )}
      style={expanded || width === null ? undefined : { width }}
    >
      <BackCloses onBack={() => closeFile(threadId)} />
      {!expanded && (
        <ResizeHandle
          label="Resize file panel"
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
          <VersionsMenu threadId={threadId} versions={versions} shown={shown} />
          <span className="hidden truncate text-xs text-muted-foreground md:inline">
            {shown.number === versions.length ? "" : "Older version · "}
            {shown.note}
          </span>
          <div className="flex-1" />
          <IconButton label="Download" onClick={() => void download(shown)}>
            <DownloadIcon />
          </IconButton>
          <IconButton label={expanded ? "Show the chat" : "Expand"} onClick={() => setFileExpanded(threadId, !expanded)}>
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </IconButton>
          <IconButton label="Close" onClick={() => closeFile(threadId)}>
            <XIcon />
          </IconButton>
        </header>
        <Pages version={shown} />
      </section>
    </aside>
  );
}
