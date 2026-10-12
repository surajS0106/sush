// AI usage for Settings → Usage, tallied from the token counts each reply
// carries in its metadata. Only chats on this computer count, so deleting a
// chat removes its usage too.

import { costUsd } from "@/lib/pricing";
import type { Conversation } from "@/lib/store";

export type UsageRange = "7d" | "30d" | "all";

const RANGE_MS: Record<UsageRange, number> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: Infinity };

export interface Tally {
  inputTokens: number;
  outputTokens: number;
  replies: number;
  /** Estimated spend for the replies whose model has a known price. */
  usd: number;
  /** Tokens from models with no known price, left out of `usd`. */
  unpricedTokens: number;
}

export interface ModelUsage extends Tally {
  model: string;
  /** The provider of its most recent reply, for the logo. */
  providerId?: string;
  /** Every reply ran on this machine, so it cost nothing. */
  local: boolean;
  chats: number;
}

export interface UsageSummary {
  total: Tally;
  /** Most tokens first. */
  models: ModelUsage[];
  chat: Tally & { sessions: number };
  cowork: Tally & { sessions: number };
}

export const totalTokens = (t: Tally) => t.inputTokens + t.outputTokens;

const emptyTally = (): Tally => ({ inputTokens: 0, outputTokens: 0, replies: 0, usd: 0, unpricedTokens: 0 });

function add(t: Tally, input: number, output: number, usd: number | undefined) {
  t.inputTokens += input;
  t.outputTokens += output;
  t.replies += 1;
  if (usd === undefined) t.unpricedTokens += input + output;
  else t.usd += usd;
}

/** Start of the last `range`, for `summarizeUsage`. */
export const rangeStart = (range: UsageRange, now = Date.now()) => now - RANGE_MS[range];

/**
 * Tally replies since `since` (ms). Replies saved before their start time
 * was recorded count at their chat's last activity.
 */
export function summarizeUsage(conversations: Conversation[], localProviders: Set<string>, since: number): UsageSummary {
  const total = emptyTally();
  const chat = { ...emptyTally(), sessions: 0 };
  const cowork = { ...emptyTally(), sessions: 0 };
  const models = new Map<string, ModelUsage & { seen: Set<string> }>();

  for (const c of conversations) {
    const kind = c.workspaceId ? cowork : chat;
    let counted = false;
    for (const m of c.messages) {
      const meta = m.metadata;
      if (m.role !== "assistant" || meta?.outputTokens === undefined) continue;
      if ((meta.createdAt ?? c.updatedAt) < since) continue;
      const input = meta.inputTokens ?? 0;
      const output = meta.outputTokens;
      const local = localProviders.has(meta.providerId ?? "");
      const usd = costUsd(meta.model, input, output, local);
      add(total, input, output, usd);
      add(kind, input, output, usd);
      counted = true;

      const name = meta.model ?? "Unknown model";
      let row = models.get(name);
      if (!row) {
        row = { model: name, ...emptyTally(), local: true, chats: 0, seen: new Set() };
        models.set(name, row);
      }
      add(row, input, output, usd);
      row.local &&= local;
      if (meta.providerId) row.providerId = meta.providerId;
      row.seen.add(c.id);
    }
    if (counted) kind.sessions += 1;
  }

  return {
    total,
    models: [...models.values()]
      .map(({ seen, ...row }) => ({ ...row, chats: seen.size }))
      .sort((a, b) => totalTokens(b) - totalTokens(a)),
    chat,
    cowork,
  };
}

/** Local calendar day of a timestamp, as "YYYY-MM-DD", for `dailyReplies`. */
export function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Replies per local day, across chats and Cowork, for the activity heatmap.
 * Like `summarizeUsage`, older replies without a start time count on their
 * chat's last activity.
 */
export function dailyReplies(conversations: Conversation[]): Map<string, number> {
  const days = new Map<string, number>();
  for (const c of conversations) {
    for (const m of c.messages) {
      if (m.role !== "assistant") continue;
      const key = dayKey(m.metadata?.createdAt ?? c.updatedAt);
      days.set(key, (days.get(key) ?? 0) + 1);
    }
  }
  return days;
}
