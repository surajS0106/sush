// Usage budget: a spend or token limit per day, week or month, alerts as
// usage crosses its thresholds, and optionally no new requests past the limit.
// The budget is a preference (localStorage); usage is tallied from the chats
// (lib/usage.ts), so it needs no counter of its own.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { openSettings } from "@/lib/library";
import { formatUsd, isLocalUrl } from "@/lib/pricing";
import { createStore, getConversations, subscribeConversations } from "@/lib/store";
import type { ProviderView } from "@/lib/tauri";
import { formatTokens, summarizeUsage, totalTokens, type UsageSummary } from "@/lib/usage";

export type BudgetPeriod = "day" | "week" | "month";
export type BudgetUnit = "usd" | "tokens";

export interface Budget {
  enabled: boolean;
  unit: BudgetUnit;
  limit: number;
  period: BudgetPeriod;
  /** Percentages of the limit that raise an alert, ascending. */
  thresholds: number[];
  notify: boolean;
  /** Refuse new requests once the limit is reached (answering a waiting tool call still works). */
  pauseAtLimit: boolean;
}

export const THRESHOLD_CHOICES = [25, 50, 75, 80, 90, 100];

const DEFAULT_BUDGET: Budget = {
  enabled: false,
  unit: "usd",
  limit: 20,
  period: "month",
  thresholds: [50, 80, 100],
  notify: true,
  pauseAtLimit: false,
};

const budget = createStore<Budget>("sush.budget", DEFAULT_BUDGET);
/** Which thresholds already alerted, for one period and limit (`alertKey`). */
const alerted = createStore<{ key: string; thresholds: number[] }>("sush.budget.alerted", { key: "", thresholds: [] });

export const useBudget = () => useSyncExternalStore(budget.subscribe, budget.get);
export const getBudget = () => ({ ...DEFAULT_BUDGET, ...budget.get() });

export function setBudget(change: Partial<Budget>) {
  budget.set((b) => ({ ...DEFAULT_BUDGET, ...b, ...change }));
}

// --- periods ----------------------------------------------------------------------

/** Local midnight that starts the period containing `now` (weeks start on Monday). */
export function periodStart(period: BudgetPeriod, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === "month") d.setDate(1);
  return d.getTime();
}

export function periodEnd(period: BudgetPeriod, now = Date.now()) {
  const d = new Date(periodStart(period, now));
  if (period === "day") d.setDate(d.getDate() + 1);
  if (period === "week") d.setDate(d.getDate() + 7);
  if (period === "month") d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

export const PERIOD_NOUN: Record<BudgetPeriod, string> = { day: "today", week: "this week", month: "this month" };

// --- status -----------------------------------------------------------------------

export interface BudgetStatus {
  used: number;
  limit: number;
  /** used / limit; above 1 when over. */
  fraction: number;
  start: number;
  end: number;
  /** Where usage lands at the end of the period at the pace so far; undefined too early in it to say. */
  projected?: number;
  /** The highest threshold reached, if any. */
  reached?: number;
  /** Usage for the period, for the breakdown. */
  summary: UsageSummary;
}

export function budgetStatus(b: Budget, localProviders: Set<string>, now = Date.now()): BudgetStatus {
  const start = periodStart(b.period, now);
  const end = periodEnd(b.period, now);
  const summary = summarizeUsage(getConversations(), localProviders, start);
  const used = b.unit === "usd" ? summary.total.usd : totalTokens(summary.total);
  const fraction = b.limit > 0 ? used / b.limit : 0;
  const elapsed = (now - start) / (end - start);
  return {
    used,
    limit: b.limit,
    fraction,
    start,
    end,
    // Before a tenth of the period has passed, a straight-line pace is mostly noise.
    projected: elapsed >= 0.1 ? used / elapsed : undefined,
    reached: [...b.thresholds].reverse().find((t) => fraction * 100 >= t),
    summary,
  };
}

export function formatAmount(amount: number, unit: BudgetUnit) {
  return unit === "usd" ? (amount === 0 ? "$0" : formatUsd(amount)) : `${formatTokens(amount)} tokens`;
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
/** Only there to keep the number exact; any real budget is far below it. */
const MAX_LIMIT: Record<BudgetUnit, number> = { usd: 1e9, tokens: 1e15 };
const MAX_LABEL: Record<BudgetUnit, string> = { usd: "$1B", tokens: "1,000T tokens" };

export type ParsedLimit = { value: number; error?: undefined } | { value?: undefined; error: string };

/** "20", "$20", "10,000,000", "500k", "2.5M", "5B" → a number, or why it isn't one. */
export function parseLimit(text: string, unit: BudgetUnit): ParsedLimit {
  const clean = text.trim().replace(/[$,\s]/g, "");
  const example = unit === "usd" ? "20" : "10M";
  if (!clean) return { error: `Enter a limit, like ${example}.` };
  const m = clean.match(/^(\d*\.?\d+)([a-z]*)$/i);
  if (!m) return { error: `Try a number, like ${example}.` };
  const scale = m[2] ? SUFFIX[m[2].toLowerCase()] : 1;
  if (scale === undefined) {
    return { error: unit === "usd" ? `Try a plain amount, like ${example}.` : `Use K, M or B instead of "${m[2]}", like ${example}.` };
  }
  const value = Number(m[1]) * scale;
  if (!(value > 0)) return { error: "Set a limit above 0." };
  if (value > MAX_LIMIT[unit]) return { error: `Try ${MAX_LABEL[unit]} or less.` };
  return { value };
}

// --- enforcement and alerts -------------------------------------------------------

let localProviders = new Set<string>();

/**
 * Why a new request can't start, or null. A spend budget never blocks a
 * local model, since it costs nothing.
 */
export function budgetBlock(providerId: string): string | null {
  const b = getBudget();
  if (!b.enabled || !b.pauseAtLimit) return null;
  if (b.unit === "usd" && localProviders.has(providerId)) return null;
  const s = budgetStatus(b, localProviders);
  if (s.fraction < 1) return null;
  return `You've used ${formatAmount(s.used, b.unit)} of your ${formatAmount(b.limit, b.unit)} budget ${PERIOD_NOUN[b.period]}. Raise it in Settings → Usage, or wait for it to reset.`;
}

const alertKey = (b: Budget, start: number) => `${b.period}:${start}:${b.unit}:${b.limit}`;

function checkThresholds() {
  const b = getBudget();
  if (!b.enabled || !b.notify) return;
  const s = budgetStatus(b, localProviders);
  const key = alertKey(b, s.start);
  const seen = alerted.get().key === key ? alerted.get().thresholds : [];
  const fresh = b.thresholds.filter((t) => s.fraction * 100 >= t && !seen.includes(t));
  if (fresh.length === 0) return;
  alerted.set({ key, thresholds: [...seen, ...fresh] });

  // One toast for the highest new threshold, even if a long reply jumped several.
  const top = Math.max(...fresh);
  const amounts = `${formatAmount(s.used, b.unit)} of ${formatAmount(b.limit, b.unit)}`;
  const action = { label: "View usage", onClick: () => openSettings({ section: "usage" }) };
  if (top >= 100) {
    toast.error(`You've reached your budget ${PERIOD_NOUN[b.period]}`, {
      description: b.pauseAtLimit ? `${amounts}. New requests are paused until it resets.` : amounts,
      action,
      duration: 10_000,
    });
  } else {
    toast.warning(`${top}% of your budget used ${PERIOD_NOUN[b.period]}`, { description: amounts, action });
  }
}

/**
 * Keep the local-provider list current and alert as usage crosses
 * thresholds. Returns a function that stops watching.
 */
export function watchBudget(providers: ProviderView[]) {
  localProviders = new Set(providers.filter((p) => isLocalUrl(p.baseUrl)).map((p) => p.id));
  // Conversations change on every streamed delta; tally once things settle.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(checkThresholds, 1500);
  };
  const offConversations = subscribeConversations(schedule);
  const offBudget = budget.subscribe(schedule);
  schedule();
  return () => {
    clearTimeout(timer);
    offConversations();
    offBudget();
  };
}
