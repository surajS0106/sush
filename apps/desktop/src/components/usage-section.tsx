// Settings → Usage: the budget meter, then tokens and estimated spend per
// model, laid out like macOS's Storage page (a stacked bar with a legend over
// grouped rows), then the budget's settings.

import { AlertTriangleIcon, FolderIcon, InfoIcon, MessageSquareIcon, OctagonPauseIcon, TrendingUpIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Logo } from "@/components/model-picker";
import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  budgetStatus,
  formatAmount,
  parseLimit,
  PERIOD_NOUN,
  setBudget,
  THRESHOLD_CHOICES,
  useBudget,
  type Budget,
  type BudgetStatus,
  type BudgetUnit,
} from "@/lib/budget";
import { modelLogo, providerLogo } from "@/lib/logos";
import { formatUsd, isLocalUrl, priceFor } from "@/lib/pricing";
import { useConversations } from "@/lib/store";
import type { ProviderView } from "@/lib/tauri";
import { formatTokens, formatTokensExact, rangeStart, summarizeUsage, totalTokens, type ModelUsage, type Tally, type UsageRange } from "@/lib/usage";
import { cn } from "@/lib/utils";

/** Bar colors for the biggest models, in order; the rest share "Other". */
const COLORS = ["bg-brand", "bg-amber-400", "bg-emerald-500", "bg-sky-500", "bg-violet-500"];
const OTHER_COLOR = "bg-muted-foreground/40";

interface Segment {
  label: string;
  tokens: number;
  color: string;
}

/** "$4.21", "Free", or "—" when nothing in the tally has a known price. */
function spend(t: Tally, local = false) {
  if (local) return "Free";
  if (t.unpricedTokens > 0 && t.usd === 0) return "—";
  return formatUsd(t.usd);
}

export function UsageSection({ providers }: { providers: ProviderView[] }) {
  const conversations = useConversations();
  const [range, setRange] = useState<UsageRange>("30d");
  const localProviders = useMemo(
    () => new Set(providers.filter((p) => isLocalUrl(p.baseUrl)).map((p) => p.id)),
    [providers],
  );
  const usage = useMemo(
    () => summarizeUsage(conversations, localProviders, rangeStart(range)),
    [conversations, localProviders, range],
  );

  const logoFor = (m: ModelUsage) => {
    const provider = providers.find((p) => p.id === m.providerId);
    return modelLogo(m.model) || (provider && providerLogo(provider)) || undefined;
  };

  const top = usage.models.slice(0, COLORS.length);
  const rest = usage.models.slice(COLORS.length);
  const segments: Segment[] = [
    ...top.map((m, i) => ({ label: m.model, tokens: totalTokens(m), color: COLORS[i] })),
    ...(rest.length > 0 ? [{ label: "Other", tokens: rest.reduce((n, m) => n + totalTokens(m), 0), color: OTHER_COLOR }] : []),
  ];
  const all = totalTokens(usage.total);

  const budget = useBudget();
  const status = useMemo(
    () => (budget.enabled ? budgetStatus(budget, localProviders) : null),
    // Conversations aren't read here, but a new reply should refresh the meter.
    [budget, localProviders, conversations],
  );

  return (
    <Page>
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Budget</h2>
        {status ? (
          <>
            <BudgetMeter budget={budget} status={status} />
            <BudgetAdvice budget={budget} status={status} />
          </>
        ) : (
          <Card className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium">No budget set</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Set a spend or token limit to get alerts as you approach it.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setBudget({ enabled: true })}>
              Set a budget
            </Button>
          </Card>
        )}
      </div>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">Usage</h2>
        <Segmented
          label="Period"
          value={range}
          onChange={setRange}
          options={[
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
            { value: "all", label: "All time" },
          ]}
        />
      </div>

      <div className="-mt-4 flex flex-col gap-4">
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm font-medium">AI usage</p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {formatTokens(all)} tokens · {spend(usage.total)}
              {usage.total.unpricedTokens > 0 && usage.total.usd > 0 && "+"}
            </p>
          </div>
          <UsageBar segments={segments} total={all} />
          {segments.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {segments.map((s) => (
                <li key={s.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn("size-2 rounded-full", s.color)} aria-hidden />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {usage.models.length === 0 ? (
          <Card className="px-4 py-10 text-center text-sm text-muted-foreground">
            No replies {range === "all" ? "yet" : `in the last ${range === "7d" ? "7" : "30"} days`}.
          </Card>
        ) : (
          <>
            <Card>
              {usage.models.map((m) => (
                <Row
                  key={m.model}
                  icon={<Logo src={logoFor(m)} className="size-4" />}
                  label={m.model}
                  tally={m}
                  local={m.local}
                  mono
                  details={<ModelDetails usage={m} />}
                />
              ))}
            </Card>
            <Card>
              <Row
                icon={<MessageSquareIcon className="size-4" />}
                label="Chats"
                tally={usage.chat}
                details={<KindDetails tally={usage.chat} sessions={usage.chat.sessions} noun="chat" />}
              />
              <Row
                icon={<FolderIcon className="size-4" />}
                label="Cowork"
                tally={usage.cowork}
                details={<KindDetails tally={usage.cowork} sessions={usage.cowork.sessions} noun="session" />}
              />
            </Card>
          </>
        )}

        <p className="px-1 text-xs text-muted-foreground">
          Estimated from each reply's token count at list prices. Models on this computer are free; models
          without a known price show "—" and aren't in the total. Deleted chats no longer count. Titles and
          memory updates aren't included.
        </p>
      </div>

      <BudgetSettings budget={budget} />
    </Page>
  );
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border bg-muted/30", className)}>{children}</div>;
}

/** One bar split by model, each part sized by its share of tokens. */
function UsageBar({ segments, total }: { segments: Segment[]; total: number }) {
  return (
    <div className="mt-3 flex h-6 gap-px overflow-hidden rounded-md bg-muted">
      {total > 0 &&
        segments.map((s) => (
          <Tooltip key={s.label}>
            <TooltipTrigger asChild>
              <div
                className={cn("h-full min-w-1 transition-[flex-grow] duration-300", s.color)}
                style={{ flexGrow: s.tokens, flexBasis: 0 }}
              />
            </TooltipTrigger>
            <TooltipContent>
              {s.label} · {formatTokens(s.tokens)} tokens ({Math.round((s.tokens / total) * 100)}%)
            </TooltipContent>
          </Tooltip>
        ))}
    </div>
  );
}

function Row({
  icon,
  label,
  tally,
  local,
  mono,
  details,
}: {
  icon: ReactNode;
  label: string;
  tally: Tally;
  local?: boolean;
  /** Model IDs read better in the mono face, as under each reply. */
  mono?: boolean;
  details: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
        {icon}
      </span>
      <p className={cn("min-w-0 flex-1 truncate text-sm", mono && "font-mono text-[13px] tracking-tight")}>{label}</p>
      <p className="shrink-0 text-sm text-muted-foreground tabular-nums">{formatTokens(totalTokens(tally))} tokens</p>
      <p className="w-20 shrink-0 text-right text-sm tabular-nums">{spend(tally, local)}</p>
      <HoverCard openDelay={150} closeDelay={100}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`Details for ${label}`}
            className="shrink-0 rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <InfoIcon className="size-4" />
          </button>
        </HoverCardTrigger>
        <HoverCardContent align="end" className="w-64 text-sm">
          {details}
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function TokenStats({ tally }: { tally: Tally }) {
  return (
    <>
      <Stat label="Input tokens" value={formatTokensExact(tally.inputTokens)} />
      <Stat label="Output tokens" value={formatTokensExact(tally.outputTokens)} />
      <Stat label="Replies" value={formatTokensExact(tally.replies)} />
    </>
  );
}

function ModelDetails({ usage }: { usage: ModelUsage }) {
  const price = priceFor(usage.model);
  return (
    <dl>
      <TokenStats tally={usage} />
      <Stat label="Chats" value={formatTokensExact(usage.chats)} />
      <Stat
        label="Price per 1M tokens"
        value={usage.local ? "Free (local)" : price ? `$${price.input} in · $${price.output} out` : "Unknown"}
      />
    </dl>
  );
}

function KindDetails({ tally, sessions, noun }: { tally: Tally; sessions: number; noun: string }) {
  return (
    <dl>
      <TokenStats tally={tally} />
      <Stat label={`${noun[0].toUpperCase()}${noun.slice(1)}s`} value={formatTokensExact(sessions)} />
      {tally.unpricedTokens > 0 && <Stat label="Unpriced tokens" value={formatTokensExact(tally.unpricedTokens)} />}
    </dl>
  );
}

// --- budget -------------------------------------------------------------------------

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** brand while under the first alert, amber once one is reached, red at the limit. */
function meterTone(budget: Budget, status: BudgetStatus) {
  if (status.fraction >= 1) return { bar: "bg-destructive", text: "text-destructive" };
  if (status.reached !== undefined) return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
  return { bar: budget.unit === "usd" ? "bg-brand" : "bg-sky-500", text: "text-foreground" };
}

/** The limit as the bar's full width, like a disk's capacity, with a tick at each alert. */
function BudgetMeter({ budget, status }: { budget: Budget; status: BudgetStatus }) {
  const tone = meterTone(budget, status);
  const ticks = budget.thresholds.filter((t) => t < 100);
  const pct = Math.min(status.fraction, 1) * 100;
  const left = status.limit - status.used;
  const unpriced = budget.unit === "usd" ? status.summary.total.unpricedTokens : 0;

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-medium">
          {budget.period === "day" ? "Daily" : budget.period === "week" ? "Weekly" : "Monthly"} budget
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">
          <span className={cn("font-medium", tone.text)}>{formatAmount(status.used, budget.unit)}</span> of{" "}
          {formatAmount(status.limit, budget.unit)} used
        </p>
      </div>
      <div
        role="meter"
        aria-label="Budget used"
        aria-valuemin={0}
        aria-valuemax={status.limit}
        aria-valuenow={Math.min(status.used, status.limit)}
        aria-valuetext={`${Math.round(status.fraction * 100)}% of the budget used`}
        className="relative mt-3 h-6 overflow-hidden rounded-md bg-muted"
      >
        <div className={cn("h-full transition-[width] duration-500", tone.bar)} style={{ width: `${pct}%` }} />
        {ticks.map((t) => (
          <span
            key={t}
            className={cn("absolute inset-y-0 w-0.5 -translate-x-1/2", t <= pct ? "bg-background/70" : "bg-foreground/15")}
            style={{ left: `${t}%` }}
            aria-hidden
          />
        ))}
      </div>
      {/* Tick labels sit under their ticks. */}
      <div className="relative mt-1 h-4 text-[11px] text-muted-foreground tabular-nums" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${t}%` }}>
            {t}%
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {left >= 0 ? `${formatAmount(left, budget.unit)} left` : `Over by ${formatAmount(-left, budget.unit)}`} · resets{" "}
          {shortDate.format(status.end)}
        </span>
        {status.projected !== undefined && (
          <span className="tabular-nums">On pace for {formatAmount(status.projected, budget.unit)}</span>
        )}
      </div>
      {unpriced > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Leaves out {formatTokens(unpriced)} tokens from models without a known price.
        </p>
      )}
    </Card>
  );
}

/** What to do about the budget, like macOS's Storage recommendations; nothing when on track. */
function BudgetAdvice({ budget, status }: { budget: Budget; status: BudgetStatus }) {
  const noun = PERIOD_NOUN[budget.period];
  let advice: { icon: ReactNode; title: string; body: string } | null = null;
  if (status.fraction >= 1) {
    advice = {
      icon: <OctagonPauseIcon className="size-5 text-destructive" />,
      title: "Budget reached",
      body: budget.pauseAtLimit
        ? `New requests are paused until ${shortDate.format(status.end)}. Raise the limit to keep going.`
        : `You've used your whole budget ${noun}. Requests still go through because "Pause at limit" is off.`,
    };
  } else if (status.projected !== undefined && status.projected > status.limit && status.used > 0) {
    // When the straight-line pace crosses the limit.
    const at = status.start + (status.limit / status.used) * (Date.now() - status.start);
    advice = {
      icon: <TrendingUpIcon className="size-5 text-amber-500" />,
      title: "On pace to go over",
      body: `At this rate you'll reach the limit around ${shortDate.format(at)}, before it resets on ${shortDate.format(status.end)}.`,
    };
  } else if (status.reached !== undefined) {
    advice = {
      icon: <AlertTriangleIcon className="size-5 text-amber-500" />,
      title: `${status.reached}% of the budget used`,
      body: `${formatAmount(status.limit - status.used, budget.unit)} left ${noun}.`,
    };
  }
  if (!advice) return null;

  return (
    <Card className="flex items-start gap-3 p-4">
      <span className="mt-0.5 shrink-0">{advice.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{advice.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{advice.body}</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => document.getElementById(LIMIT_INPUT_ID)?.focus()}>
        Raise limit
      </Button>
    </Card>
  );
}

const LIMIT_INPUT_ID = "usage-budget-limit";
const DEFAULT_LIMIT: Record<BudgetUnit, number> = { usd: 20, tokens: 1_000_000 };

function BudgetSettings({ budget }: { budget: Budget }) {
  return (
    <Group title="Budget settings">
      <Setting title="Budget" description="Track usage against a limit and get alerts as you approach it.">
        <Switch checked={budget.enabled} onCheckedChange={(enabled) => setBudget({ enabled })} aria-label="Budget" />
      </Setting>
      {budget.enabled && (
        <>
          <Setting
            title="Limit"
            description={budget.unit === "usd" ? "Estimated spend, at list prices." : "Input and output tokens, all models."}
          >
            <LimitInput budget={budget}>
              <Segmented
                label="Budget unit"
                value={budget.unit}
                onChange={(unit) => setBudget({ unit, limit: DEFAULT_LIMIT[unit] })}
                options={[
                  { value: "usd", label: "Spend" },
                  { value: "tokens", label: "Tokens" },
                ]}
              />
            </LimitInput>
          </Setting>
          <Setting title="Resets">
            <Segmented
              label="Budget period"
              value={budget.period}
              onChange={(period) => setBudget({ period })}
              options={[
                { value: "day", label: "Daily" },
                { value: "week", label: "Weekly" },
                { value: "month", label: "Monthly" },
              ]}
            />
          </Setting>
          <Setting title="Alert at" description="Percentages of the limit. Each one alerts once per period.">
            <ThresholdPicker value={budget.thresholds} onChange={(thresholds) => setBudget({ thresholds })} />
          </Setting>
          <Setting title="Notifications" description="Show an alert when usage reaches one of these thresholds.">
            <Switch checked={budget.notify} onCheckedChange={(notify) => setBudget({ notify })} aria-label="Notifications" />
          </Setting>
          <Setting
            title="Pause at limit"
            description={
              budget.unit === "usd"
                ? "Don't start new requests once the budget is used up. Local models keep working."
                : "Don't start new requests once the budget is used up."
            }
          >
            <Switch
              checked={budget.pauseAtLimit}
              onCheckedChange={(pauseAtLimit) => setBudget({ pauseAtLimit })}
              aria-label="Pause at limit"
            />
          </Setting>
        </>
      )}
    </Group>
  );
}

const LIMIT_ERROR_ID = "usage-budget-limit-error";

/**
 * Saves on blur or Enter; takes "20", "$20", "500k", "2.5M" or "5B". Text it
 * can't read stays in the field with the reason under it. `children` (the
 * unit toggle) sits to its left.
 */
function LimitInput({ budget, children }: { budget: Budget; children: ReactNode }) {
  const shown = budget.unit === "usd" ? String(budget.limit) : tokenLimitText(budget.limit);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(shown);
    setError(undefined);
  }, [shown]);

  const commit = () => {
    if (draft === shown) return setError(undefined);
    const parsed = parseLimit(draft, budget.unit);
    if (parsed.error !== undefined) return setError(parsed.error);
    setError(undefined);
    const limit = budget.unit === "usd" ? Math.round(parsed.value * 100) / 100 : Math.round(parsed.value);
    if (limit === budget.limit) return setDraft(shown);
    setBudget({ limit });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {children}
        <div className="relative">
          {budget.unit === "usd" && (
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          )}
          <Input
            id={LIMIT_INPUT_ID}
            aria-label={budget.unit === "usd" ? "Limit in dollars" : "Limit in tokens"}
            aria-invalid={error !== undefined}
            aria-describedby={error !== undefined ? LIMIT_ERROR_ID : undefined}
            inputMode="decimal"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(shown);
                setError(undefined);
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            className={cn("h-8 w-24 tabular-nums", budget.unit === "usd" && "pl-6")}
          />
        </div>
      </div>
      {error !== undefined && (
        <p id={LIMIT_ERROR_ID} role="alert" className="max-w-72 text-right text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** "10M" when that reads back as the exact limit, else "1,234,567", so the field always round-trips. */
function tokenLimitText(limit: number) {
  const short = formatTokens(limit);
  return parseLimit(short, "tokens").value === limit ? short : formatTokensExact(limit);
}

function ThresholdPicker({ value, onChange }: { value: number[]; onChange: (thresholds: number[]) => void }) {
  return (
    <div role="group" aria-label="Alert thresholds" className="flex gap-1">
      {THRESHOLD_CHOICES.map((t) => {
        const on = value.includes(t);
        return (
          <button
            key={t}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== t) : [...value, t].sort((a, b) => a - b))}
            className={cn(
              "h-7 rounded-md border px-2 text-xs tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              on ? "border-transparent bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}%
          </button>
        );
      })}
    </div>
  );
}
