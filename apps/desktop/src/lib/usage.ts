// AI usage for Settings → Usage and the Cowork start screen, tallied from the token counts each reply
// carries in its metadata. Only chats on this computer count, so deleting a
// chat removes its usage too.

import { costUsd, formatUsd } from "@/lib/pricing";
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

// Token counts always use international grouping and K / M / B, whatever the
// OS locale ("en-IN" would otherwise give lakh and crore, "10L", "1Cr").
const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const exactTokens = new Intl.NumberFormat("en-US");
/** 1_234_567 → "1.2M". */
export const formatTokens = (n: number) => compactTokens.format(n);
/** 1_234_567 → "1,234,567". */
export const formatTokensExact = (n: number) => exactTokens.format(n);

/** "$4.21", "Free", or "—" when nothing in the tally has a known price. */
export function formatSpend(t: Tally, local = false) {
  if (local) return "Free";
  if (t.unpricedTokens > 0 && t.usd === 0) return "—";
  return formatUsd(t.usd);
}

/** Colours for the biggest models, in order; the rest share `OTHER_MODEL_COLOR`. */
export const MODEL_COLORS = ["bg-brand", "bg-amber-400", "bg-emerald-500", "bg-sky-500", "bg-violet-500"];
export const OTHER_MODEL_COLOR = "bg-muted-foreground/40";

export const emptyTally = (): Tally => ({ inputTokens: 0, outputTokens: 0, replies: 0, usd: 0, unpricedTokens: 0 });

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

/** Local calendar day of a timestamp, as "YYYY-MM-DD", for `activity`. */
export function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface DayUsage {
  replies: number;
  /** Tokens (input + output) per model. */
  tokens: Map<string, number>;
  /** Estimated spend for the day's priced replies. */
  usd: number;
}

export interface Activity {
  /** Keyed by `dayKey`. */
  days: Map<string, DayUsage>;
  /** Prompts and replies. */
  messages: number;
  /** Replies per local hour of the day, 0–23. */
  hours: number[];
}

/**
 * Replies, tokens and spend per local day since `since` (ms), across chats and
 * Cowork, for the start screen's activity card. Like `summarizeUsage`, replies
 * without a start time count on their chat's last activity; a prompt counts
 * when the reply to it started.
 */
export function activity(conversations: Conversation[], localProviders: Set<string>, since: number): Activity {
  const days = new Map<string, DayUsage>();
  const hours = new Array<number>(24).fill(0);
  let messages = 0;

  for (const c of conversations) {
    // Walk backwards so each prompt can take the time of the reply after it.
    let next = c.updatedAt;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i];
      const meta = m.metadata;
      const at = meta?.createdAt ?? next;
      next = at;
      if (at < since) continue;
      if (m.role === "user") messages += 1;
      if (m.role !== "assistant") continue;
      messages += 1;

      const key = dayKey(at);
      let day = days.get(key);
      if (!day) {
        day = { replies: 0, tokens: new Map(), usd: 0 };
        days.set(key, day);
      }
      day.replies += 1;
      hours[new Date(at).getHours()] += 1;
      if (meta?.outputTokens === undefined) continue;
      const input = meta.inputTokens ?? 0;
      const name = meta.model ?? "Unknown model";
      day.tokens.set(name, (day.tokens.get(name) ?? 0) + input + meta.outputTokens);
      day.usd += costUsd(meta.model, input, meta.outputTokens, localProviders.has(meta.providerId ?? "")) ?? 0;
    }
  }
  return { days, messages, hours };
}
