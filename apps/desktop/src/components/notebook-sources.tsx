// Adding and choosing a notebook's sources: the "Add sources" pop-up (find
// sources on the web, upload or drop files, links and papers, pasted text),
// and, in a notebook's chat, the composer's `+` menu and the strip under it,
// which speak about sources instead of folders, skills and connectors.

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ClipboardTypeIcon,
  FileTextIcon,
  AudioLinesIcon,
  FileCodeIcon,
  FolderOpenIcon,
  GlobeIcon,
  GraduationCapIcon,
  LinkIcon,
  LibraryIcon,
  MessagesSquareIcon,
  MonitorPlayIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Label, MENU_CONTENT, MENU_TRIGGER, Section, useComposerSpan } from "@/components/composer-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuShortcut } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { openSettings } from "@/lib/library";
import { addAudioFiles, AUDIO_ACCEPT, isAudioFile } from "@/lib/notebook-audio";
import {
  addDroppedFiles,
  addFiles,
  addLink,
  addText,
  closeAddSources,
  openAddSources,
  setAllChecked,
  setSourceChecked,
  useAddSources,
  useNotebookThreads,
  type AddView,
} from "@/lib/notebooks";
import { formatWhen } from "@/lib/automations";
import { useReportThreads } from "@/lib/reports";
import { useConversations } from "@/lib/store";
import { useWorkspaces } from "@/lib/workspaces";
import { toast } from "sonner";
import { api, errorMessage, type Notebook, type NotebookSource, type SourceKind, type WebKeySource, type WebSearchResult } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- shared bits ---------------------------------------------------------------------

export const KIND_LABEL: Record<SourceKind, string> = {
  pdf: "PDF",
  web: "Web page",
  paper: "Paper",
  text: "Text",
  youtube: "YouTube",
  audio: "Audio",
  chat: "Past chat",
  file: "File",
};

export const sourceCount = (n: number) => (n === 1 ? "1 source" : `${n} sources`);

/** A ready source's kind and size, e.g. "PDF · 12 pages". */
export function describe(s: NotebookSource): string {
  const size = s.pages ? `${s.pages} ${s.pages === 1 ? "page" : "pages"}` : `${Math.max(1, Math.round(s.chars / 1000))}k characters`;
  return `${KIND_LABEL[s.kind]} · ${size}${s.truncated ? " · only the start was read" : ""}`;
}

/** A source's state in a few words: its size once read, else reading or why it failed. */
export function sourceState(s: NotebookSource): string {
  if (s.status === "reading") return "Reading…";
  if (s.status === "failed") return s.error ?? "Couldn’t read it";
  return describe(s);
}

export function KindIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const Icon = {
    web: GlobeIcon,
    paper: GraduationCapIcon,
    pdf: FileTextIcon,
    text: ClipboardTypeIcon,
    youtube: MonitorPlayIcon,
    audio: AudioLinesIcon,
    chat: MessagesSquareIcon,
    file: FileCodeIcon,
  }[kind];
  return <Icon aria-hidden className={className} />;
}

const isYoutube = (line: string) =>
  /^(?:https?:\/\/)?(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{11}/i.test(line);

/** Whether a link reads as a paper (an arXiv id or link, or a DOI), as `notebooks::paper_url` decides. */
const isPaper = (line: string) =>
  /^(?:https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*)\S+$|^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(line) ||
  /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/\S+$/i.test(line);

/** Dropped files as sources: audio is transcribed, the rest read. Returns how many were taken. */
async function addDropped(notebookId: string, files: File[]): Promise<number> {
  const audio = files.filter(isAudioFile);
  if (audio.length) void addAudioFiles(notebookId, audio);
  const rest = files.filter((f) => !isAudioFile(f));
  return audio.length + (rest.length ? await addDroppedFiles(notebookId, rest) : 0);
}

/**
 * Files dropped on `target` become sources. Stops the drop there, so the
 * composer (which takes drops anywhere) doesn't attach them to a message too.
 * Returns whether files are being dragged over it.
 */
export function useSourceDrop(target: RefObject<HTMLElement | null>, notebookId: string, shown = true): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const dropped = [...(e.dataTransfer?.files ?? [])];
      if (dropped.length) void addDropped(notebookId, dropped);
    };
    el.addEventListener("dragenter", enter);
    el.addEventListener("dragover", enter);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragenter", enter);
      el.removeEventListener("dragover", enter);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
    // `shown`: the element comes and goes (a panel that opens and closes), so listen again each time.
  }, [target, notebookId, shown]);
  return over;
}

// --- the "Add sources" pop-up --------------------------------------------------------

/** Rendered once by the open notebook; anything can open it with `openAddSources`. */
export function AddSourcesDialog({ notebook }: { notebook: Notebook }) {
  const request = useAddSources();
  const open = request?.notebookId === notebook.id;
  const [view, setView] = useState<AddView>("home");
  const [query, setQuery] = useState("");

  // Each opening starts where it was asked to.
  useEffect(() => {
    if (!request || request.notebookId !== notebook.id) return;
    setView(request.view);
    if (request.query !== undefined) setQuery(request.query);
  }, [request, notebook.id]);

  const done = () => {
    closeAddSources();
    setView("home");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && done()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {view === "home" && <Home notebook={notebook} query={query} setQuery={setQuery} onView={setView} onDone={done} />}
        {view === "search" && <SearchResults notebook={notebook} query={query} setQuery={setQuery} onBack={() => setView("home")} onDone={done} />}
        {view === "link" && <AddLinks notebook={notebook} onBack={() => setView("home")} onDone={done} />}
        {view === "text" && <AddText notebook={notebook} onBack={() => setView("home")} onDone={done} />}
        {view === "chat" && <AddChats notebook={notebook} onBack={() => setView("home")} onDone={done} />}
        {view === "folder" && <AddFolderFiles notebook={notebook} onBack={() => setView("home")} onDone={done} />}
      </DialogContent>
    </Dialog>
  );
}

function useWebKey(): WebKeySource | null {
  const [key, setKey] = useState<WebKeySource | null>(null);
  useEffect(() => {
    api.webKeyStatus().then(setKey, () => setKey("none"));
  }, []);
  return key;
}

function Home({
  notebook,
  query,
  setQuery,
  onView,
  onDone,
}: {
  notebook: Notebook;
  query: string;
  setQuery: (q: string) => void;
  onView: (v: AddView) => void;
  onDone: () => void;
}) {
  const key = useWebKey();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const zone = useRef<HTMLDivElement>(null);

  // Drops land here as sources; stop them reaching the composer, which would attach them to a message.
  useEffect(() => {
    const el = zone.current?.closest<HTMLElement>("[role=dialog]");
    if (!el) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      const files = [...(e.dataTransfer.files ?? [])];
      if (files.length === 0) return;
      setUploading(true);
      const added = await addDropped(notebook.id, files);
      setUploading(false);
      if (added > 0) onDone();
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, [notebook.id, onDone]);

  const upload = async () => {
    const added = await addFiles(notebook.id);
    if (added && added.length > 0) onDone();
  };
  const audioInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <DialogHeader className="px-6 pt-6">
        <DialogTitle>Add sources</DialogTitle>
        <DialogDescription>Sush reads each source, and answers in this notebook cite the passages they use.</DialogDescription>
      </DialogHeader>

      <form
        className="mx-6 mt-5 flex items-center gap-2 rounded-xl border bg-card py-1 pr-1 pl-3 focus-within:ring-2 focus-within:ring-brand/40"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim() && key !== "none") onView("search");
        }}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find sources on the web: a topic, a question, a paper’s title"
          aria-label="Find sources on the web"
          disabled={key === "none"}
          className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button type="submit" size="icon-sm" aria-label="Search" disabled={!query.trim() || key === "none"}>
          <ArrowRightIcon />
        </Button>
      </form>
      {key === "none" && (
        <p className="mx-6 mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          Web search needs an Ollama key.
          <Button
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => {
              onDone();
              openSettings({ section: "search" });
            }}
          >
            Set it up in Settings
          </Button>
        </p>
      )}

      <div className="mx-6 mt-4 grid gap-2 sm:grid-cols-3">
        <Tile icon={<UploadIcon />} title="Upload files" hint="PDFs, text and Markdown" onClick={() => void upload()} />
        <Tile icon={<LinkIcon />} title="Links and videos" hint="Web, YouTube, arXiv, DOIs" onClick={() => onView("link")} />
        <Tile icon={<ClipboardTypeIcon />} title="Paste text" hint="Notes, transcripts, emails" onClick={() => onView("text")} />
        <Tile icon={<AudioLinesIcon />} title="Audio" hint="Recordings, transcribed" onClick={() => audioInput.current?.click()} />
        <Tile icon={<MessagesSquareIcon />} title="Past chat" hint="A Sush conversation" onClick={() => onView("chat")} />
        <Tile icon={<FolderOpenIcon />} title="Cowork folder" hint="Files from your folders" onClick={() => onView("folder")} />
      </div>
      <input
        ref={audioInput}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length === 0) return;
          void addAudioFiles(notebook.id, files);
          onDone();
        }}
      />

      <div
        ref={zone}
        className={cn(
          "mx-6 mt-4 mb-6 flex flex-col items-center gap-1 rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
          dragging ? "border-brand bg-brand/5" : "border-border",
        )}
      >
        {uploading ? (
          <>
            <Spinner />
            <p className="text-sm text-muted-foreground">Adding…</p>
          </>
        ) : (
          <>
            <UploadIcon className={cn("size-5", dragging ? "text-brand" : "text-muted-foreground")} aria-hidden />
            <p className="text-sm font-medium">{dragging ? "Drop to add" : "Drop files here"}</p>
            <p className="text-xs text-muted-foreground">PDFs, text, Markdown and audio</p>
          </>
        )}
      </div>
    </>
  );
}

function Tile({ icon, title, hint, onClick }: { icon: ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors outline-none hover:border-brand/40 hover:bg-brand/5 focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

/** A sub-view's heading with a way back. */
function SubHeader({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  return (
    <DialogHeader className="px-6 pt-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" className="-ml-2" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <DialogTitle>{title}</DialogTitle>
      </div>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  );
}

function SearchResults({
  notebook,
  query,
  setQuery,
  onBack,
  onDone,
}: {
  notebook: Notebook;
  query: string;
  setQuery: (q: string) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(query);
  const [results, setResults] = useState<WebSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const have = new Set(notebook.sources.flatMap((s) => (s.url ? [s.url] : [])));

  useEffect(() => {
    let live = true;
    setResults(null);
    setError(null);
    setPicked(new Set());
    api
      .webSearch(query, 10)
      .then((r) => live && setResults(r))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [query]);

  const toggle = (url: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const add = async () => {
    setAdding(true);
    for (const url of picked) await addLink(notebook.id, url);
    setAdding(false);
    onDone();
  };

  return (
    <>
      <SubHeader title="Find sources" description="Pick the pages to add. Sush reads each one in full." onBack={onBack} />
      <form
        className="mx-6 mt-4 flex items-center gap-2 rounded-xl border bg-card py-1 pr-1 pl-3 focus-within:ring-2 focus-within:ring-brand/40"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setQuery(draft.trim());
        }}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Find sources on the web"
          className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button type="submit" size="icon-sm" variant="ghost" aria-label="Search again" disabled={!draft.trim()}>
          <ArrowRightIcon />
        </Button>
      </form>
      <div className="mt-3 max-h-[min(24rem,50vh)] min-h-32 overflow-y-auto px-3">
        {error ? (
          <p className="px-3 py-6 text-sm text-destructive">{error}</p>
        ) : !results ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status">
            <Spinner /> Searching the web…
          </div>
        ) : results.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">Nothing found. Try other words.</p>
        ) : (
          <ul className="flex flex-col py-1">
            {results.map((r) => {
              const added = have.has(r.url);
              return (
                <li key={r.url}>
                  <label
                    className={cn(
                      "flex gap-3 rounded-lg px-3 py-2.5",
                      added ? "opacity-60" : "cursor-pointer hover:bg-muted/60",
                      picked.has(r.url) && "bg-brand/5",
                    )}
                  >
                    <Checkbox className="mt-0.5" checked={added || picked.has(r.url)} disabled={added} onCheckedChange={() => toggle(r.url)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="line-clamp-1 text-sm font-medium">{r.title || r.url}</span>
                        {added && <span className="shrink-0 text-xs text-muted-foreground">Added</span>}
                      </span>
                      <span className="block truncate text-xs text-brand">{host(r.url)}</span>
                      {r.snippet && <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.snippet}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DialogFooter className="border-t px-6 py-4">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button disabled={picked.size === 0 || adding} onClick={() => void add()}>
          {adding ? <Spinner /> : <PlusIcon />} {picked.size > 1 ? `Add ${picked.size} sources` : "Add source"}
        </Button>
      </DialogFooter>
    </>
  );
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function AddLinks({ notebook, onBack, onDone }: { notebook: Notebook; onBack: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = [...new Set(text.split(/\s+/).filter(Boolean))];
  const submit = async () => {
    if (lines.length === 0) return;
    setBusy(true);
    for (const line of lines) await addLink(notebook.id, line);
    setBusy(false);
    onDone();
  };
  return (
    <>
      <SubHeader
        title="Links and videos"
        description="One per line: web pages, links to PDFs, YouTube videos (read from their captions), arXiv ids or links, and DOIs."
        onBack={onBack}
      />
      <form
        className="px-6 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={"https://example.com/article\nhttps://youtu.be/…\n2401.12345\n10.1038/nature14539"}
          aria-label="Links"
          className="min-h-28 resize-none font-mono text-sm"
        />
        {lines.length > 0 && (
          <ul className="mt-3 flex max-h-32 flex-col gap-1 overflow-y-auto" aria-label="Will be added">
            {lines.map((l) => (
              <li key={l} className="flex items-center gap-2 text-xs">
                <KindIcon kind={isYoutube(l) ? "youtube" : isPaper(l) ? "paper" : "web"} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">{l}</span>
                <span className="shrink-0 text-muted-foreground">{isYoutube(l) ? "YouTube video" : isPaper(l) ? "Paper" : "Web page"}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter className="-mx-6 mt-5 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={lines.length === 0 || busy}>
            {busy ? <Spinner /> : <PlusIcon />} {lines.length > 1 ? `Add ${lines.length} sources` : "Add source"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function AddText({ notebook, onBack, onDone }: { notebook: Notebook; onBack: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const added = await addText(notebook.id, title, text);
    setBusy(false);
    if (added) onDone();
  };
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <>
      <SubHeader title="Paste text" description="Notes, a transcript, an email, an article’s text. It stays with this notebook." onBack={onBack} />
      <form
        className="flex flex-col gap-3 px-6 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" />
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the text here"
          aria-label="Text"
          className="max-h-[45vh] min-h-48 text-sm"
        />
        <p className="text-xs text-muted-foreground">{words > 0 ? `${words.toLocaleString()} words` : "Without a title, its first words name it."}</p>
        <DialogFooter className="-mx-6 mt-2 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={!text.trim() || busy}>
            {busy ? <Spinner /> : <PlusIcon />} Add source
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** Pick past Sush chats to add, as transcripts. */
function AddChats({ notebook, onBack, onDone }: { notebook: Notebook; onBack: () => void; onDone: () => void }) {
  const conversations = useConversations();
  const notebookThreads = useNotebookThreads();
  const reportThreads = useReportThreads();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const chats = conversations
    .filter((c) => c.messages.length > 0 && !c.incognito && !c.parentId && !notebookThreads.has(c.id) && !reportThreads.has(c.id))
    .filter((c) => !query.trim() || c.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100);
  const toggle = (id: string) => setPicked((p) => toggled(p, id));
  const add = async () => {
    setBusy(true);
    for (const id of picked) {
      try {
        await api.notebookAddChat(notebook.id, id);
      } catch (e) {
        toast.error("Couldn’t add that chat", { description: errorMessage(e) });
      }
    }
    setBusy(false);
    onDone();
  };
  return (
    <>
      <SubHeader title="Past chats" description="A chat is added as its transcript as it is now; later messages aren’t." onBack={onBack} />
      <div className="mx-6 mt-4">
        <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a chat by title" aria-label="Find a chat" />
      </div>
      <PickList
        empty={query ? "No chats match." : "No past chats yet."}
        items={chats.map((c) => ({ id: c.id, title: c.title, detail: formatWhen(new Date(c.updatedAt)) }))}
        picked={picked}
        onToggle={toggle}
      />
      <DialogFooter className="border-t px-6 py-4">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button disabled={picked.size === 0 || busy} onClick={() => void add()}>
          {busy ? <Spinner /> : <PlusIcon />} {picked.size > 1 ? `Add ${picked.size} chats` : "Add chat"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Pick files from a Cowork folder, found by name. */
function AddFolderFiles({ notebook, onBack, onDone }: { notebook: Notebook; onBack: () => void; onDone: () => void }) {
  const workspaces = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .workspaceFind(workspaceId, query.trim())
        .then((found) => live && setPaths(found.slice(0, 200)))
        .catch(() => live && setPaths([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, query]);

  const add = async () => {
    setBusy(true);
    for (const path of picked) {
      try {
        await api.notebookAddWorkspaceFile(notebook.id, workspaceId, path);
      } catch (e) {
        toast.error(`Couldn’t add ${path}`, { description: errorMessage(e) });
      }
    }
    setBusy(false);
    onDone();
  };

  if (workspaces.length === 0) {
    return (
      <>
        <SubHeader title="Cowork folder" description="Add files from a folder you work in with Cowork." onBack={onBack} />
        <p className="mx-6 my-8 text-sm text-muted-foreground">No folders yet. Add one from Folders in the sidebar, then come back.</p>
      </>
    );
  }
  return (
    <>
      <SubHeader title="Cowork folder" description="Files are copied in as they are now. Files that look like secrets are left out." onBack={onBack} />
      <div className="mx-6 mt-4 flex gap-2">
        <select
          value={workspaceId}
          onChange={(e) => {
            setWorkspaceId(e.target.value);
            setPicked(new Set());
            setPaths(null);
          }}
          aria-label="Folder"
          className="h-9 max-w-48 shrink-0 rounded-md border bg-background px-2 text-sm"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find files by name" aria-label="Find files" />
      </div>
      {paths === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <PickList
          empty={query ? "No files match." : "Type to find files."}
          items={paths.map((p) => ({ id: p, title: p.split("/").pop() ?? p, detail: p }))}
          picked={picked}
          onToggle={(path) => setPicked((p) => toggled(p, path))}
          mono
        />
      )}
      <DialogFooter className="border-t px-6 py-4">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button disabled={picked.size === 0 || busy} onClick={() => void add()}>
          {busy ? <Spinner /> : <PlusIcon />} {picked.size > 1 ? `Add ${picked.size} files` : "Add file"}
        </Button>
      </DialogFooter>
    </>
  );
}

const toggled = (set: Set<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** A checklist of things to add. */
function PickList({
  items,
  picked,
  onToggle,
  empty,
  mono,
}: {
  items: { id: string; title: string; detail?: string }[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  empty: string;
  mono?: boolean;
}) {
  if (items.length === 0) return <p className="mx-6 my-8 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="mt-3 flex max-h-[min(22rem,45vh)] flex-col overflow-y-auto px-3 py-1">
      {items.map((it) => (
        <li key={it.id}>
          <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/60", picked.has(it.id) && "bg-brand/5")}>
            <Checkbox checked={picked.has(it.id)} onCheckedChange={() => onToggle(it.id)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{it.title}</span>
              {it.detail && <span className={cn("block truncate text-xs text-muted-foreground", mono && "font-mono")}>{it.detail}</span>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

// --- in a notebook's chat ------------------------------------------------------------

/**
 * The composer's `+` menu in a notebook chat: ways to add sources, which
 * sources answers use, and attaching a file to just this message. Research,
 * memory, skills and connectors don't apply here, since the chat answers from its sources.
 */
export function NotebookComposerMenu({ notebook, onOpenSettings }: { notebook: Notebook; onOpenSettings: () => void }) {
  const { attachments } = usePromptInputController();
  const { anchor, geo, measure } = useComposerSpan();
  const sources = notebook.sources;
  const all = sources.length > 0 && sources.every((s) => s.checked);
  const some = sources.some((s) => s.checked);
  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <PromptInputActionMenu onOpenChange={measure}>
      <span ref={anchor} className="inline-flex">
        <PromptInputActionMenuTrigger aria-label="Sources and attachments" className={MENU_TRIGGER}>
          <PlusIcon className="size-4" />
        </PromptInputActionMenuTrigger>
      </span>
      <PromptInputActionMenuContent
        side="top"
        align="start"
        alignOffset={geo?.alignOffset ?? 0}
        sideOffset={geo?.sideOffset ?? 8}
        style={geo ? { width: geo.width } : undefined}
        className={MENU_CONTENT}
      >
        <Section first>Add sources</Section>
        <PromptInputActionMenuItem onSelect={() => void addFiles(notebook.id)}>
          <UploadIcon /> <Label hint="PDFs, text and Markdown">Files</Label>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => openAddSources(notebook.id, "link")}>
          <LinkIcon /> <Label hint="Web, YouTube, arXiv, DOIs">Links and videos</Label>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => openAddSources(notebook.id, "chat")}>
          <MessagesSquareIcon /> <Label hint="A Sush conversation">Past chat</Label>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => openAddSources(notebook.id, "folder")}>
          <FolderOpenIcon /> <Label hint="Files from your Cowork folders">Cowork folder</Label>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => openAddSources(notebook.id, "text")}>
          <ClipboardTypeIcon /> <Label hint="Notes, transcripts, emails">Paste text</Label>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => openAddSources(notebook.id, "home")}>
          <GlobeIcon /> <Label hint="Search for sources, or add audio">More ways to add…</Label>
        </PromptInputActionMenuItem>

        <Section>Answers use</Section>
        {sources.length === 0 ? (
          <p className="px-2 py-1.5 text-[13px] text-muted-foreground">No sources yet. Add some above.</p>
        ) : (
          <>
            <DropdownMenuCheckboxItem
              checked={all ? true : some ? "indeterminate" : false}
              onCheckedChange={(on) => void setAllChecked(notebook, on === true)}
              onSelect={keepOpen}
            >
              <LibraryIcon /> <Label hint={`${sources.filter((s) => s.checked).length} of ${sourceCount(sources.length)}`}>Every source</Label>
            </DropdownMenuCheckboxItem>
            {sources.map((s) => (
              <DropdownMenuCheckboxItem key={s.id} checked={s.checked} onCheckedChange={(on) => void setSourceChecked(s, on)} onSelect={keepOpen}>
                <KindIcon kind={s.kind} />
                <Label hint={sourceState(s)}>
                  <span className="block max-w-64 truncate">{s.title}</span>
                </Label>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}

        <Section>This message</Section>
        <PromptInputActionMenuItem onSelect={() => attachments.openFileDialog()}>
          <PaperclipIcon /> <Label hint="Read with this message only, not kept as a source">Attach a file</Label>
          <DropdownMenuShortcut>Ctrl+U</DropdownMenuShortcut>
        </PromptInputActionMenuItem>

        <DropdownMenuSeparator />
        <PromptInputActionMenuItem onSelect={onOpenSettings}>
          <SettingsIcon /> <Label hint="Models and API keys">Manage providers</Label>
        </PromptInputActionMenuItem>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
}

const CHIP =
  "flex h-6 max-w-64 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground/80 cursor-pointer transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-white/10";

/** The strip under a notebook chat's composer: how many sources answers use, and a way to add more. */
export function NotebookComposerDock({ notebook }: { notebook: Notebook }) {
  const checked = notebook.sources.filter((s) => s.checked);
  const ready = checked.filter((s) => s.status === "ready").length;
  const reading = checked.filter((s) => s.status === "reading").length;
  return (
    <div className="relative -mt-3 mr-1 ml-1 flex items-center justify-between gap-3 rounded-b-2xl border border-t-0 border-foreground/15 bg-card px-2 pt-4 pb-1.5 dark:border-white/15 dark:bg-card">
      <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground" aria-live="polite">
        <LibraryIcon className="size-3.5 shrink-0 text-brand" aria-hidden />
        <span className="truncate">
          {notebook.sources.length === 0
            ? "No sources yet"
            : `Answers use ${ready} of ${sourceCount(notebook.sources.length)}${reading ? ` · ${reading} reading` : ""}`}
        </span>
        {reading > 0 && <Spinner className="size-3" />}
        {reading === 0 && ready > 0 && ready === notebook.sources.length && <CheckIcon className="size-3 text-brand" aria-hidden />}
      </span>
      <button type="button" className={cn(CHIP, "ml-auto")} onClick={() => openAddSources(notebook.id)}>
        <PlusIcon className="size-3.5" aria-hidden /> Add sources
      </button>
    </div>
  );
}
