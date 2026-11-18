// The model's tools for the user's Binders (`lib/notebooks.ts`; "notebooks" in code):
// collections of sources (PDFs, pages, notes) a binder's own chats answer from. These
// let any chat reach them.
//
//   binder_list    runs at once: binders and their sources
//   binder_search  runs at once: passages from one binder's sources (`notebook_search` in Rust)
//   binder_add     adds a link or a text note to a binder, making the binder if it's new; asks with a card

import type { AppToolset, Args, PlanResult, ToolContext, ToolResult } from "@/lib/app-tool-kit";
import { clip, day, findBy, str } from "@/lib/app-tool-kit";
import { addLink, addText, createNotebook, getNotebooks } from "@/lib/notebooks";
import { api, errorMessage, type Notebook, type Passage, type ToolSpec } from "@/lib/tauri";

export const BINDER_LIST = "binder_list";
export const BINDER_SEARCH = "binder_search";
export const BINDER_ADD = "binder_add";

const listTool: ToolSpec = {
  name: BINDER_LIST,
  description:
    "List the user's Binders in Sush: collections of sources (PDFs, web pages, papers, videos, notes) they've gathered on a topic. " +
    "Use it when they mention a binder, their research or saved sources, then search one with binder_search.",
  inputSchema: { type: "object", properties: {} },
};

const searchTool: ToolSpec = {
  name: BINDER_SEARCH,
  description:
    "Search the sources in one of the user's Binders and get the matching passages. Answer from them and name the source " +
    "(and page) each point comes from. Search again with other words if the first passages don't answer it.",
  inputSchema: {
    type: "object",
    properties: {
      binder: { type: "string", description: "Its id or exact title from binder_list." },
      query: { type: "string", description: "Words to look for." },
      limit: { type: "number", description: "Passages to return, up to 15 (default 8)." },
    },
    required: ["binder", "query"],
  },
};

const addTool: ToolSpec = {
  name: BINDER_ADD,
  description:
    "Add a source to one of the user's Binders: a link (web page, paper, YouTube video) or a text note, e.g. something you " +
    "found or wrote for them. A binder title that doesn't exist yet makes a new binder. The user approves it.",
  inputSchema: {
    type: "object",
    properties: {
      binder: { type: "string", description: "Its id or exact title; a new title makes a new binder." },
      url: { type: "string", description: "A link to add." },
      title: { type: "string", description: "A text note's title." },
      text: { type: "string", description: "A text note's content (markdown)." },
    },
    required: ["binder"],
  },
};

function brief(n: Notebook) {
  return {
    id: n.id,
    title: n.title,
    updated: day(n.updatedAt),
    sources: n.sources.slice(0, 40).map((s) => ({
      title: s.title,
      kind: s.kind,
      ...(s.status !== "ready" ? { status: s.status } : {}),
      ...(!s.checked ? { searched: false } : {}),
    })),
    ...(n.sources.length > 40 ? { moreSources: n.sources.length - 40 } : {}),
    ...(n.notes.length ? { notes: n.notes.length } : {}),
  };
}

async function read(name: string, args: Args): Promise<ToolResult> {
  const all = getNotebooks();
  if (name === BINDER_LIST) {
    return { output: JSON.stringify({ binders: all.map(brief), ...(all.length === 0 ? { note: "No binders yet." } : {}) }) };
  }
  const found = findBy(all, str(args.binder), (n) => n.title, "binder", BINDER_LIST);
  if (!found.ok) return { errorText: found.error };
  const binder = found.item;
  const query = str(args.query);
  if (!query) return { errorText: "Pass `query`: the words to look for." };
  const limit = Math.min(15, Math.max(1, Number(args.limit) || 8));
  let passages: Passage[];
  try {
    passages = await api.notebookSearch(binder.id, query, limit);
  } catch (e) {
    return { errorText: errorMessage(e) };
  }
  const titles = new Map(binder.sources.map((s) => [s.id, s.title]));
  if (passages.length === 0) {
    const ready = binder.sources.filter((s) => s.status === "ready" && s.checked).length;
    return { output: ready ? "No passages matched. Try other or fewer words." : `"${binder.title}" has no sources that can be searched yet.` };
  }
  return {
    output: JSON.stringify({
      binder: binder.title,
      passages: passages.map((p) => ({
        source: titles.get(p.sourceId) ?? "a source",
        ...(p.page != null ? { page: p.page } : {}),
        ...(p.heading ? { heading: p.heading } : {}),
        text: clip(p.text, 2000),
      })),
    }),
  };
}

async function plan(_name: string, args: Args, _ctx: ToolContext): Promise<PlanResult> {
  const ref = str(args.binder);
  if (!ref) return { error: "Say which binder: its id or title (a new title makes a new binder)." };
  const url = str(args.url);
  const text = str(args.text);
  const title = str(args.title);
  if (!url && !text) return { error: "Pass a `url` to add, or a `title` and `text` for a note." };
  if (url && text) return { error: "Add one source per call: a url or a text note." };
  if (url && !/^https?:\/\//i.test(url)) return { error: "`url` must start with http:// or https://." };
  if (text && !title) return { error: "Give the note a `title`." };
  const all = getNotebooks();
  const existing = all.find((n) => n.id === ref) ?? all.filter((n) => n.title.toLowerCase() === ref.toLowerCase())[0];
  const binderTitle = existing?.title ?? ref;
  return {
    title: `Add this to ${existing ? "" : "a new binder, "}“${binderTitle}”?`,
    rows: url ? [{ label: "Link", value: url }] : [{ label: "Note", value: title! }],
    body: text ? clip(text, 1200) : undefined,
    confirm: "Add",
    apply: async () => {
      const binder = existing ?? (await createNotebook(binderTitle));
      if (!binder) return { errorText: "Couldn't make the binder; the app showed the user why." };
      const source = url ? await addLink(binder.id, url) : await addText(binder.id, title!, text!);
      if (!source) return { errorText: "Couldn't add it; the app showed the user why." };
      return {
        output: `Added "${source.title}" to ${existing ? "" : "the new binder "}"${binder.title}".${source.status === "reading" ? " It's still being read, so it can't be searched for a moment." : ""}`,
      };
    },
  };
}

export const binderToolset: AppToolset = {
  id: "binders",
  noun: "your binders",
  specs: [listTool, searchTool, addTool],
  reads: new Set([BINDER_LIST, BINDER_SEARCH]),
  read,
  plan,
};
