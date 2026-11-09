// A notebook's notes and Studio outputs. A Studio output (briefing, study
// guide, FAQ, timeline) is a note written by a run of its own: the run gets
// the notebook's source tools and the Studio instructions (`runs.rs`), and
// when it ends Rust files its final reply, citations and all, as the note.
// Notes are the user's: written by hand or a chat reply saved, and can be
// turned into sources.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { stripCitations } from "@/lib/citations";
import { addText, notebookForThread } from "@/lib/notebooks";
import { sendMessage } from "@/lib/sessions";
import { createConversation, createStore, deleteConversation, getConversations, getTarget } from "@/lib/store";
import { api, errorMessage, type Notebook, type NotebookNote, type NoteKind } from "@/lib/tauri";

export const STUDIO_KINDS: { kind: Exclude<NoteKind, "note">; label: string; hint: string }[] = [
  { kind: "briefing", label: "Briefing", hint: "Key points, themes and quotes" },
  { kind: "study-guide", label: "Study guide", hint: "Quiz, answers, essay questions, glossary" },
  { kind: "faq", label: "FAQ", hint: "The questions a reader would ask" },
  { kind: "timeline", label: "Timeline", hint: "Events in order, and who's who" },
  { kind: "quiz", label: "Quiz", hint: "Test yourself, with explanations" },
  { kind: "flashcards", label: "Flashcards", hint: "Terms and answers to drill" },
  { kind: "mind-map", label: "Mind map", hint: "The topics and how they connect" },
  { kind: "audio-overview", label: "Audio overview", hint: "Two hosts talk it through" },
];

/** Outputs that are played (a quiz, a deck, a map), not read. */
export const isInteractive = (kind: NoteKind) =>
  kind === "quiz" || kind === "flashcards" || kind === "mind-map" || kind === "audio-overview";

export const kindLabel = (kind: NoteKind) => STUDIO_KINDS.find((k) => k.kind === kind)?.label ?? "Note";

/** What the user can ask of a Studio output before it's made. Sent in its run's first message. */
export interface StudioOptions {
  /** What to concentrate on ("only chapter 3", "for a beginner"). */
  focus?: string;
  length?: "shorter" | "default" | "longer";
  /** The language to write it in; empty keeps the sources' own. */
  language?: string;
}

/** A Studio run's first message: what to make, and the options picked. `studio_section` in Rust says how to follow them. */
export function studioRequest(kind: Exclude<NoteKind, "note">, options: StudioOptions = {}): string {
  const lines = [`Write the ${kindLabel(kind).toLowerCase()} for this notebook.`];
  const focus = options.focus?.trim();
  if (focus) lines.push(`Focus: ${focus}`);
  if (options.length && options.length !== "default") lines.push(`Length: ${options.length}`);
  const language = options.language?.trim();
  if (language) lines.push(`Language: write it in ${language}.`);
  return lines.join("\n");
}

/** The request an output was made with, so "Try again" and "Make again" keep its options. */
function requestOf(note: NotebookNote): string | null {
  const thread = note.threadId ? getConversations().find((c) => c.id === note.threadId) : undefined;
  const first = thread?.messages.find((m) => m.role === "user");
  const text = first?.parts.find((p) => p.type === "text");
  return text && "text" in text && text.text.trim() ? text.text : null;
}

/** Start writing a Studio output. Returns its note, or null if it couldn't start. */
export async function startStudio(
  notebook: Notebook,
  kind: Exclude<NoteKind, "note">,
  options: StudioOptions | string = {},
): Promise<NotebookNote | null> {
  if (!getTarget()) {
    toast.error("Pick a model first", { description: "Choose one in the notebook’s chat." });
    return null;
  }
  const label = kindLabel(kind);
  const convo = createConversation(undefined, `${notebook.title}: ${label}`);
  try {
    const note = await api.notebookStudioStart(notebook.id, kind, convo.id);
    sendMessage(convo.id, typeof options === "string" ? options : studioRequest(kind, options), []);
    return note;
  } catch (e) {
    deleteConversation(convo.id);
    toast.error(`Couldn’t start the ${label.toLowerCase()}`, { description: errorMessage(e) });
    return null;
  }
}

/** Make an output again with the same options: in place of a failed one, or beside a finished one, which stays until it's deleted. */
export async function remakeStudio(notebook: Notebook, note: NotebookNote): Promise<NotebookNote | null> {
  if (note.kind === "note") return null;
  const again = await startStudio(notebook, note.kind, requestOf(note) ?? {});
  if (again && note.status === "failed") void deleteNote(note);
  return again;
}

// --- notes ---------------------------------------------------------------------------

export async function createNote(notebookId: string, title = "", body = ""): Promise<NotebookNote | null> {
  try {
    return await api.notebookNoteCreate(notebookId, title, body);
  } catch (e) {
    toast.error("Couldn’t create the note", { description: errorMessage(e) });
    return null;
  }
}

/** Keep a chat reply as a note, citations and all. */
export async function saveReplyToNote(threadId: string, text: string) {
  const notebook = notebookForThread(threadId);
  if (!notebook) return;
  const note = await createNote(notebook.id, "", text);
  if (note) toast.success("Saved to notes", { action: { label: "Open", onClick: () => openNote(note.id) } });
}

export async function updateNote(note: NotebookNote, title: string, body: string): Promise<boolean> {
  try {
    await api.notebookNoteUpdate(note.id, title, body);
    return true;
  } catch (e) {
    toast.error("Couldn’t save the note", { description: errorMessage(e) });
    return false;
  }
}

export async function deleteNote(note: NotebookNote) {
  try {
    const thread = await api.notebookNoteDelete(note.id);
    if (thread) deleteConversation(thread);
    if (opened.get() === note.id) opened.set(null);
  } catch (e) {
    toast.error("Couldn’t delete the note", { description: errorMessage(e) });
  }
}

/** Save a note as a Markdown file, citations as plain text. */
export async function exportNote(note: NotebookNote) {
  const name = `${note.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Note"}.md`;
  try {
    if (await api.saveTextFileAs(name, `# ${note.title}\n\n${stripCitations(note.body)}\n`)) toast.success("Saved");
  } catch (e) {
    toast.error("Couldn’t save the note", { description: errorMessage(e) });
  }
}

/** A copy of a note as a source, so chats can search and cite it. */
export async function noteToSource(note: NotebookNote) {
  const added = await addText(note.notebookId, note.title, stripCitations(note.body));
  if (added) toast.success(`“${note.title}” is now a source`);
}

// --- which note is open --------------------------------------------------------------

const opened = createStore<string | null>("sush.notebooks-note", null, false);
export const openNote = (id: string) => opened.set(id);
export const closeNote = () => opened.set(null);
export const useOpenNote = () => useSyncExternalStore(opened.subscribe, opened.get);
