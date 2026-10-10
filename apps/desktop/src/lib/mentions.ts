// `@github`, `@notion`: the user points the model at a connector. The composer offers
// active connectors after `@`; a sent message that mentions one reaches the model
// with a note to use that connector's tools.

import { connectorToolPrefix } from "@/lib/agent";
import { activeConnectors, library, type Connector } from "@/lib/library";
import { slugify } from "@/lib/skills";

/** `Google Drive` -> `google-drive`, what follows the `@`. */
export const mentionName = (c: Connector) => slugify(c.name);

export const mentionables = (): Connector[] => activeConnectors();

const findMentionable = (name: string) => mentionables().find((c) => mentionName(c) === name.toLowerCase());

// `@name` at the start or after whitespace/punctuation, so emails (a@b.com) don't count.
const MENTION = /(^|[\s([{"'])@([a-z0-9][a-z0-9-]*)/gi;

/** Text split into plain runs and known mentions, for painting chips. */
export function mentionSegments(text: string): { text: string; connector?: Connector }[] {
  const out: { text: string; connector?: Connector }[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const connector = findMentionable(m[2]);
    if (!connector) continue;
    const start = (m.index ?? 0) + m[1].length;
    const end = start + 1 + m[2].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: text.slice(start, end), connector });
    last = end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export const hasMentions = (text: string) => mentionSegments(text).some((s) => s.connector);

/** The `@query` being typed right before the caret, if any. */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s([{"'])@([a-z0-9-]*)$/i.exec(value.slice(0, caret));
  return m ? { start: m.index + m[1].length, query: m[2].toLowerCase() } : null;
}

/** `text` plus a note on the connectors that `typed` (what the user wrote) mentions. */
export function expandMentions(text: string, typed = text): string {
  const mentioned = [...new Set(mentionSegments(typed).flatMap((s) => (s.connector ? [s.connector] : [])))];
  if (mentioned.length === 0) return text;
  const status = library.connectorStatus();
  const notes = mentioned.map((c) =>
    status[c.id]?.state === "ready"
      ? `- @${mentionName(c)} is the ${c.name} connector: use its tools (named ${connectorToolPrefix(c)}*) for this request.`
      : `- @${mentionName(c)} is the ${c.name} connector, but it isn't connected right now. Tell the user to reconnect it in Customize → Connectors.`,
  );
  return `${text}\n\n<mentioned_connectors>\n${notes.join("\n")}\n</mentioned_connectors>`;
}
