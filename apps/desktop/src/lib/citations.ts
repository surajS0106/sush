// Web citations inside assistant text. The transport writes each citation the
// provider reports as a markdown link with the text "cite" right after the
// text it backs; the message view turns those into numbered markers.

import type { SushUIMessage } from "@/lib/transport";

const CITE_TEXT = "cite";
const CITE_RE = /\s?\[cite\]\((\S+?)(?: "([^"]*)")?\)/g;

/** The markdown written into the text stream for one citation. */
export function citationMarker(url: string, title?: string | null): string {
  const href = url.replace(/[\s()]/g, encodeURIComponent);
  return title ? ` [${CITE_TEXT}](${href} "${title.replace(/"/g, "'")}")` : ` [${CITE_TEXT}](${href})`;
}

/** Whether a rendered link's text marks it as a citation. */
export const isCitationText = (text: unknown) => text === CITE_TEXT;

/** Text without its citation markers, for copying and for sending back to the model. */
export const stripCitations = (text: string) => text.replace(CITE_RE, "");

export interface CitedSource {
  n: number;
  url: string;
  title: string;
  domain: string;
  letter: string;
  tone: string;
}

// Literal classes so Tailwind picks them up.
const TONES = ["bg-sky-600", "bg-violet-600", "bg-amber-600", "bg-rose-600", "bg-teal-600", "bg-indigo-600", "bg-lime-700", "bg-fuchsia-600"];

export function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Every page a message cites, numbered in order of first citation. */
export function citedSources(message: SushUIMessage): CitedSource[] {
  const byUrl = new Map<string, CitedSource>();
  // Titles from search results, for markers the provider sent without one.
  const titles = new Map<string, string>();
  for (const p of message.parts) {
    if (p.type === "data-web") for (const s of p.data.sources) if (s.title) titles.set(s.url, s.title);
  }
  for (const p of message.parts) {
    if (p.type !== "text") continue;
    for (const [, href, title] of p.text.matchAll(CITE_RE)) {
      const url = safeDecode(href);
      if (byUrl.has(url)) continue;
      const domain = hostname(url);
      let hash = 0;
      for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      byUrl.set(url, {
        n: byUrl.size + 1,
        url,
        title: title || titles.get(url) || domain,
        domain,
        letter: (domain[0] ?? "?").toUpperCase(),
        tone: TONES[Math.abs(hash) % TONES.length],
      });
    }
  }
  return [...byUrl.values()];
}

function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}
