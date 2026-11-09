// The composer's context meter: a ring filling as the conversation takes up
// the model's context window, and on hover what's in it. The total is the
// last reply's real count (`contextTokens`, the last step's input); the
// split is estimated from what the UI sends (system prompt, skills, tools,
// connectors) at about four characters a token, and the conversation is the
// rest. Cowork's workspace tools and instructions are added in Rust, so they
// count under the conversation. With a usage budget on (Settings → Usage),
// it shows how much of it is spent too. "Compact now" swaps the conversation
// for a summary of it (`lib/compact.ts`); counts start again from there.

import { ShrinkIcon } from "lucide-react";
import { useMemo } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { ProviderModels } from "@/hooks/use-providers";
import { buildContext, runTools, toolKind } from "@/lib/agent";
import { CompactSushi } from "@/components/compact-sushi";
import { Button } from "@/components/ui/button";
import { budgetStatus, formatAmount, PERIOD_NOUN, useBudget } from "@/lib/budget";
import { canCompact, compactThread, useCompacting } from "@/lib/compact";
import { contextWindow, estimateTokens } from "@/lib/context-window";
import { isLocalUrl } from "@/lib/pricing";
import { skillsPrompt } from "@/lib/skills";
import { getAskUser } from "@/lib/store";
import { isSharedThread } from "@/lib/tauri";
import type { ModelTarget, SushUIMessage } from "@/lib/transport";
import { formatTokens } from "@/lib/usage";
import { cn } from "@/lib/utils";

interface Segment {
  key: string;
  label: string;
  tokens: number;
  color: string;
}

/** What each request carries besides the conversation, estimated. */
function overhead() {
  const ctx = buildContext({ askUser: getAskUser(), research: false });
  const skillsText = skillsPrompt() ?? "";
  const system = estimateTokens(ctx.system ?? "") - estimateTokens(skillsText);
  let tools = 0;
  let connectors = 0;
  // Deferred tools are only named in the system prompt, with their first sentence.
  for (const t of runTools(ctx.tools, { mentioned: new Set() })) {
    const tokens = t.deferred
      ? estimateTokens(`${t.name}: ${t.description.split(". ")[0]}`)
      : estimateTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    if (toolKind(t.name) === "connector") connectors += tokens;
    else tools += tokens;
  }
  return { system: Math.max(system, 0), skills: estimateTokens(skillsText), tools, connectors };
}

/** The conversation's own text, for before any reply has a real count. */
function messageTokens(messages: SushUIMessage[]) {
  let chars = 0;
  for (const m of messages) for (const p of m.parts) if (p.type === "text" || p.type === "reasoning") chars += p.text.length;
  return Math.ceil(chars / 4);
}

/** What the model reads: the thread from its latest summary on (`ui::to_core`). */
function inContext(messages: SushUIMessage[]) {
  const from = messages.findLastIndex((m) => m.metadata?.compaction);
  return from < 0 ? messages : messages.slice(from);
}

const RESET = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

function Ring({ fraction, className }: { fraction: number | undefined; className?: string }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const f = Math.min(Math.max(fraction ?? 0, 0), 1);
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4 -rotate-90", className)}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2} />
      {fraction !== undefined && f > 0 && (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${Math.max(f * c, 1)} ${c}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      )}
    </svg>
  );
}

function Meter({ fraction, className }: { fraction: number; className?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8 dark:bg-white/10">
      <div className={cn("h-full rounded-full", className)} style={{ width: `${Math.min(fraction, 1) * 100}%` }} />
    </div>
  );
}

export function ContextMeter({
  catalog,
  target,
  messages: thread,
  conversationId,
  busy,
}: {
  catalog: ProviderModels[];
  target: ModelTarget | null;
  messages: SushUIMessage[];
  /** The session, for "Compact now". */
  conversationId?: string;
  /** While a reply runs, compacting waits. */
  busy?: boolean;
}) {
  const budget = useBudget();
  const limit = contextWindow(target?.model);
  const messages = useMemo(() => inContext(thread), [thread]);
  const compacting = useCompacting(conversationId);
  const compactable = !!conversationId && !isSharedThread(conversationId) && canCompact(thread);

  // What's in context: the last reply's count, split by estimate.
  const segments = useMemo(() => {
    const o = overhead();
    const fixed = o.system + o.skills + o.tools + o.connectors;
    const measured = messages.findLast((m) => m.role === "assistant" && m.metadata?.contextTokens)?.metadata?.contextTokens;
    const used = measured ?? fixed + messageTokens(messages);
    // Estimates can overshoot a small measured total; scale them to fit inside it.
    const scale = fixed > used ? used / fixed : 1;
    const part = (n: number) => Math.round(n * scale);
    const list: Segment[] = [
      { key: "system", label: "System", tokens: part(o.system), color: "bg-violet-500" },
      { key: "connectors", label: "Connectors", tokens: part(o.connectors), color: "bg-emerald-500" },
      { key: "skills", label: "Skills", tokens: part(o.skills), color: "bg-orange-500" },
      { key: "tools", label: "Tools", tokens: part(o.tools), color: "bg-sky-500" },
    ];
    const rest = Math.max(used - list.reduce((s, x) => s + x.tokens, 0), 0);
    list.push({ key: "messages", label: "Messages", tokens: rest, color: "bg-brand" });
    return { list, used, measured: measured !== undefined };
  }, [messages, target?.model]);

  const localProviders = useMemo(
    () => new Set(catalog.filter((c) => isLocalUrl(c.provider.baseUrl)).map((c) => c.provider.id)),
    [catalog],
  );
  // Re-tallied when a reply lands, since its tokens count toward the budget.
  const spend = useMemo(
    () => (budget.enabled ? budgetStatus(budget, localProviders) : null),
    [budget, localProviders, messages.length],
  );

  const { list, used, measured } = segments;
  const fraction = limit ? used / limit : undefined;
  const pct = fraction === undefined ? undefined : Math.min(Math.round(fraction * 100), 100);
  const free = limit ? Math.max(limit - used, 0) : 0;
  const tone =
    fraction === undefined
      ? "text-muted-foreground"
      : fraction >= 0.9
        ? "text-destructive"
        : fraction >= 0.75
          ? "text-amber-500"
          : "text-brand";

  return (
    <HoverCard openDelay={120} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          disabled={!target}
          aria-label={pct === undefined ? `Context: ${formatTokens(used)} tokens` : `Context: ${pct}% used`}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50 dark:hover:bg-white/10"
        >
          {compacting ? <CompactSushi size={24} /> : <Ring fraction={fraction} className={tone} />}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" sideOffset={8} className="w-80 rounded-2xl p-0 text-[13px]">
        <div className="space-y-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span>
              <span className="font-medium">Context</span>
              {pct !== undefined && <span className="ml-1.5 tabular-nums text-muted-foreground">{pct}%</span>}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {limit ? `${formatTokens(used)} of ${formatTokens(limit)}` : `${formatTokens(used)} tokens`}
            </span>
          </div>
          <div className="flex h-2 gap-px overflow-hidden rounded-full bg-foreground/8 dark:bg-white/10">
            {list.map(
              (s) =>
                s.tokens > 0 && (
                  <div
                    key={s.key}
                    className={cn("h-full min-w-[3px] first:rounded-l-full", s.color)}
                    style={{ width: `${(s.tokens / ((limit ?? used) || 1)) * 100}%` }}
                  />
                ),
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {[...list, ...(limit ? [{ key: "free", label: "Free", tokens: free, color: "bg-foreground/15" }] : [])].map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-[3px]", s.color)} />
                <dt className="flex-1 text-muted-foreground">{s.label}</dt>
                <dd className="font-medium tabular-nums">{formatTokens(s.tokens)}</dd>
              </div>
            ))}
          </dl>
          {!limit && target && (
            <p className="text-xs text-muted-foreground">The context window of {target.model} isn’t known, so there’s no share to show.</p>
          )}
          {!measured && <p className="text-xs text-muted-foreground">Estimated until the next reply reports its count.</p>}
          {(compactable || compacting) && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              {compacting && <CompactSushi size={32} />}
              <p className="flex-1 text-xs text-muted-foreground">
                {compacting ? "Summarising the conversation…" : "Swap the conversation so far for a summary, to free up space."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1.5 rounded-full px-3 text-xs"
                disabled={compacting || busy}
                title={busy ? "Wait for the reply to finish" : undefined}
                onClick={() => conversationId && void compactThread(conversationId, used)}
              >
                {!compacting && <ShrinkIcon className="size-3.5" />}
                {compacting ? "Compacting…" : "Compact now"}
              </Button>
            </div>
          )}
        </div>
        {spend && (
          <div className="space-y-1.5 border-t p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span>
                <span className="font-medium">Budget {PERIOD_NOUN[budget.period]}</span>
                <span className="ml-1.5 tabular-nums text-muted-foreground">{Math.round(spend.fraction * 100)}%</span>
              </span>
              <span className="text-muted-foreground">Resets {RESET.format(spend.end)}</span>
            </div>
            <Meter fraction={spend.fraction} className={spend.fraction >= 1 ? "bg-destructive" : spend.fraction >= 0.8 ? "bg-amber-500" : "bg-brand"} />
            <p className="text-xs tabular-nums text-muted-foreground">
              {formatAmount(spend.used, budget.unit)} of {formatAmount(spend.limit, budget.unit)}
            </p>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
