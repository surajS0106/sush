// Joining an audio overview: the listener interrupts with a question, and the
// two hosts answer it from the notebook's sources in a few spoken turns, then
// pick up where they were. The passages come from the notebook's search
// (`notebook_search`, BM25 over its checked sources); the reply is a one-shot
// call with the model last used. Nothing is kept: the answer is part of this
// listening only.

import { complete, extractJson } from "@/lib/complete";
import { getTarget } from "@/lib/store";
import { api, type AudioTurn } from "@/lib/tauri";

/** Passages the hosts may answer from. */
const PASSAGES = 6;
/** How much of the script so far they're reminded of. */
const CONTEXT_TURNS = 8;

const SYSTEM = `You are the two hosts of an audio overview: a podcast-style conversation about the sources in the listener's notebook. Host a leads and frames; host b asks, pushes back and connects ideas.
A listener has just joined and asked a question, interrupting you. Answer them on air, then hand back to the conversation.
Reply with only a JSON object, no prose or code fences:
{"turns": [{"host": "a", "text": "...", "source": "sushsrc:..."}, ...]}
- 2 to 4 turns, 50 to 160 words in all. Spoken style: short sentences, plain words, real reactions.
- The first turn welcomes the question naturally ("Oh, good question…"), without a name for the listener.
- Answer only from the passages given. If they don't answer it, say plainly that the sources don't cover that, and say what they do say that's closest.
- Give each turn's "source" as the id of the passage it rests on, exactly as given, or leave it out.
- The last turn steers back to what you were discussing, so the line that was interrupted follows naturally.
- No stage directions, sound effects or host names; numbers and symbols written as they're said.`;

export type HostLine = { chapter: string; turn: AudioTurn };

/**
 * The hosts' answer to `question`, asked while `now` was playing, after `before`.
 * Throws with a message for the user when it can't answer.
 */
export async function answerOnAir(notebookId: string, question: string, before: HostLine[], now: HostLine | undefined): Promise<AudioTurn[]> {
  const target = getTarget();
  if (!target) throw new Error("Pick a model to chat with first; the hosts answer with it.");
  const passages = await api.notebookSearch(notebookId, question, PASSAGES);
  const ids = new Set(passages.map((p) => `sushsrc:${p.sourceId}/${p.id}`));
  const host = (t: AudioTurn) => (t.host === "a" ? "A" : "B");
  const user = [
    `<script_so_far chapter="${(now ?? before[before.length - 1])?.chapter.replace(/"/g, "'") ?? ""}">`,
    ...before.slice(-CONTEXT_TURNS).map((l) => `${host(l.turn)}: ${l.turn.text}`),
    "</script_so_far>",
    now ? `<interrupted_line>\n${host(now.turn)}: ${now.turn.text}\n</interrupted_line>` : "",
    "<passages>",
    ...(passages.length
      ? passages.map((p) => `<passage id="sushsrc:${p.sourceId}/${p.id}"${p.page ? ` page="${p.page}"` : ""}>\n${p.text}\n</passage>`)
      : ["(No passage in the sources matches this question.)"]),
    "</passages>",
    `<listener_question>\n${question}\n</listener_question>`,
  ]
    .filter(Boolean)
    .join("\n");

  const reply = extractJson(await complete(target, SYSTEM, user)) as { turns?: unknown };
  const turns = (Array.isArray(reply.turns) ? reply.turns : []).flatMap((t): AudioTurn[] => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    const h = typeof o.host === "string" ? o.host.trim().toLowerCase() : "";
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if ((h !== "a" && h !== "b") || !text) return [];
    // Only passages it was given: never a made-up id.
    const source = typeof o.source === "string" && ids.has(o.source.split("?")[0]) ? o.source.split("?")[0] : null;
    return [{ host: h, text: text.slice(0, 2000), source }];
  });
  if (turns.length === 0) throw new Error("The hosts didn’t come up with an answer. Try asking another way.");
  return turns.slice(0, 6);
}
