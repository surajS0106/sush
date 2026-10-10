// Settings → Memory: what the model may do with memory and past chats, the
// memory files themselves, and a box for asking the model to change them.

import { ArrowLeftIcon, ArrowUpIcon, CheckIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Group, Page, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { setPrefs, usePrefs } from "@/lib/library";
import {
  clearMemory,
  deleteMemory,
  IMPORT_PROMPT,
  kindOf,
  reviseMemory,
  slugify,
  useMemoryFiles,
  writeMemory,
  type MemoryFile,
  type MemoryKind,
} from "@/lib/memory";
import { getTarget } from "@/lib/store";
import { errorMessage } from "@/lib/tauri";

/** What the editor has open: an existing file's path, or a new file of a kind. */
type Editing = { path: string } | { kind: Exclude<MemoryKind, "profile"> };

const NO_MODEL = "Pick a model in a chat first; memory changes use the model you chatted with last.";

export function MemorySection() {
  const prefs = usePrefs();
  const files = useMemoryFiles();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importing, setImporting] = useState(false);

  if (editing) return <MemoryEditor editing={editing} onClose={() => setEditing(null)} />;

  const profile = files.find((f) => f.path === "profile");
  const topics = files.filter((f) => kindOf(f.path) === "topic").sort(byTitle);
  const areas = files.filter((f) => kindOf(f.path) === "area").sort(byTitle);

  return (
    <div className="flex min-h-full flex-col">
      <Page>
        <Group title="Memory">
          <Setting title="Search and reference chats" description="Allow Sush to search for relevant details in past chats.">
            <Switch
              checked={prefs.referenceChats}
              onCheckedChange={(referenceChats) => setPrefs({ referenceChats })}
              aria-label="Search and reference chats"
            />
          </Setting>
          <Setting title="Generate memory from chats" description="Allow Sush to remember and update details from your chats.">
            <Switch checked={prefs.memory} onCheckedChange={(memory) => setPrefs({ memory })} aria-label="Generate memory from chats" />
          </Setting>
          <Setting
            title="Include sensitive topics in memory"
            description="Allow Sush to save details about sensitive topics like health conditions or religious beliefs to memory."
          >
            <Switch
              checked={prefs.memorySensitive}
              onCheckedChange={(memorySensitive) => setPrefs({ memorySensitive })}
              aria-label="Include sensitive topics in memory"
            />
          </Setting>
          <Setting
            title="Import memory from other AI providers"
            description="Bring context from another assistant. You'll get a prompt to run there, then paste its reply here."
          >
            <Button variant="secondary" size="sm" onClick={() => setImporting(true)}>
              Start import
            </Button>
          </Setting>
        </Group>

        <FileGroup title="You">
          <FileRow
            title="Profile"
            description={profile?.description || "Who you are: role, experience, location, background"}
            updatedAt={profile?.updatedAt}
            onOpen={() => setEditing({ path: "profile" })}
          />
        </FileGroup>
        <FileGroup title="Topics" onAdd={() => setEditing({ kind: "topic" })} empty="Communication style, interests, skills and the like.">
          {topics.map((f) => (
            <FileRow key={f.path} {...f} onOpen={() => setEditing({ path: f.path })} />
          ))}
        </FileGroup>
        <FileGroup title="Areas" onAdd={() => setEditing({ kind: "area" })} empty="Ongoing projects and responsibilities.">
          {areas.map((f) => (
            <FileRow key={f.path} {...f} onOpen={() => setEditing({ path: f.path })} />
          ))}
        </FileGroup>

        {files.length > 0 && <DeleteAll />}
      </Page>

      <ChangeBox sensitive={prefs.memorySensitive} />
      <ImportDialog open={importing} onOpenChange={setImporting} sensitive={prefs.memorySensitive} />
    </div>
  );
}

const byTitle = (a: MemoryFile, b: MemoryFile) => a.title.localeCompare(b.title);

// --- list ---------------------------------------------------------------------------

function FileGroup({ title, onAdd, empty, children }: { title: string; onAdd?: () => void; empty?: string; children: ReactNode }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section>
      <div className="flex items-center justify-between pb-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {onAdd && (
          <Button variant="ghost" size="icon-sm" aria-label={`Add to ${title}`} onClick={onAdd}>
            <PlusIcon />
          </Button>
        )}
      </div>
      <div className="divide-y border-t">
        {hasRows ? children : <p className="py-3 text-sm text-muted-foreground">{empty}</p>}
      </div>
    </section>
  );
}

function FileRow({ title, description, updatedAt, onOpen }: { title: string; description: string; updatedAt?: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[9rem_1fr_auto] items-center gap-6 rounded-md px-2 py-3 text-left text-sm hover:bg-accent/50"
    >
      <span className="truncate font-medium">{title}</span>
      <span className="truncate text-muted-foreground">{description}</span>
      <span className="text-muted-foreground">{updatedAt ? `Updated ${formatUpdated(updatedAt)}` : "Not written yet"}</span>
    </button>
  );
}

function formatUpdated(ts: number) {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0);

function DeleteAll() {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => {
          if (!confirming) return setConfirming(true);
          clearMemory();
          setConfirming(false);
        }}
        onBlur={() => setConfirming(false)}
      >
        <Trash2Icon /> {confirming ? "Click again to delete all memory" : "Delete all memory"}
      </Button>
    </div>
  );
}

// --- editor ---------------------------------------------------------------------------

function MemoryEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const files = useMemoryFiles();
  const existing = "path" in editing ? files.find((f) => f.path === editing.path) : undefined;
  const isProfile = "path" in editing && editing.path === "profile";
  const kind = "kind" in editing ? editing.kind : kindOf(editing.path);
  const [title, setTitle] = useState(existing?.title ?? (isProfile ? "Profile" : ""));
  const [description, setDescription] = useState(existing?.description ?? "");
  const [content, setContent] = useState(existing?.content ?? "");

  const save = () => {
    const path = "path" in editing ? editing.path : `${kind === "area" ? "areas" : "topics"}/${slugify(title)}`;
    if (!("path" in editing) && files.some((f) => f.path === path)) {
      toast.error(`There's already a ${kind} called “${title.trim()}”.`);
      return;
    }
    try {
      writeMemory({ path, title, description, content });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 border-b py-3 pr-14 pl-4">
        <Button variant="ghost" size="icon-sm" aria-label="Back to memory" onClick={onClose}>
          <ArrowLeftIcon />
        </Button>
        <h2 className="text-base font-semibold">
          {existing ? existing.title : isProfile ? "Profile" : kind === "area" ? "New area" : "New topic"}
        </h2>
      </div>
      <div className="flex flex-1 flex-col gap-4 py-5 pr-14 pl-8">
        {!isProfile && (
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "area" ? "AI agent harness" : "Communication"}
              // Renaming would move the file; keep paths stable.
              disabled={!!existing}
            />
          </Field>
        )}
        <Field label="Description" hint="One line; shown in the list and to the model.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={isProfile ? "Role, experience, location, background" : "What this file covers"}
          />
        </Field>
        <Field label="Contents" hint="Markdown. The model reads this at the start of every chat while memory is on.">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-72 font-mono text-[13px]"
            placeholder={"- Prefers concise answers with code first\n- Works in TypeScript and Rust"}
          />
        </Field>
      </div>
      <div className="flex justify-between gap-2 border-t py-3 pr-6 pl-8">
        {existing ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              deleteMemory(existing.path);
              onClose();
            }}
          >
            <Trash2Icon /> Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!title.trim() || !content.trim()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// --- ask the model ----------------------------------------------------------------------

function ChangeBox({ sensitive }: { sensitive: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const request = text.trim();
    if (!request || busy) return;
    const target = getTarget();
    if (!target) return toast.error(NO_MODEL);
    setBusy(true);
    try {
      toast.success(await reviseMemory(target, request, { sensitive }));
      setText("");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="sticky bottom-0 mt-auto bg-linear-to-t from-popover from-70% to-transparent pt-6 pr-14 pb-4 pl-8"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2 rounded-full border bg-background py-1.5 pr-1.5 pl-4 shadow-xs dark:bg-input/30">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          placeholder={busy ? "Updating memory…" : "Tell Sush what to change"}
          aria-label="Tell Sush what to change in memory"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button type="submit" size="icon-sm" className="rounded-full" disabled={busy || !text.trim()} aria-label="Update memory">
          {busy ? <Spinner /> : <ArrowUpIcon />}
        </Button>
      </div>
    </form>
  );
}

// --- import -------------------------------------------------------------------------------

function ImportDialog({ open, onOpenChange, sensitive }: { open: boolean; onOpenChange: (open: boolean) => void; sensitive: boolean }) {
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const run = async () => {
    const target = getTarget();
    if (!target) return toast.error(NO_MODEL);
    setBusy(true);
    try {
      const summary = await reviseMemory(
        target,
        "Merge the imported memory into my memory files. Put each fact in the file it belongs in, create files as needed, and skip anything already saved.",
        { sensitive, imported: pasted.trim() },
      );
      toast.success(summary);
      setPasted("");
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import memory</DialogTitle>
          <DialogDescription>Bring what another assistant knows about you into Sush.</DialogDescription>
        </DialogHeader>
        <Step n={1} title="Copy this prompt into a chat with your other assistant">
          <div className="relative">
            <pre className="max-h-40 overflow-auto rounded-lg bg-muted/60 p-3 pr-10 text-xs whitespace-pre-wrap">{IMPORT_PROMPT}</pre>
            <Button variant="ghost" size="icon-sm" className="absolute top-1.5 right-1.5" aria-label="Copy prompt" onClick={() => void copy()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        </Step>
        <Step n={2} title="Paste its reply here">
          <Textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            className="max-h-56 min-h-32 text-[13px]"
            placeholder="Paste the list of memories"
            disabled={busy}
          />
        </Step>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={busy || !pasted.trim()}>
            {busy && <Spinner />} {busy ? "Adding to memory…" : "Add to memory"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-xs">{n}</span>
        {title}
      </p>
      {children}
    </div>
  );
}
