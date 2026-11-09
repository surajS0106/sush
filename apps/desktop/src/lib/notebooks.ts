// Notebooks: sources (PDFs, web pages, papers, pasted text) to chat with,
// answers citing the passage each claim rests on. Rust keeps them
// (`notebooks.rs`, `sush_core::notebooks`), reads sources in the background,
// and sends every change to every window as a `notebook` frame, so nothing
// here is broadcast.
//
// A notebook's chats are ordinary threads filed under it; they're kept out of
// the session list, and Rust gives their runs the source tools in place of
// the UI's (`runConfig` in `sessions.ts` sends none).

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { createConversation, createStore, deleteConversation, getTarget, onTargetChange } from "@/lib/store";
import { api, errorMessage, type Notebook, type NotebookSource } from "@/lib/tauri";

const notebooks = createStore<Notebook[]>("sush.notebooks-cache", [], false);

/** Deleted notebooks. A frame for one may still be on its way after it's gone here. */
const gone = new Set<string>();

function upsert(notebook: Notebook) {
  if (gone.has(notebook.id)) return;
  notebooks.set((all) => {
    const rest = all.filter((n) => n.id !== notebook.id);
    // Most recently changed first, as Rust lists them.
    return [notebook, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

function remove(id: string) {
  gone.add(id);
  notebooks.set((all) => all.filter((n) => n.id !== id));
}

/** Load the notebooks. Call before rendering, so their chats stay out of the session list. */
export async function initNotebooks() {
  notebooks.set(await api.notebooksList());
  // Scanned PDFs are read in Rust with the model picked here.
  const tell = () => {
    const t = getTarget();
    void api.notebookSetReader(t?.providerId ?? null, t?.model ?? null).catch(() => {});
  };
  tell();
  onTargetChange(tell);
}

/** A `notebook` or `notebook-gone` frame; Rust sends them to every window. */
export const applyNotebook = upsert;
export const applyNotebookGone = remove;

export const useNotebooks = () => useSyncExternalStore(notebooks.subscribe, notebooks.get);
export const getNotebook = (id: string) => notebooks.get().find((n) => n.id === id);

const threadSets = new WeakMap<Notebook[], ReadonlySet<string>>();

function threadsOf(all: Notebook[]): ReadonlySet<string> {
  let set = threadSets.get(all);
  // Chats, and Studio outputs' runs.
  if (!set) threadSets.set(all, (set = new Set(all.flatMap((n) => [...n.threadIds, ...n.notes.flatMap((x) => (x.threadId ? [x.threadId] : []))]))));
  return set;
}

/** Threads that are notebook chats. They live on the Notebooks page, not in the session list. */
export const isNotebookThread = (id: string) => threadsOf(notebooks.get()).has(id);
export const useNotebookThreads = () => threadsOf(useNotebooks());

// --- notebooks ----------------------------------------------------------------------

export async function createNotebook(title: string): Promise<Notebook | null> {
  try {
    const notebook = await api.notebookCreate(title);
    upsert(notebook);
    return notebook;
  } catch (e) {
    toast.error("Couldn’t create the notebook", { description: errorMessage(e) });
    return null;
  }
}

export async function renameNotebook(id: string, title: string) {
  try {
    upsert(await api.notebookRename(id, title));
  } catch (e) {
    toast.error("Couldn’t rename the notebook", { description: errorMessage(e) });
  }
}

/** Delete a notebook, its sources and its chats. */
export async function deleteNotebook(id: string) {
  try {
    const threads = await api.notebookDelete(id);
    remove(id);
    for (const t of threads) deleteConversation(t);
  } catch (e) {
    toast.error("Couldn’t delete the notebook", { description: errorMessage(e) });
  }
}

/** A new chat in a notebook. Returns its thread id. */
export async function newNotebookChat(notebook: Notebook): Promise<string | null> {
  const convo = createConversation(undefined, notebook.title);
  try {
    upsert(await api.notebookAddThread(notebook.id, convo.id));
    return convo.id;
  } catch (e) {
    deleteConversation(convo.id);
    toast.error("Couldn’t start a chat", { description: errorMessage(e) });
    return null;
  }
}

/** Delete one of a notebook's chats. */
export function deleteNotebookChat(notebook: Notebook, threadId: string) {
  upsert({ ...notebook, threadIds: notebook.threadIds.filter((t) => t !== threadId) });
  deleteConversation(threadId);
}

// --- sources ------------------------------------------------------------------------

async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    toast.error(what, { description: errorMessage(e) });
    return null;
  }
}

export const addLink = (notebookId: string, url: string) => attempt("Couldn’t add that link", () => api.notebookAddLink(notebookId, url));
export const addText = (notebookId: string, title: string, text: string) =>
  attempt("Couldn’t add that text", () => api.notebookAddText(notebookId, title, text));
export const addFiles = (notebookId: string) => attempt("Couldn’t add those files", () => api.notebookAddFiles(notebookId));

/** Files a notebook can read, by extension. */
export const SOURCE_FILE = /\.(pdf|txt|md|markdown)$/i;

/** Add dropped files. Returns how many were added. */
export async function addDroppedFiles(notebookId: string, files: File[]): Promise<number> {
  let added = 0;
  for (const file of files) {
    if (!SOURCE_FILE.test(file.name)) {
      toast.error(`${file.name} can’t be added`, { description: "Notebooks read PDFs, text and Markdown files." });
      continue;
    }
    const data = base64(new Uint8Array(await file.arrayBuffer()));
    if (await attempt(`Couldn’t add ${file.name}`, () => api.notebookAddFileData(notebookId, file.name, data))) added++;
  }
  return added;
}

function base64(bytes: Uint8Array): string {
  // In slices: spreading a whole PDF into one call overflows the stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export const setSourceChecked = (source: NotebookSource, checked: boolean) =>
  attempt("Couldn’t change that source", () => api.notebookSourceUpdate(source.id, { checked }));
export const renameSource = (source: NotebookSource, title: string) =>
  attempt("Couldn’t rename that source", () => api.notebookSourceUpdate(source.id, { title }));
export const deleteSource = (source: NotebookSource) => attempt("Couldn’t remove that source", () => api.notebookSourceDelete(source.id));
export const retrySource = (source: NotebookSource) => attempt("Couldn’t read that source again", () => api.notebookSourceRetry(source.id));

/** Check or uncheck every source of a notebook. */
export async function setAllChecked(notebook: Notebook, checked: boolean) {
  for (const s of notebook.sources) if (s.checked !== checked) await setSourceChecked(s, checked);
}

/** The notebook a chat belongs to, outside React. */
export const notebookForThread = (threadId: string) => notebooks.get().find((n) => n.threadIds.includes(threadId));

/** The notebook a chat belongs to, if any. */
export const useNotebookForThread = (threadId: string | undefined) =>
  useNotebooks().find((n) => !!threadId && n.threadIds.includes(threadId));

// --- adding sources -----------------------------------------------------------------

/** What the "Add sources" pop-up opens on. */
export type AddView = "home" | "link" | "text" | "search" | "chat" | "folder";

const adding = createStore<{ notebookId: string; view: AddView; query?: string } | null>("sush.notebooks-adding", null, false);

/**
 * Open the "Add sources" pop-up (it's rendered by the open notebook). A tick
 * later, so a menu that asked for it has finished closing and handing back focus.
 */
export const openAddSources = (notebookId: string, view: AddView = "home", query?: string) =>
  void setTimeout(() => adding.set({ notebookId, view, query }), 0);
export const closeAddSources = () => adding.set(null);
export const useAddSources = () => useSyncExternalStore(adding.subscribe, adding.get);

// --- citations ----------------------------------------------------------------------

/** Where a passage citation points: `sushsrc:<source>/<chunk>?q=<the words cited>` (`sush_core::notebooks`). */
export interface PassageRef {
  sourceId: string;
  chunkId: number;
  quote?: string;
}

const SOURCE_SCHEME = "sushsrc:";

export const isPassageUrl = (url: string | undefined) => !!url?.startsWith(SOURCE_SCHEME);

export function parsePassageUrl(url: string): PassageRef | null {
  if (!isPassageUrl(url)) return null;
  const [path, query = ""] = url.slice(SOURCE_SCHEME.length).split("?", 2);
  const [sourceId, chunk] = path.split("/", 2);
  const chunkId = Number(chunk);
  if (!sourceId || !Number.isInteger(chunkId)) return null;
  const q = new URLSearchParams(query).get("q");
  return { sourceId, chunkId, quote: q?.trim() || undefined };
}

/** A passage's address without the quote: the same passage cited twice is one source. */
export const passageKey = (url: string) => url.split("?", 1)[0];

/** Titles of sources in notebooks shared with this app (a guest has no copy of the notebook). */
const guestTitles = new Map<string, string>();
export function rememberGuestSources(sources: { id: string; title: string }[]) {
  for (const s of sources) guestTitles.set(s.id, s.title);
}

/** A source's title, for citations that came without one. */
export function sourceTitle(sourceId: string): string | undefined {
  for (const n of notebooks.get()) {
    const s = n.sources.find((x) => x.id === sourceId);
    if (s) return s.title;
  }
  return guestTitles.get(sourceId);
}

// A citation clicked anywhere asks the open notebook to show its passage.
type OpenRequest = PassageRef & { at: number };
const opened = createStore<OpenRequest | null>("sush.notebooks-open", null, false);

export function openPassage(url: string) {
  const ref = parsePassageUrl(url);
  if (ref) opened.set({ ...ref, at: Date.now() });
}

/** Open a source in the viewer, at its start. */
export const openSource = (sourceId: string) => opened.set({ sourceId, chunkId: -1, at: Date.now() });

export const useOpenPassage = () => useSyncExternalStore(opened.subscribe, opened.get);
export const closePassage = () => opened.set(null);
