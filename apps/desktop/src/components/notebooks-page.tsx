// The Notebooks page: notebooks of sources (PDFs, web pages, papers, pasted
// text) to chat with. A notebook opens as its sources beside a chat whose
// answers cite the passages they rest on; a citation opens its passage in the
// source viewer, with the quoted words marked (`lib/notebooks.ts`).

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  ClipboardTypeIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  NotebookTextIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlayIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { ChatView } from "@/components/chat-view";
import { openShare } from "@/components/session-actions";
import { CoverImage, CustomizeDialog, NotebookOverview, SourceGuideCard } from "@/components/notebook-overview";
import { AddSourcesDialog, describe, KindIcon, sourceCount, useSourceDrop } from "@/components/notebook-sources";
import { NoteReader, StudioPanel } from "@/components/notebook-studio";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderModels } from "@/hooks/use-providers";
import { formatWhen } from "@/lib/automations";
import { generateOverview, overviewDue, sourcesKey } from "@/lib/notebook-guides";
import { closeNote, useOpenNote } from "@/lib/notebook-studio";
import { useAudioJobs } from "@/lib/notebook-audio";
import {
  addFiles,
  closePassage,
  createNotebook,
  deleteNotebook,
  deleteSource,
  getNotebook,
  newNotebookChat,
  openAddSources,
  openSource,
  renameNotebook,
  renameSource,
  retrySource,
  setAllChecked,
  setSourceChecked,
  useNotebooks,
  useOpenPassage,
  type PassageRef,
} from "@/lib/notebooks";
import { sendMessage } from "@/lib/sessions";
import { useConversations, type Conversation } from "@/lib/store";
import { api, errorMessage, type Notebook, type NotebookSource, type Passage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface NotebooksPageProps {
  catalog: ProviderModels[];
  hasProviders: boolean | null;
  onOpenSettings: () => void;
  onOpenSession: (id: string) => void;
}

export function NotebooksPage(props: NotebooksPageProps) {
  const notebooks = useNotebooks();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = notebooks.find((n) => n.id === openId);

  // A citation clicked in another notebook's chat can't open here; close any stale request on the way in.
  useEffect(() => closePassage, [openId]);

  if (open) return <NotebookView key={open.id} notebook={open} onBack={() => setOpenId(null)} {...props} />;
  return <NotebookList notebooks={notebooks} onOpen={setOpenId} />;
}

// --- the list ------------------------------------------------------------------------

function NotebookList({ notebooks, onOpen }: { notebooks: Notebook[]; onOpen: (id: string) => void }) {
  const [creating, setCreating] = useState(false);
  const create = async () => {
    setCreating(true);
    const n = await createNotebook("Untitled notebook");
    setCreating(false);
    if (n) onOpen(n.id);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 pt-12 pb-16">
        <header className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-tight">Notebooks</h1>
            <p className="mt-2 text-muted-foreground">
              Gather PDFs, web pages, papers and notes, then ask about them. Every answer cites the passage it comes from.
            </p>
          </div>
          {notebooks.length > 0 && (
            <Button onClick={() => void create()} disabled={creating}>
              {creating ? <Spinner /> : <PlusIcon />} New notebook
            </Button>
          )}
        </header>
        {notebooks.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl border bg-card">
              <NotebookTextIcon className="size-5 text-muted-foreground" />
            </span>
            <div>
              <p className="font-medium">No notebooks yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                A notebook holds the sources for one topic. Sush reads them, finds the passages that answer your questions, and
                shows you exactly where each claim comes from.
              </p>
            </div>
            <Button className="mt-1" onClick={() => void create()} disabled={creating}>
              {creating ? <Spinner /> : <PlusIcon />} Create a notebook
            </Button>
          </div>
        ) : (
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {notebooks.map((n) => (
              <li key={n.id}>
                <NotebookCard notebook={n} onOpen={() => onOpen(n.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NotebookCard({ notebook, onOpen }: { notebook: Notebook; onOpen: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const kinds = [...new Set(notebook.sources.map((s) => s.kind))];
  return (
    <div className="group relative flex h-full flex-col rounded-xl border bg-card transition-colors hover:border-brand/40">
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col gap-3 rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand">
        {notebook.cover ? (
          <span className="relative -mx-4 -mt-4 block h-24 w-[calc(100%+2rem)] overflow-hidden rounded-t-xl">
            <CoverImage src={notebook.cover} position={notebook.coverPosition} />
          </span>
        ) : null}
        <span className="flex size-9 items-center justify-center rounded-lg bg-brand/10 text-lg text-brand">
          {notebook.emoji ?? <NotebookTextIcon className="size-4" />}
        </span>
        <span className="line-clamp-2 pr-8 font-medium">{notebook.title}</span>
        <span className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            {kinds.slice(0, 3).map((k) => (
              <KindIcon key={k} kind={k} className="size-3.5" />
            ))}
          </span>
          {sourceCount(notebook.sources.length)} · {formatWhen(new Date(notebook.updatedAt))}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label={`Options for ${notebook.title}`}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <PencilIcon /> Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename notebook"
        value={notebook.title}
        onSave={(t) => renameNotebook(notebook.id, t)}
      />
      <DeleteNotebookDialog notebook={notebook} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}

// --- a notebook ----------------------------------------------------------------------

/** Notebooks whose first chat is being made, so a remount doesn't make a second. */
const startingChat = new Set<string>();

function NotebookView({ notebook, onBack, catalog, hasProviders, onOpenSettings, onOpenSession }: NotebooksPageProps & { notebook: Notebook; onBack: () => void }) {
  const conversations = useConversations();
  // Chats whose threads exist: an empty chat isn't saved, so after a restart its id is all that's left.
  const chats = useMemo(() => {
    const byId = new Map(conversations.map((c) => [c.id, c]));
    return notebook.threadIds.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  }, [conversations, notebook.threadIds]);
  const [chatId, setChatId] = useState<string | null>(() => latestChat(chats)?.id ?? null);
  const chat = chats.find((c) => c.id === chatId) ?? latestChat(chats);

  // Always have a chat to type into.
  useEffect(() => {
    if (chats.length > 0 || startingChat.has(notebook.id)) return;
    startingChat.add(notebook.id);
    void newNotebookChat(notebook).then((id) => {
      startingChat.delete(notebook.id);
      if (id) setChatId(id);
    });
  }, [chats.length, notebook]);

  const startChat = async () => {
    const id = await newNotebookChat(notebook);
    if (id) setChatId(id);
  };

  // Narrow windows: the sources and the viewer float over the chat instead of taking columns from it.
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const narrowSources = width < 760;
  const narrowSide = width < 1100;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const showSources = !narrowSources || sourcesOpen;
  const sourcesAside = useRef<HTMLElement>(null);
  const dropping = useSourceDrop(sourcesAside, notebook.id, showSources);

  // The right side: a source (or cited passage) when one is open, else a note, else Studio.
  const passage = useOpenPassage();
  const viewing = passage && notebook.sources.some((s) => s.id === passage.sourceId) ? passage : null;
  const noteId = useOpenNote();
  const note = notebook.notes.find((n) => n.id === noteId);
  const [studioOpen, setStudioOpen] = useState(false);
  const showSide = !narrowSide || studioOpen || !!viewing || !!note;
  // Opening a note shows it rather than a source left open behind it.
  useEffect(() => {
    if (noteId) closePassage();
  }, [noteId]);
  useEffect(() => closeNote, [notebook.id]);

  const [customizing, setCustomizing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Rewrite the overview once the sources settle (none still being read).
  const key = sourcesKey(notebook);
  const due = overviewDue(notebook);
  const settling = notebook.sources.some((s) => s.status === "reading");
  useEffect(() => {
    if (!due || settling) return;
    const timer = setTimeout(() => void generateOverview(getNotebook(notebook.id) ?? notebook), 1200);
    return () => clearTimeout(timer);
    // `key` stands for the sources; the notebook object itself changes on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due, settling, key, notebook.id]);

  return (
    <PromptInputProvider key={chat?.id ?? "none"}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon /> Notebooks
        </Button>
        {narrowSources && (
          <Button variant="ghost" size="icon-sm" aria-label="Sources" aria-pressed={sourcesOpen} onClick={() => setSourcesOpen((v) => !v)}>
            <PanelLeftIcon />
          </Button>
        )}
        <h1 className="flex min-w-0 flex-1 items-center gap-2 px-1 font-medium" title={notebook.title}>
          {notebook.emoji && <span aria-hidden>{notebook.emoji}</span>}
          <span className="truncate">{notebook.title}</span>
        </h1>
        <ChatPicker chats={chats} current={chat} onPick={setChatId} onNew={() => void startChat()} />
        {narrowSide && (
          <Button variant="ghost" size="icon-sm" aria-label="Studio and notes" aria-pressed={showSide} onClick={() => {
            if (showSide) {
              setStudioOpen(false);
              closePassage();
              closeNote();
            } else setStudioOpen(true);
          }}>
            <PanelRightIcon />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Notebook options">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => setTimeout(() => setCustomizing(true))}>
              <PencilIcon /> Customize…
            </DropdownMenuItem>
            {chat && (
              <DropdownMenuItem onSelect={() => onOpenSession(chat.id)}>
                <MessagesSquareIcon /> Open chat in a tab
              </DropdownMenuItem>
            )}
            {chat && (
              // Guests see the chat and its citations; the sources' text only if allowed in the share dialog.
              <DropdownMenuItem disabled={chat.messages.length === 0} onSelect={() => setTimeout(() => openShare(chat.id))}>
                <UsersIcon /> Share this chat live…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2Icon /> Delete notebook
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={body} className="relative flex min-h-0 flex-1">
        {showSources && (
          <aside
            ref={sourcesAside}
            aria-label="Sources"
            className={cn(
              "relative flex w-72 shrink-0 flex-col border-r bg-background",
              narrowSources && "absolute inset-y-0 left-0 z-20 shadow-lg",
            )}
          >
            <SourcesPanel notebook={notebook} activeId={viewing?.sourceId} onClose={narrowSources ? () => setSourcesOpen(false) : undefined} />
            {dropping && (
              <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand bg-brand/5 text-center backdrop-blur-[1px]">
                <UploadIcon className="size-5 text-brand" aria-hidden />
                <p className="text-sm font-medium">Drop to add as sources</p>
                <p className="text-xs text-muted-foreground">PDF, .txt and .md</p>
              </div>
            )}
          </aside>
        )}
        <section aria-label="Chat" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {chat ? (
            <ChatView
              conversation={chat}
              catalog={catalog}
              hasProviders={hasProviders}
              onOpenSettings={onOpenSettings}
              onOpenSession={onOpenSession}
              emptyState={(ask) => <NotebookOverview notebook={notebook} ask={ask} onCustomize={() => setCustomizing(true)} />}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          )}
        </section>
        {showSide && (
          <aside
            aria-label={viewing ? "Source" : note ? "Note" : "Studio"}
            className={cn(
              "flex w-[26rem] max-w-full shrink-0 flex-col border-l bg-background",
              narrowSide && "absolute inset-y-0 right-0 z-20 shadow-lg",
            )}
          >
            {viewing && <SourceViewer notebook={notebook} passage={viewing} />}
            {/* Kept mounted under a passage opened from it, so a quiz or deck in progress isn't lost. */}
            {note && (
              <div className={cn("flex min-h-0 flex-1 flex-col", viewing && "hidden")}>
                <NoteReader key={note.id} notebook={notebook} note={note} onAsk={(text) => chat && sendMessage(chat.id, text, [])} />
              </div>
            )}
            {!viewing && !note && <StudioPanel notebook={notebook} onClose={narrowSide ? () => setStudioOpen(false) : undefined} />}
          </aside>
        )}
      </div>

      <CustomizeDialog notebook={notebook} open={customizing} onOpenChange={setCustomizing} />
      <DeleteNotebookDialog notebook={notebook} open={deleting} onOpenChange={setDeleting} onDeleted={onBack} />
      <AddSourcesDialog notebook={notebook} />
    </div>
    </PromptInputProvider>
  );
}

/** The chat with the latest messages, else the newest. */
function latestChat(chats: Conversation[]): Conversation | undefined {
  return [...chats].sort((a, b) => Number(b.messages.length > 0) - Number(a.messages.length > 0) || b.updatedAt - a.updatedAt)[0];
}

function ChatPicker({ chats, current, onPick, onNew }: { chats: Conversation[]; current?: Conversation; onPick: (id: string) => void; onNew: () => void }) {
  const started = chats.filter((c) => c.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-56">
          <MessagesSquareIcon />
          <span className="truncate">{current && current.messages.length > 0 ? current.title : "New chat"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={onNew}>
          <MessageSquarePlusIcon /> New chat
        </DropdownMenuItem>
        {started.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Chats in this notebook</DropdownMenuLabel>
            {started.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => onPick(c.id)} aria-current={c.id === current?.id ? "true" : undefined}>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(new Date(c.updatedAt))}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- sources -------------------------------------------------------------------------

function SourcesPanel({ notebook, activeId, onClose }: { notebook: Notebook; activeId?: string; onClose?: () => void }) {
  const jobs = useAudioJobs(notebook.id);
  const all = notebook.sources.length > 0 && notebook.sources.every((s) => s.checked);
  const some = notebook.sources.some((s) => s.checked);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="flex-1 text-sm font-medium">Sources</h2>
        <Button variant="outline" size="sm" onClick={() => openAddSources(notebook.id)}>
          <PlusIcon /> Add
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close sources" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      {jobs.length > 0 && (
        <ul className="flex flex-col border-b py-1" aria-label="Audio being transcribed">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-start gap-3 px-4 py-2" role="status">
              <Spinner className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{j.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {j.stage === "decoding" ? "Opening the audio…" : `Transcribing… ${Math.round(j.progress * 100)}%`}
                </span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className="block h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {notebook.sources.length === 0 && jobs.length === 0 ? (
        <div className="flex flex-col gap-1 px-2 py-2">
          <p className="px-2 pb-2 text-sm text-muted-foreground">Nothing here yet. Sources you add are read once and searched for every answer.</p>
          <EmptyAction icon={<UploadIcon />} label="Upload files" hint="PDFs, text, Markdown" onClick={() => void addFiles(notebook.id)} />
          <EmptyAction icon={<LinkIcon />} label="Links and papers" hint="Web pages, arXiv, DOIs" onClick={() => openAddSources(notebook.id, "link")} />
          <EmptyAction icon={<ClipboardTypeIcon />} label="Paste text" hint="Notes, transcripts" onClick={() => openAddSources(notebook.id, "text")} />
          <EmptyAction icon={<GlobeIcon />} label="Find on the web" hint="Search for sources" onClick={() => openAddSources(notebook.id)} />
        </div>
      ) : (
        <>
          <label className="flex items-center gap-3 border-y px-4 py-2 text-xs text-muted-foreground">
            <Checkbox
              checked={all ? true : some ? "indeterminate" : false}
              onCheckedChange={(v) => void setAllChecked(notebook, v === true)}
              aria-label="Use every source"
            />
            <span className="flex-1">Use every source</span>
            <span>{notebook.sources.filter((s) => s.checked).length}/{notebook.sources.length}</span>
          </label>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {notebook.sources.map((s) => (
              <li key={s.id}>
                <SourceRow source={s} active={s.id === activeId} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function EmptyAction({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function SourceRow({ source, active }: { source: NotebookSource; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const status =
    source.status === "reading" ? (
      <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Reading…
      </span>
    ) : source.status === "failed" ? (
      <span className="flex items-start gap-1 text-xs text-destructive">
        <CircleAlertIcon className="mt-px size-3 shrink-0" />
        <span className="line-clamp-2">{source.error ?? "Couldn’t read it."}</span>
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">{describe(source)}</span>
    );
  return (
    <div className={cn("group flex items-start gap-3 px-4 py-2 hover:bg-muted/60", active && "bg-brand/5")}>
      <Checkbox
        className="mt-0.5"
        checked={source.checked}
        onCheckedChange={(v) => void setSourceChecked(source, v === true)}
        aria-label={`Use ${source.title}`}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline disabled:cursor-default"
        disabled={source.status !== "ready"}
        onClick={() => openSource(source.id)}
        title={source.title}
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-sm">
          <KindIcon kind={source.kind} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{source.title}</span>
        </span>
        {status}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            aria-label={`Options for ${source.title}`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <PencilIcon /> Rename
          </DropdownMenuItem>
          {source.url && (
            <DropdownMenuItem onSelect={() => void openUrl(source.url!)}>
              <ExternalLinkIcon /> Open original
            </DropdownMenuItem>
          )}
          {source.status !== "reading" && (
            <DropdownMenuItem onSelect={() => void retrySource(source)}>
              <RotateCcwIcon /> Read again
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => void deleteSource(source)}>
            <Trash2Icon /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog open={renaming} onOpenChange={setRenaming} title="Rename source" value={source.title} onSave={(t) => void renameSource(source, t)} />
    </div>
  );
}

// --- the source viewer ---------------------------------------------------------------

function SourceViewer({ notebook, passage }: { notebook: Notebook; passage: PassageRef & { at: number } }) {
  const source = notebook.sources.find((s) => s.id === passage.sourceId);
  const [passages, setPassages] = useState<Passage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  // Re-read when the source is read again (its chunk count or status changes).
  useEffect(() => {
    let live = true;
    setPassages(null);
    setError(null);
    api
      .notebookSourceText(passage.sourceId)
      .then((t) => live && setPassages(t.passages))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [passage.sourceId, source?.status, source?.chunks]);

  // Bring the cited passage into view each time a citation is clicked, even the same one again.
  // Opening the source itself starts at the top, with its guide.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!passages) return;
    if (passage.chunkId < 0) return void scroller.current?.scrollTo({ top: 0 });
    list.current?.querySelector(`[data-passage="${passage.chunkId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [passages, passage.chunkId, passage.at]);

  if (!source) return null;
  let lastPage: number | null = null;
  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b px-4 py-3">
        <KindIcon kind={source.kind} className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-sm font-medium">{source.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{describe(source)}</p>
        </div>
        {source.url && (
          <Button variant="ghost" size="icon-sm" aria-label="Open original" onClick={() => void openUrl(source.url!)}>
            <ExternalLinkIcon />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close source" onClick={closePassage}>
          <XIcon />
        </Button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <SourceGuideCard source={source} />
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !passages ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <ol ref={list} className="flex flex-col gap-3">
            {passages.map((p) => {
              const pageBreak = p.page !== null && p.page !== lastPage;
              lastPage = p.page;
              const cited = p.id === passage.chunkId;
              return (
                <li key={p.id} data-passage={p.id} className="scroll-mt-4">
                  {pageBreak && <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Page {p.page}</p>}
                  <div
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                      cited ? "bg-brand/5 ring-1 ring-brand/40" : "text-foreground/90",
                    )}
                    aria-current={cited ? "true" : undefined}
                  >
                    {cited && passage.quote ? <Highlighted text={p.text} quote={passage.quote} /> : p.text}
                  </div>
                  {source.kind === "youtube" && source.url && <PlayAt url={source.url} text={p.text} />}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}

/** A YouTube passage's "Play from 4:05": opens the video at its first timestamp. */
function PlayAt({ url, text }: { url: string; text: string }) {
  const m = text.match(/^\[(?:(\d+):)?(\d+):(\d{2})\]/);
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const at = (() => {
    try {
      const u = new URL(/^https?:/i.test(url) ? url : `https://${url}`);
      u.searchParams.set("t", `${seconds}s`);
      return u.toString();
    } catch {
      return null;
    }
  })();
  if (!at) return null;
  return (
    <button
      type="button"
      onClick={() => void openUrl(at)}
      className="mt-1 ml-3 inline-flex items-center gap-1 text-xs text-brand hover:underline"
    >
      <PlayIcon className="size-3" aria-hidden /> Play from {m[0].slice(1, -1)}
    </button>
  );
}

/** A passage with the words a citation quotes marked, matched ignoring case and spacing. */
function Highlighted({ text, quote }: { text: string; quote: string }): ReactNode {
  const words = quote.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  const match = new RegExp(words.join("\\s+"), "i").exec(text);
  if (!match) return text;
  return (
    <>
      {text.slice(0, match.index)}
      <mark className="rounded-sm bg-brand/20 px-0.5 text-foreground">{match[0]}</mark>
      {text.slice(match.index + match[0].length)}
    </>
  );
}

// --- dialogs -------------------------------------------------------------------------

function RenameDialog({
  open,
  onOpenChange,
  title,
  value,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  value: string;
  onSave: (value: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void onSave(draft.trim());
            onOpenChange(false);
          }}
        >
          <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Name" />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteNotebookDialog({
  notebook,
  open,
  onOpenChange,
  onDeleted,
}: {
  notebook: Notebook;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{notebook.title}”?</DialogTitle>
          <DialogDescription>
            Its {sourceCount(notebook.sources.length)} and every chat in it are deleted from this computer. This can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await deleteNotebook(notebook.id);
              setBusy(false);
              onOpenChange(false);
              onDeleted?.();
            }}
          >
            {busy ? <Spinner /> : <Trash2Icon />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
