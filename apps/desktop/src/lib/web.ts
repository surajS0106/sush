// The `web_search` and `web_fetch` tools: the model looks things up on the web and reads
// pages, deciding for itself when to. They run in Rust (`sush_core::web`): search through
// Ollama's web search with the user's Ollama key (Settings → Search), and pages through
// Ollama too, or fetched from this machine (public addresses only) without a key.
// Anthropic and OpenAI models get their provider's own search under the same names: the
// wire formats swap these specs for native tools, so these runners never see those calls.

import { api, errorMessage, type ToolSpec, type WebSearchResult } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";

export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";

const MAX_QUERY = 400;

export const webSearchTool: ToolSpec = {
  name: WEB_SEARCH,
  description:
    "Search the web. Use it when the answer depends on recent or changing information (news, prices, releases, " +
    "schedules, who holds a role now, the latest version of something), on details you aren't sure of, or when the " +
    "user asks you to look something up. Don't use it for what you know well: settled facts, coding, maths, writing. " +
    "Write a short query as you would type it into a search engine. Search again with a different query if the " +
    "results miss, and read the most useful pages with web_fetch before relying on them.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query, in the words a search engine expects." },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "How many results, 5 when left out." },
    },
    required: ["query"],
  },
};

export const webFetchTool: ToolSpec = {
  name: WEB_FETCH,
  description:
    "Read a web page as text. Use it on a URL the user gave you or one from web_search results when its snippet " +
    "isn't enough. A long page comes in parts: call again with `offset` set to the `nextOffset` you were given.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The page's full address." },
      offset: { type: "integer", minimum: 0, description: "Where to carry on reading a long page, from `nextOffset`." },
    },
    required: ["url"],
  },
};

/** Standing instructions while the tools are offered. Kept free of dates and other per-request values for caching. */
export const WEB_SECTION =
  "You can search the web with web_search and read pages with web_fetch. Decide for yourself when a question needs " +
  "them; most don't. When you use what you found, say so plainly and cite it. When the question is about a notable " +
  "person, place, organisation or work, also call topic_lookup for it (searching doesn't show the user any photos).";

/** Added when the user turns on Research: a thorough, sourced answer. */
export const RESEARCH_SECTION =
  "Research mode is on: the user wants a thorough, well-sourced answer. Search several times from different angles, " +
  "read the most relevant pages in full with web_fetch, check claims against more than one source where you can, " +
  "and cite each one. Say where sources disagree or where you couldn't find something.";

const CITE =
  'Right after a fact from a result, write the marker [cite](URL "TITLE") with its `url` and `title`; the app shows it ' +
  "as a numbered source. Snippets are short: read a page with web_fetch before relying on details. Today is ";

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  note: string;
}

export interface WebFetchOutput {
  url: string;
  title: string | null;
  content: string;
  nextOffset: number | null;
  note: string;
}

/** Today's date for the model, which it needs to judge how recent results are. In the output, not the system prompt. */
const today = () => new Date().toISOString().slice(0, 10);

type Result<T> = { output: T } | { errorText: string };

export async function runWebSearch(input: unknown): Promise<Result<WebSearchOutput>> {
  const { query, max_results } = (input ?? {}) as { query?: unknown; max_results?: unknown };
  if (typeof query !== "string" || !query.trim()) return { errorText: "web_search needs a `query`." };
  if (query.length > MAX_QUERY) return { errorText: `\`query\` must be ${MAX_QUERY} characters or fewer.` };
  const max = typeof max_results === "number" && Number.isFinite(max_results) ? Math.round(max_results) : undefined;
  try {
    const results = await api.webSearch(query.trim(), max);
    const note = results.length > 0 ? `${CITE}${today()}.` : "No results. Try a shorter or differently worded query.";
    return { output: { query: query.trim(), results, note } };
  } catch (e) {
    return {
      errorText:
        `Couldn't search: ${errorMessage(e)}. Tell the user, answer from what you know and say it may be out of date. ` +
        "web_fetch still reads a page whose address you know.",
    };
  }
}

export async function runWebFetch(input: unknown): Promise<Result<WebFetchOutput>> {
  const { url, offset } = (input ?? {}) as { url?: unknown; offset?: unknown };
  if (typeof url !== "string" || !url.trim()) return { errorText: "web_fetch needs a `url`." };
  const from = typeof offset === "number" && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : undefined;
  try {
    const page = await api.webFetch(url.trim(), from);
    const more = page.nextOffset !== null ? ` The page goes on: call again with offset ${page.nextOffset} for more.` : "";
    const note = `Cite this page as [cite](${page.url} "${(page.title ?? page.url).replace(/"/g, "'")}") after what it backs. Today is ${today()}.${more}`;
    return { output: { ...page, note } };
  } catch (e) {
    return { errorText: `Couldn't read that page: ${errorMessage(e)}.` };
  }
}

export interface WebSourceLink {
  url: string;
  title?: string | null;
}

/** A URL as the reply's citations read it: Rust encodes brackets and spaces for the markers. */
const plainUrl = (url: string) => url.replace(/%28/g, "(").replace(/%29/g, ")").replace(/%20/g, " ");

/** The pages a finished call found or read, for its activity row and the reply's sources. */
export function webSources(name: string, output: unknown): WebSourceLink[] {
  if (!output || typeof output !== "object") return [];
  if (name === WEB_SEARCH) return ((output as WebSearchOutput).results ?? []).map((r) => ({ url: plainUrl(r.url), title: r.title }));
  if (name === WEB_FETCH) {
    const page = output as WebFetchOutput;
    return page.url ? [{ url: plainUrl(page.url), title: page.title }] : [];
  }
  return [];
}

/** Pages a message part turned up: the provider's own search (`data-web`) or Sush's tools. */
export function partWebSources(p: SushUIMessage["parts"][number]): WebSourceLink[] {
  if (p.type === "data-web") return p.data.sources;
  if (p.type === "dynamic-tool" && p.state === "output-available") return webSources(p.toolName, p.output);
  return [];
}
