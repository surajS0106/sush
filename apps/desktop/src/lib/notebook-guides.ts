// Generated guides for notebooks: an overview of a notebook's sources (a
// summary, questions to ask, and a suggested title and emoji while it has
// none), and a guide to each source (a summary and key topics). Written with
// the model last used, from the start of each source's text, and kept by Rust
// (`notebook_set_overview`, `notebook_source_set_guide`), which tells every
// window. An overview covers every ready source (not only the ticked ones, so
// ticking sources for a question doesn't pay for a new one) and is rewritten
// when a source is added, removed or read again.

import { useSyncExternalStore } from "react";

import { complete, extractJson } from "@/lib/complete";
import { createStore, getTarget } from "@/lib/store";
import { api, type Notebook, type NotebookSource } from "@/lib/tauri";

/** How much of each source, and of all of them, a guide is written from. */
const PER_SOURCE = 8000;
const TOTAL = 32000;

/** What an overview depends on, as `sush_core::notebooks::sources_key` computes it. */
export function sourcesKey(notebook: Notebook): string {
  return notebook.sources
    .filter((s) => s.status === "ready")
    .map((s) => `${s.id}:${s.chunks}`)
    .sort()
    .join(",");
}

/** Whether the overview needs writing: there are sources to read, and it's missing or was written from others. */
export function overviewDue(notebook: Notebook): boolean {
  const key = sourcesKey(notebook);
  return key !== "" && notebook.overview?.sourcesKey !== key;
}

export const guideDue = (s: NotebookSource) => s.status === "ready" && (!s.guide || s.guide.chunks !== s.chunks);

// What's being written now (notebook and source ids), and what failed for which key, so it isn't retried in a loop.
const busy = createStore<ReadonlySet<string>>("sush.notebook-guides-busy", new Set(), false);
const failed = new Map<string, string>();

function setBusy(id: string, on: boolean) {
  busy.set((prev) => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
}

export const useGuideBusy = (id: string) => useSyncExternalStore(busy.subscribe, () => busy.get().has(id));
export const guideFailed = (id: string) => failed.get(id);

/** The start of a source's text, up to `max` characters. Only the passages that can fill it cross from Rust. */
async function excerpt(source: NotebookSource, max: number): Promise<string> {
  const { passages } = await api.notebookSourceText(source.id, Math.ceil(max / 300) + 1);
  let out = "";
  for (const p of passages) {
    if (out.length >= max) break;
    out += `${p.text}\n\n`;
  }
  return out.slice(0, max).trim();
}

const OVERVIEW_SYSTEM = `You write the overview at the top of a notebook: a set of sources the user has gathered on one topic.
Read the sources and reply with only a JSON object, no prose or code fences:
{"title": "...", "emoji": "...", "summary": "...", "questions": ["...", "...", "..."]}
- summary: one paragraph of 80 to 150 words saying what the sources cover, taken together. Third person, plain and specific: names, numbers, claims. Put the 4 to 8 most important terms in **bold**. Only what the sources say; no preamble like "These sources".
- questions: three different questions a reader would want answered that the sources can answer, each under 20 words.
- title: a name for the notebook, 2 to 6 words, no quotes or trailing punctuation.
- emoji: one emoji that fits the topic.`;

const GUIDE_SYSTEM = `You write a short guide to one source for a reader deciding what to ask about it.
Reply with only a JSON object, no prose or code fences:
{"summary": "...", "topics": ["...", "..."]}
- summary: 2 to 4 sentences on what the source is, what it covers and what it's for. Put the 3 to 6 most important terms in **bold**. Only what the source says.
- topics: 3 to 6 key topics it covers, each a short noun phrase of 1 to 4 words.`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Write the notebook's overview, unless it's current (or `force`). Quietly does nothing without a model. */
export async function generateOverview(notebook: Notebook, force = false) {
  const key = sourcesKey(notebook);
  if (!key || busy.get().has(notebook.id)) return;
  if (!force && (notebook.overview?.sourcesKey === key || failed.get(notebook.id) === key)) return;
  const target = getTarget();
  if (!target) return;
  setBusy(notebook.id, true);
  try {
    const sources = notebook.sources.filter((s) => s.status === "ready");
    const each = Math.max(1500, Math.min(PER_SOURCE, Math.floor(TOTAL / sources.length)));
    const parts: string[] = [];
    for (const s of sources) parts.push(`<source title="${s.title.replace(/"/g, "'")}">\n${await excerpt(s, each)}\n</source>`);
    const reply = extractJson(await complete(target, OVERVIEW_SYSTEM, parts.join("\n\n"))) as Record<string, unknown>;
    const summary = str(reply.summary);
    if (!summary) throw new Error("The model didn't write a summary.");
    const questions = (Array.isArray(reply.questions) ? reply.questions : []).map(str).filter(Boolean).slice(0, 3);
    await api.notebookSetOverview(
      notebook.id,
      { summary, questions, sourcesKey: key, generatedAt: Date.now() },
      str(reply.title) || null,
      str(reply.emoji) || null,
    );
    failed.delete(notebook.id);
  } catch (e) {
    console.error("Couldn't write the notebook's overview", e);
    failed.set(notebook.id, key);
  } finally {
    setBusy(notebook.id, false);
  }
}

/** Write a source's guide, unless it's current (or `force`). */
export async function generateGuide(source: NotebookSource, force = false) {
  if (source.status !== "ready" || busy.get().has(source.id)) return;
  const key = String(source.chunks);
  if (!force && (!guideDue(source) || failed.get(source.id) === key)) return;
  const target = getTarget();
  if (!target) return;
  setBusy(source.id, true);
  try {
    const text = await excerpt(source, 12000);
    const reply = extractJson(await complete(target, GUIDE_SYSTEM, `<source title="${source.title.replace(/"/g, "'")}">\n${text}\n</source>`)) as Record<
      string,
      unknown
    >;
    const summary = str(reply.summary);
    if (!summary) throw new Error("The model didn't write a summary.");
    const topics = (Array.isArray(reply.topics) ? reply.topics : []).map(str).filter(Boolean).slice(0, 6);
    await api.notebookSourceSetGuide(source.id, { summary, topics, chunks: source.chunks });
    failed.delete(source.id);
  } catch (e) {
    console.error("Couldn't write the source's guide", e);
    failed.set(source.id, key);
  } finally {
    setBusy(source.id, false);
  }
}
