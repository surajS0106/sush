// Docs: Notion-style documents the model writes with `doc_write` and the user
// edits in place, beside the chat (components/doc-panel.tsx) or on the Docs
// page. Rust keeps them in `sush.db` with their versions (`docs.rs`,
// `sush_core::docs`) and sends every change to every window as a `doc` frame,
// so nothing here is broadcast.
//
// A doc is Markdown. While `doc_write` streams, the panel shows the content as
// it arrives (read from the tool call); once the call returns, the stored doc
// is the one shown and edited. The model sees the user's edits by reading the
// doc (`doc_read`); Rust won't let `doc_write` overwrite edits it hasn't read.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { DIAGRAM_GUIDE } from "@/lib/diagram";
import { closeDeck } from "@/lib/slides";
import { createStore } from "@/lib/store";
import { api, errorMessage, type Doc, type ToolSpec } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";

export const DOC_WRITE = "doc_write";
export const DOC_READ = "doc_read";
export const DOC_EDIT = "doc_edit";
export const DOC_TOOL_NAMES: ReadonlySet<string> = new Set([DOC_WRITE, DOC_READ, DOC_EDIT]);

const ID_PROP = { type: "string", description: "Short kebab-case slug, kept the same across revisions, e.g. 'selling-sush'" };

/**
 * The house style every doc follows, so a first draft reads like a finished document rather than
 * a chat answer pasted into a page. Kept in the tool's description: the model needs it before it writes.
 */
const DOC_TEMPLATE =
  "Write it as a professional document, in this shape. " +
  "(1) Lead: one short paragraph of two or three sentences that answers the question or states the purpose, with the " +
  "single most important point in **bold**. No 'This guide/document…' openings, no heading above it. " +
  "(2) When the subject has a handful of key facts or options, a '## At a glance' (or '## Summary') section with a " +
  "compact table (2 to 4 columns, short cells, header row) or 3 to 5 bullets. " +
  "(3) The body: 3 to 6 '##' sections in a logical order, each opening with a sentence of context before any list; " +
  "'###' for sub-parts (e.g. one per plan, step or option); never a bold line standing in for a heading. " +
  "(4) Close with '## Recommendations', '## Next steps' (as '- [ ]' to-dos) or '## Key takeaways', whichever fits. " +
  "(5) When you used web pages, end with '## Sources': a bulleted list of [Page title](url) links. " +
  "Style: sentence-case headings without emoji or numbering; paragraphs of at most four sentences; bullets that are " +
  "parallel and brief (one line where possible, no full stops on fragments); bold only for key terms, never whole " +
  "sentences or table cells; tables for comparisons of 3+ items across 2+ attributes, not for prose; numbered lists " +
  "only for sequences; one '>' quote at most, for a caveat or the key takeaway; at most one or two diagrams, where " +
  "something is clearer drawn than told. " +
  DIAGRAM_GUIDE +
  " Concrete over generic: figures, names, examples and dates the sources " +
  "support, never invented. No filler, no restating the title, no closing summary that repeats the body.";

export const docWriteTool: ToolSpec = {
  name: DOC_WRITE,
  description:
    "Create or rewrite a doc: a Notion-style document shown in a panel beside the chat, which the user can edit in place " +
    "and share or export. Use it whenever the user asks for a doc, document, write-up, report, guide, plan, playbook, " +
    "proposal, brief, one-pager, explainer, spec or notes to keep, and for any substantial structured answer they'll want " +
    "to keep, edit or pass on (e.g. 'how do I sell X', 'write a launch plan'). Use artifact_write instead for code and files " +
    "in a given format, and slides_write for presentations. Research first when facts matter, then write the doc in one go. " +
    DOC_TEMPLATE +
    " Content is GitHub Markdown without the title (the title is shown above it). Always pass the complete content; to " +
    "change part of an existing doc use doc_edit. The user may edit docs themselves: if they have since you last saw one, " +
    "call doc_read before revising it. In your reply, say in a line or two what the doc covers; don't repeat its text.",
  inputSchema: {
    type: "object",
    properties: {
      id: ID_PROP,
      title: { type: "string", description: "A clear, specific title in title case, e.g. 'Notion Pricing Plans Compared'" },
      icon: { type: "string", description: "Leave out unless the user asks for an icon" },
      note: { type: "string", description: "What this version is or changed, in a few words, e.g. 'Added pricing objections'" },
      content: { type: "string", description: "The whole doc in Markdown, following the template, without the title" },
    },
    required: ["id", "title", "content"],
  },
};

export const docReadTool: ToolSpec = {
  name: DOC_READ,
  description:
    "Read a doc from this chat as it is now, including any edits the user made in the panel. Call it before revising a doc " +
    "the user may have edited, or when they refer to what's in it.",
  inputSchema: { type: "object", properties: { id: ID_PROP }, required: ["id"] },
};

export const docEditTool: ToolSpec = {
  name: DOC_EDIT,
  description:
    "Change parts of an existing doc without rewriting it: each edit replaces one exact, unique piece of its Markdown " +
    "(`find`, copied from the doc as it is now) with `replace`. To add a section, find the line it should follow and " +
    "replace it with that line plus the new section. Keep to the doc's structure and style (as doc_write describes). All edits apply or none do.",
  inputSchema: {
    type: "object",
    properties: {
      id: ID_PROP,
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            find: { type: "string", description: "Exact text from the doc, long enough to occur once" },
            replace: { type: "string", description: "What it becomes (empty to delete it)" },
          },
          required: ["find", "replace"],
        },
      },
      title: { type: "string", description: "A new title, if it changes" },
      note: { type: "string", description: "What changed, in a few words" },
    },
    required: ["id", "edits"],
  },
};

export const docTools = [docWriteTool, docReadTool, docEditTool];

/** Run a doc tool for `threadId`'s model. Rust saves the doc and tells every window. */
export async function runDocTool(name: string, input: unknown, threadId: string | undefined): Promise<{ output: unknown } | { errorText: string }> {
  if (!threadId) return { errorText: `${name} can only be used in a chat.` };
  try {
    return { output: await api.docTool(threadId, name, input) };
  } catch (e) {
    return { errorText: errorMessage(e) };
  }
}

// --- ids ------------------------------------------------------------------------------

/** Mirrors `sush_core::docs::clean_slug`. */
export function cleanSlug(s: string): string {
  let out = "";
  for (const c of s.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(c)) out += c;
    else if (out && !out.endsWith("-")) out += "-";
  }
  out = out.replace(/-+$/, "").slice(0, 64);
  return out || "doc";
}

export const docId = (threadId: string, slug: string) => `${threadId}/${cleanSlug(slug)}`;

// --- the docs -------------------------------------------------------------------------

const docs = createStore<ReadonlyMap<string, Doc>>("sush.docs-cache", new Map(), false);
/** Deleted docs. A frame for one may still be on its way after it's gone here. */
const gone = new Set<string>();

let loading: Promise<void> | null = null;

/** Load every doc, once. Call before rendering, so cards find theirs. */
export function initDocs(): Promise<void> {
  loading ??= load();
  return loading;
}

async function load() {
  try {
    const all = await api.docsList();
    docs.set((cur) => {
      const next = new Map(all.map((d) => [d.id, d]));
      // A frame that came in while this was loading may be newer than what was read.
      for (const d of cur.values()) if ((next.get(d.id)?.rev ?? -1) < d.rev) next.set(d.id, d);
      return next;
    });
  } catch (e) {
    console.error("Couldn't load docs", e);
  }
}

// In development a hot reload can run this module again with an empty store; load it again then.
if (import.meta.hot) void initDocs();

/** A `doc` frame; Rust sends them to every window. */
export function applyDoc(doc: Doc) {
  if (gone.has(doc.id)) return;
  docs.set((cur) => {
    if ((cur.get(doc.id)?.rev ?? -1) > doc.rev) return cur;
    const next = new Map(cur);
    next.set(doc.id, doc);
    return next;
  });
}

export function applyDocGone(id: string) {
  gone.add(id);
  docs.set((cur) => {
    if (!cur.has(id)) return cur;
    const next = new Map(cur);
    next.delete(id);
    return next;
  });
}

export const getDoc = (id: string) => docs.get().get(id);
export const useDoc = (id: string | undefined) => useSyncExternalStore(docs.subscribe, () => (id ? docs.get().get(id) : undefined));

const sorted = new WeakMap<ReadonlyMap<string, Doc>, Doc[]>();
/** Every doc, most recently changed first. */
export function useDocs(): Doc[] {
  const all = useSyncExternalStore(docs.subscribe, docs.get);
  let list = sorted.get(all);
  if (!list) sorted.set(all, (list = [...all.values()].sort((a, b) => b.updatedAt - a.updatedAt)));
  return list;
}

export async function createDoc(title = "Untitled"): Promise<Doc | null> {
  try {
    const doc = await api.docCreate(title);
    applyDoc(doc);
    return doc;
  } catch (e) {
    toast.error("Couldn’t create the doc", { description: errorMessage(e) });
    return null;
  }
}

/** Save the user's edit, made on `baseRev`. Resolves to the doc as saved, or null if it was refused. */
export async function saveDoc(doc: Doc, baseRev: number, title: string, content: string, icon: string | null): Promise<Doc | null> {
  try {
    const saved = await api.docUpdate(doc.id, baseRev, title, content, icon);
    applyDoc(saved);
    return saved;
  } catch (e) {
    toast.error("Couldn’t save the doc", { description: errorMessage(e) });
    return null;
  }
}

export async function restoreDocVersion(doc: Doc, number: number) {
  try {
    applyDoc(await api.docRestore(doc.id, number));
    toast.success(`Restored v${number}`);
  } catch (e) {
    toast.error("Couldn’t restore that version", { description: errorMessage(e) });
  }
}

export async function deleteDoc(doc: Doc): Promise<boolean> {
  try {
    await api.docDelete(doc.id);
    applyDocGone(doc.id);
    return true;
  } catch (e) {
    toast.error("Couldn’t delete the doc", { description: errorMessage(e) });
    return false;
  }
}

// --- the calls in a chat --------------------------------------------------------------

/** A `doc_write` call as its card and the panel show it. */
export interface DocCall {
  /** The stored doc's id. */
  docId: string;
  callId: string;
  /** Still streaming in: show `title` and `content` from the call, not the stored doc. */
  streaming: boolean;
  title: string;
  icon?: string;
  content: string;
}

export interface DocCalls {
  byCall: Map<string, DocCall>;
  /** Each doc's newest write in this chat. */
  latest: Map<string, DocCall>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Every `doc_write` call in a thread. Failed calls aren't shown. */
export function docCalls(threadId: string, messages: SushUIMessage[]): DocCalls {
  const byCall = new Map<string, DocCall>();
  const latest = new Map<string, DocCall>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "dynamic-tool" || p.toolName !== DOC_WRITE || p.state === "output-error") continue;
      // Streaming input is parsed as it arrives, so any field may still be missing.
      const input = (p.input ?? {}) as Record<string, unknown>;
      const slug = str(input.id);
      const call: DocCall = {
        docId: docId(threadId, slug || p.toolCallId),
        callId: p.toolCallId,
        streaming: p.state === "input-streaming" || p.state === "input-available",
        title: str(input.title)?.trim() || "Untitled",
        icon: str(input.icon),
        content: str(input.content) ?? "",
      };
      byCall.set(p.toolCallId, call);
      latest.set(call.docId, call);
    }
  }
  return { byCall, latest };
}

// --- the open doc ---------------------------------------------------------------------

export interface DocPanelState {
  docId: string;
  /**
   * The call it was opened from. A call's doc id isn't known until its `id` has streamed in, which may be
   * after the content (models write the fields in any order), so the panel follows the call.
   */
  callId?: string;
  /** The panel covers the chat. */
  expanded: boolean;
}

/** The doc shown beside each thread, by thread id. Not persisted: a reload starts with the panel closed. */
const panels = createStore<ReadonlyMap<string, DocPanelState>>("sush.doc-panels", new Map(), false);

export const useDocPanel = (threadId: string) => useSyncExternalStore(panels.subscribe, () => panels.get().get(threadId) ?? null);

function setPanel(threadId: string, state: DocPanelState | null) {
  panels.set((prev) => {
    const next = new Map(prev);
    if (state) next.set(threadId, state);
    else next.delete(threadId);
    return next;
  });
}

/** Show a doc beside the chat, in place of an open deck. */
export function openDoc(threadId: string, id: string, callId?: string) {
  closeDeck(threadId);
  setPanel(threadId, { docId: id, callId, expanded: panels.get().get(threadId)?.expanded ?? false });
}
export const closeDoc = (threadId: string) => setPanel(threadId, null);
export function setDocExpanded(threadId: string, expanded: boolean) {
  const cur = panels.get().get(threadId);
  if (cur) setPanel(threadId, { ...cur, expanded });
}

/** Calls the panel already opened for, so closing it while a doc streams keeps it closed. */
const autoOpened = new Set<string>();

/** Opens the panel the first time a call starts writing a doc. */
export function autoOpenDoc(threadId: string, call: DocCall) {
  if (!call.streaming || autoOpened.has(call.callId)) return;
  autoOpened.add(call.callId);
  openDoc(threadId, call.docId, call.callId);
}

// --- reading and sharing --------------------------------------------------------------

export interface Heading {
  level: 1 | 2 | 3;
  text: string;
}

/** The doc's headings, for its outline. Fenced code is skipped. */
export function headings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length as 1 | 2 | 3, text: m[2].replace(/[*_`]/g, "") });
  }
  return out;
}

export const wordCount = (markdown: string) => markdown.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The whole doc as Markdown, title first. */
export const docMarkdown = (doc: Pick<Doc, "title" | "icon" | "content">) => `# ${doc.icon ? `${doc.icon} ` : ""}${doc.title}\n\n${doc.content.trim()}\n`;

export const docFileName = (title: string, ext: string) =>
  `${title.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").toLowerCase() || "doc"}.${ext}`;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The doc's body as HTML, through the editor's own converter (loaded on first use). */
async function bodyHtml(markdown: string): Promise<string> {
  const { markdownToHtml } = await import("@/lib/doc-schema");
  return markdownToHtml(markdown);
}

/** A standalone web page of the doc, readable offline and printable to PDF. */
export async function exportDocHtml(doc: Pick<Doc, "title" | "icon" | "content" | "updatedAt" | "date">): Promise<string> {
  const body = await bodyHtml(doc.content);
  // The date picked under the title (a local day, not UTC midnight), else when it last changed.
  const [y, m, d] = (doc.date ?? "").split("-").map(Number);
  const shown = doc.date ? new Date(y, m - 1, d) : new Date(doc.updatedAt);
  const date = shown.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
:root { color-scheme: light dark; --fg: #1f1f1f; --muted: #6b6b6b; --line: #e6e6e6; --soft: #f6f6f4; --bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #9a9a9a; --line: #333; --soft: #202020; --bg: #191919; } }
html { background: var(--bg); color: var(--fg); }
body { margin: 0 auto; max-width: 760px; padding: 64px 24px 96px; font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1.title { font-size: 2.5rem; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
.meta { color: var(--muted); font-size: 14px; margin-bottom: 40px; }
h1, h2, h3 { line-height: 1.3; letter-spacing: -0.01em; }
h1 { font-size: 1.875rem; margin: 2em 0 0.5em; } h2 { font-size: 1.5rem; margin: 1.75em 0 0.5em; } h3 { font-size: 1.25rem; margin: 1.5em 0 0.4em; }
p, ul, ol, blockquote, table, pre { margin: 0.6em 0; }
a { color: inherit; text-underline-offset: 2px; }
blockquote { border-left: 3px solid var(--fg); padding: 2px 0 2px 16px; margin-left: 0; }
code { font: 0.875em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); padding: 2px 5px; border-radius: 4px; }
pre { background: var(--soft); padding: 16px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 600; }
img { max-width: 100%; border-radius: 6px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
input[type=checkbox] { margin-right: 6px; }
@media print { body { padding: 0; } }
</style>
</head>
<body>
<h1 class="title">${doc.icon ? `${escapeHtml(doc.icon)} ` : ""}${escapeHtml(doc.title)}</h1>
<p class="meta">${escapeHtml(date)}</p>
${body}
</body>
</html>
`;
}

/** Copy the doc so it pastes formatted into Notion, Google Docs, email or Slack, or as Markdown in plain-text fields. */
export async function copyDocRichText(doc: Pick<Doc, "title" | "icon" | "content">) {
  try {
    const html = `<h1>${escapeHtml(doc.title)}</h1>${await bodyHtml(doc.content)}`;
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([docMarkdown(doc)], { type: "text/plain" }),
      }),
    ]);
    toast.success("Copied", { description: "Paste it into Notion, Google Docs, an email or Slack." });
  } catch (e) {
    toast.error("Couldn’t copy the doc", { description: errorMessage(e) });
  }
}

export async function copyDocMarkdown(doc: Pick<Doc, "title" | "icon" | "content">) {
  try {
    await navigator.clipboard.writeText(docMarkdown(doc));
    toast.success("Copied as Markdown");
  } catch (e) {
    toast.error("Couldn’t copy the doc", { description: errorMessage(e) });
  }
}

export async function downloadDoc(doc: Pick<Doc, "title" | "icon" | "content" | "updatedAt" | "date">, format: "md" | "html" | "doc") {
  try {
    if (format === "md") await api.saveTextFileAs(docFileName(doc.title, "md"), docMarkdown(doc));
    // Word opens a web page saved as .doc, keeping headings, lists and tables.
    else await api.saveTextFileAs(docFileName(doc.title, format), await exportDocHtml(doc));
  } catch (e) {
    toast.error(`Couldn’t save ${doc.title}`, { description: errorMessage(e) });
  }
}
