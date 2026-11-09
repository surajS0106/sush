// "Compact now": the session's model summarises the conversation so far, and
// the summary goes into the thread as a message of its own
// (`metadata.compaction`, `thread_compact`). From then on the model reads the
// thread from that summary (`sush_core::agent::ui::to_core`), so the context
// it fills shrinks to the summary plus what follows. The earlier messages stay
// in the thread for the user to scroll back through.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { complete } from "@/lib/complete";
import { sessionTarget, threadMessages } from "@/lib/sessions";
import { createStore, threadMeta } from "@/lib/store";
import { api, errorMessage } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";

const SYSTEM = `You compact a conversation between a user and an AI assistant so the assistant can carry on from your summary alone; the original messages will no longer be available to it.

Write a thorough summary in Markdown with these sections, leaving out any that would be empty:
## Goal: what the user is trying to get done, in their terms, with every requirement and preference they stated.
## Key facts: names, numbers, links, file paths, decisions and conclusions reached so far. Quote exact values; don't paraphrase them.
## Work done: what the assistant did (tools used, files read or changed and how, searches) and what came of it.
## Current state: where things stand at the end of the conversation.
## Open items: unanswered questions, problems, and the next step the assistant was about to take.

Write it as notes for the assistant, not as a reply to the user. Output only the summary.`;

/** Characters of a tool's input or output kept in the transcript. */
const TOOL_CHARS = 1500;
/** Characters of transcript sent at most; past that the middle is cut. */
const TRANSCRIPT_CHARS = 400_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? null));

/** The conversation the model reads now, from the latest summary on, as plain text. */
export function transcript(messages: SushUIMessage[]): string {
  const from = Math.max(messages.findLastIndex((m) => m.metadata?.compaction), 0);
  const blocks: string[] = [];
  for (const m of messages.slice(from)) {
    if (m.metadata?.compaction) {
      blocks.push(`[Summary of the conversation before this point]\n${m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n")}`);
      continue;
    }
    const lines: string[] = [];
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) lines.push(p.text);
      else if (p.type === "file") lines.push(`[Attached: ${p.filename ?? p.mediaType}]`);
      else if (p.type === "dynamic-tool") {
        const result =
          p.state === "output-available"
            ? clip(asText(p.output), TOOL_CHARS)
            : p.state === "output-error"
              ? `Error: ${clip(p.errorText ?? "", TOOL_CHARS)}`
              : "(no result)";
        lines.push(`[Tool ${p.toolName}(${clip(asText(p.input), TOOL_CHARS)})]\n→ ${result}`);
      }
    }
    if (lines.length) blocks.push(`${m.role === "user" ? "User" : "Assistant"}:\n${lines.join("\n")}`);
  }
  const text = blocks.join("\n\n---\n\n");
  if (text.length <= TRANSCRIPT_CHARS) return text;
  // The start says what the work is for; the end says where it stands.
  const head = Math.floor(TRANSCRIPT_CHARS * 0.25);
  return `${text.slice(0, head)}\n\n[… ${text.length - TRANSCRIPT_CHARS} characters of the middle left out …]\n\n${text.slice(-(TRANSCRIPT_CHARS - head))}`;
}

/** Whether there's anything since the latest summary to compact. */
export function canCompact(messages: SushUIMessage[]): boolean {
  const from = messages.findLastIndex((m) => m.metadata?.compaction);
  return messages.slice(from + 1).some((m) => m.role === "assistant");
}

/** Threads being compacted now. */
const compacting = createStore<ReadonlySet<string>>("sush.compacting", new Set(), false, false);

export function useCompacting(id: string | undefined): boolean {
  return useSyncExternalStore(compacting.subscribe, () => !!id && compacting.get().has(id));
}

function mark(id: string, on: boolean) {
  compacting.set((prev) => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
}

/** Summarise a session's conversation and make the summary where the model starts reading. */
export async function compactThread(id: string, tokensBefore?: number): Promise<void> {
  if (compacting.get().has(id)) return;
  const thread = threadMeta(id);
  const target = sessionTarget(id);
  if (!thread || !target) {
    toast.error("Couldn’t compact this chat", { description: target ? "This session is gone." : "Pick a model first." });
    return;
  }
  const messages = threadMessages(id);
  if (!canCompact(messages)) return;
  mark(id, true);
  try {
    const summary = (await complete(target, SYSTEM, transcript(messages))).trim();
    if (!summary) throw new Error("The model returned an empty summary.");
    const message: SushUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: summary }],
      metadata: { compaction: { tokensBefore, model: target.model, createdAt: Date.now() } },
    };
    await api.threadCompact(thread, message);
  } catch (e) {
    toast.error("Couldn’t compact this chat", { description: errorMessage(e) });
  } finally {
    mark(id, false);
  }
}
