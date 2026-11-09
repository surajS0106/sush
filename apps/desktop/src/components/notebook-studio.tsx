// A notebook's Studio and notes: the panel beside its chat (make a briefing,
// study guide, FAQ or timeline; the outputs and notes so far), and the reader
// a note or output opens in, with its citations live (`lib/notebook-studio.ts`).

import {
  ArrowLeftIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  GraduationCapIcon,
  LayersIcon,
  LibraryBigIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  AudioLinesIcon,
  NotebookPenIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  StickyNoteIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { citationComponents, CitedSourceList } from "@/components/artifact-sources";
import { AudioOverviewView } from "@/components/audio-overview";
import { FlashcardsView, MindMapView, QuizView } from "@/components/notebook-play";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/PillTabs";
import { SourcesProvider } from "@/components/ui/Sources";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatWhen } from "@/lib/automations";
import { citedSources, stripCitations } from "@/lib/citations";
import { getNotebook } from "@/lib/notebooks";
import {
  closeNote,
  createNote,
  deleteNote,
  exportNote,
  isInteractive,
  kindLabel,
  noteToSource,
  openNote,
  remakeStudio,
  startStudio,
  type StudioOptions,
  STUDIO_KINDS,
  updateNote,
} from "@/lib/notebook-studio";
import type { FlashcardsData, MindMapData, Notebook, NotebookNote, NoteKind, QuizData } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";

const KIND_ICON: Record<NoteKind, (props: { className?: string }) => ReactNode> = {
  note: (p) => <StickyNoteIcon aria-hidden {...p} />,
  briefing: (p) => <FileTextIcon aria-hidden {...p} />,
  "study-guide": (p) => <GraduationCapIcon aria-hidden {...p} />,
  faq: (p) => <MessageCircleQuestionIcon aria-hidden {...p} />,
  timeline: (p) => <CalendarClockIcon aria-hidden {...p} />,
  quiz: (p) => <ListChecksIcon aria-hidden {...p} />,
  flashcards: (p) => <LayersIcon aria-hidden {...p} />,
  "mind-map": (p) => <NetworkIcon aria-hidden {...p} />,
  "audio-overview": (p) => <AudioLinesIcon aria-hidden {...p} />,
};

// --- the panel -----------------------------------------------------------------------

export function StudioPanel({ notebook, onClose }: { notebook: Notebook; onClose?: () => void }) {
  const ready = notebook.sources.some((s) => s.checked && s.status === "ready");
  const outputs = notebook.notes.filter((n) => n.kind !== "note");
  const notes = notebook.notes.filter((n) => n.kind === "note");
  const [starting, setStarting] = useState<NoteKind | null>(null);
  const [customizing, setCustomizing] = useState<Exclude<NoteKind, "note"> | null>(null);

  const start = async (kind: Exclude<NoteKind, "note">, options?: StudioOptions) => {
    setStarting(kind);
    const note = await startStudio(notebook, kind, options);
    setStarting(null);
    if (note) openNote(note.id);
  };
  const newNote = async () => {
    const note = await createNote(notebook.id);
    if (note) openNote(note.id);
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="flex-1 text-sm font-medium">Studio</h2>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close Studio" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          {STUDIO_KINDS.map(({ kind, label, hint }) => {
            const Icon = KIND_ICON[kind];
            const disabled = !ready || starting !== null;
            return (
              <div key={kind} className="group/card relative">
                <button
                  type="button"
                  disabled={disabled}
                  title={ready ? hint : "Add or check a source first"}
                  onClick={() => void start(kind)}
                  className="flex h-full w-full flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left transition-colors outline-none hover:border-brand/40 hover:bg-brand/5 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="flex size-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
                    {starting === kind ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}
                  </span>
                  <span className="text-sm font-medium">{label}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{hint}</span>
                </button>
                {/* A sibling, not inside the card's button: a button can't hold another. */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={`${label} options`}
                  title="Focus, length, language"
                  onClick={() => setCustomizing(kind)}
                  className="absolute top-2 right-2 text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 disabled:opacity-0"
                >
                  <SlidersHorizontalIcon />
                </Button>
              </div>
            );
          })}
        </div>
        {customizing && (
          <StudioOptionsDialog
            kind={customizing}
            onClose={() => setCustomizing(null)}
            onStart={(options) => {
              const kind = customizing;
              setCustomizing(null);
              void start(kind, options);
            }}
          />
        )}
        {!ready && <p className="mt-2 text-xs text-muted-foreground">Studio works from your checked sources; add or check one first.</p>}

        {outputs.length > 0 && (
          <section aria-labelledby="studio-outputs" className="mt-6">
            <h3 id="studio-outputs" className="mb-1 text-xs font-medium text-muted-foreground">
              Made in Studio
            </h3>
            <ul className="-mx-2 flex flex-col">
              {outputs.map((n) => (
                <li key={n.id}>
                  <NoteRow note={n} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="studio-notes" className="mt-6">
          <div className="mb-1 flex items-center gap-2">
            <h3 id="studio-notes" className="flex-1 text-xs font-medium text-muted-foreground">
              Notes
            </h3>
            <Button variant="ghost" size="xs" onClick={() => void newNote()}>
              <PlusIcon /> New note
            </Button>
          </div>
          {notes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Write your own, or use “Save to note” under any answer. Notes keep their citations, and can become sources.
            </p>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {notes.map((n) => (
                <li key={n.id}>
                  <NoteRow note={n} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

const LENGTHS = ["shorter", "default", "longer"] as const;
const FOCUS_HINT: Record<Exclude<NoteKind, "note">, string> = {
  briefing: "e.g. the cost figures, for a finance audience",
  "study-guide": "e.g. chapters 3 and 4 only",
  faq: "e.g. questions a new customer would ask",
  timeline: "e.g. only events after 2010",
  quiz: "e.g. harder questions on the methods",
  flashcards: "e.g. definitions of the key terms",
  "mind-map": "e.g. how the main arguments relate",
  "audio-overview": "e.g. explain it to a curious teenager",
};

/** Focus, length and language for one Studio output, before it's made. */
function StudioOptionsDialog({
  kind,
  onClose,
  onStart,
}: {
  kind: Exclude<NoteKind, "note">;
  onClose: () => void;
  onStart: (options: StudioOptions) => void;
}) {
  const [focus, setFocus] = useState("");
  const [length, setLength] = useState<(typeof LENGTHS)[number]>("default");
  const [language, setLanguage] = useState("");
  const label = kindLabel(kind);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{label} options</DialogTitle>
          <DialogDescription>All optional. It’s made from your checked sources, as usual.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onStart({ focus, length, language });
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="studio-focus">What should it focus on?</Label>
            <Textarea
              id="studio-focus"
              autoFocus
              value={focus}
              maxLength={500}
              onChange={(e) => setFocus(e.target.value)}
              placeholder={FOCUS_HINT[kind]}
              className="min-h-20"
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              Length
            </span>
            <PillTabs
              label="Length"
              tabs={["Shorter", "Default", "Longer"]}
              active={LENGTHS.indexOf(length)}
              onChange={(i) => setLength(LENGTHS[i])}
              showPanels={false}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="studio-language">Language</Label>
            <Input
              id="studio-language"
              value={language}
              maxLength={40}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="The sources’ own"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Make {label.toLowerCase()}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NoteRow({ note }: { note: NotebookNote }) {
  const Icon = KIND_ICON[note.kind];
  const meta =
    note.status === "writing" ? (
      <span className="flex items-center gap-1" role="status">
        <Spinner className="size-3" /> Reading sources and writing…
      </span>
    ) : note.status === "failed" ? (
      <span className="flex items-center gap-1 text-destructive">
        <CircleAlertIcon className="size-3" /> Didn’t finish
      </span>
    ) : (
      `${note.kind === "note" ? "Note" : kindLabel(note.kind)} · ${formatWhen(new Date(note.updatedAt))}`
    );
  return (
    <div className="group flex items-center gap-1 rounded-lg hover:bg-muted/60">
      <button type="button" onClick={() => openNote(note.id)} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left outline-none focus-visible:underline">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-sm">{note.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        </span>
      </button>
      <NoteMenu note={note} className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100" />
    </div>
  );
}

function NoteMenu({ note, className, onEdit }: { note: NotebookNote; className?: string; onEdit?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className={className} aria-label={`Options for ${note.title}`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {onEdit && note.status !== "writing" && !isInteractive(note.kind) && (
          <DropdownMenuItem onSelect={onEdit}>
            <PencilIcon /> Edit
          </DropdownMenuItem>
        )}
        {note.status === "ready" && note.body.trim() && !isInteractive(note.kind) && (
          <>
            <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(stripCitations(note.body)).then(() => toast.success("Copied"))}>
              <CopyIcon /> Copy text
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportNote(note)}>
              <DownloadIcon /> Save as Markdown…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void noteToSource(note)}>
              <LibraryBigIcon /> Add as a source
            </DropdownMenuItem>
          </>
        )}
        {note.kind !== "note" && note.status === "ready" && (
          <DropdownMenuItem
            onSelect={async () => {
              const notebook = getNotebook(note.notebookId);
              const again = notebook && (await remakeStudio(notebook, note));
              if (again) openNote(again.id);
            }}
          >
            <RotateCcwIcon /> Make again
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void deleteNote(note)}>
          <Trash2Icon /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- reading and editing a note ------------------------------------------------------

export function NoteReader({ notebook, note, onAsk }: { notebook: Notebook; note: NotebookNote; onAsk: (text: string) => void }) {
  // A new, empty note opens ready to write in.
  const [editing, setEditing] = useState(note.kind === "note" && !note.body.trim());
  useEffect(() => setEditing(note.kind === "note" && !note.body.trim()), [note.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const Icon = KIND_ICON[note.kind];

  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon-sm" className="-ml-2" aria-label="Back to Studio" onClick={closeNote}>
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-sm font-medium">{note.title}</h2>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Icon className="size-3" /> {note.kind === "note" ? "Note" : kindLabel(note.kind)} · {formatWhen(new Date(note.updatedAt))}
          </p>
        </div>
        {!editing && note.status !== "writing" && !isInteractive(note.kind) && (
          <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={() => setEditing(true)}>
            <PencilIcon />
          </Button>
        )}
        <NoteMenu note={note} onEdit={() => setEditing(true)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {editing ? (
          <NoteEditor note={note} onDone={() => setEditing(false)} />
        ) : note.status === "writing" ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center" role="status">
            <Spinner />
            <p className="text-sm font-medium">{isInteractive(note.kind) ? "Making" : "Writing"} the {kindLabel(note.kind).toLowerCase()}</p>
            <p className="max-w-64 text-xs text-muted-foreground">
              {isInteractive(note.kind)
                ? "Sush is going through your sources; each item will link to the passage it comes from. You can keep chatting meanwhile."
                : "Sush is searching your sources and writing it, citing each claim. You can keep chatting meanwhile."}
            </p>
          </div>
        ) : note.status === "failed" ? (
          <div className="flex flex-col items-start gap-3">
            <p className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" /> {note.error ?? "It didn’t finish."}
            </p>
            {note.kind !== "note" && (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const again = await remakeStudio(notebook, note);
                  if (again) openNote(again.id);
                }}
              >
                <RotateCcwIcon /> Try again
              </Button>
            )}
          </div>
        ) : note.kind === "quiz" && note.data ? (
          <QuizView key={note.updatedAt} data={note.data as QuizData} />
        ) : note.kind === "flashcards" && note.data ? (
          <FlashcardsView key={note.updatedAt} data={note.data as FlashcardsData} />
        ) : note.kind === "audio-overview" && note.data ? (
          <AudioOverviewView note={note} />
        ) : note.kind === "mind-map" && note.data ? (
          <MindMapView key={note.updatedAt} data={note.data as MindMapData} onAsk={onAsk} title={note.title} />
        ) : (
          <NoteBody body={note.body} id={note.id} />
        )}
      </div>
    </>
  );
}

/** A note's Markdown with its citations as numbered chips that open the passage. */
export function NoteBody({ body, id }: { body: string; id: string }) {
  const sources = useMemo(() => citedSources({ id, role: "assistant", parts: [{ type: "text", text: body }] } as SushUIMessage), [body, id]);
  const components = useMemo(() => citationComponents(sources), [sources]);
  if (!body.trim()) return <p className="text-sm text-muted-foreground">This note is empty.</p>;
  return (
    <SourcesProvider defaultExpanded={false}>
      <div className="flex flex-col gap-4">
        <MessageResponse className="transcript-prose text-sm" components={components}>
          {body}
        </MessageResponse>
        {sources.length > 0 && <CitedSourceList sources={sources} />}
      </div>
    </SourcesProvider>
  );
}

function NoteEditor({ note, onDone }: { note: NotebookNote; onDone: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const ok = await updateNote(note, title || "Untitled note", body);
    setSaving(false);
    if (ok) onDone();
  };
  return (
    <form
      className="flex h-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
      <Textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write in Markdown. Citations from saved answers are kept."
        aria-label="Note"
        className="min-h-64 flex-1 font-mono text-[13px] leading-relaxed"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Ctrl+S to save · Esc to cancel</span>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Spinner /> : <NotebookPenIcon />} Save
        </Button>
      </div>
    </form>
  );
}
