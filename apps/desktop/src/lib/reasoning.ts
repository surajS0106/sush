// Which thinking and effort options each model accepts, so the composer only offers
// what the API takes. How a choice reaches the wire is in sush-core's `providers/`.

import { isEngine, type EngineView, type Effort, type WireFormat } from "@/lib/tauri";

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

export const effortLabel = (e: Effort) => EFFORTS.find((x) => x.id === e)?.label ?? e;

export interface ReasoningCaps {
  /** `optional` can be switched; `always` and `never` are fixed for this model; `none` means we don't know the model's controls. */
  thinking: "optional" | "always" | "never" | "none";
  /** Whether it thinks when the request says nothing. */
  thinkingDefault: boolean;
  efforts: Effort[];
  /** The level used when the request names none. */
  defaultEffort: Effort | null;
  /** The highest level the API accepts with thinking off. */
  offMaxEffort?: Effort;
  /** OpenAI has one setting for both: thinking off is effort `none`, so levels don't apply. */
  offDisablesEffort?: boolean;
  /** Why the options are limited, for the menu. */
  note?: string;
}

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const THREE: Effort[] = ["low", "medium", "high"];

const NO_CONTROLS: ReasoningCaps = {
  thinking: "none",
  thinkingDefault: false,
  efforts: [],
  defaultEffort: null,
  note: "Sush doesn't have thinking controls for this model.",
};

function claudeCaps(model: string): ReasoningCaps {
  // Same parsing as `claude_version` in providers/anthropic.rs: keep them in step.
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model);
  if (!m) return NO_CONTROLS;
  const family = m[1];
  const version = Number(m[2]) + Number(m[3] ?? 0) / 10;

  const alwaysOn = (defaultEffort: Effort): ReasoningCaps => ({
    thinking: "always",
    thinkingDefault: true,
    efforts: ALL,
    defaultEffort,
    note: "This model always thinks. Effort sets how much.",
  });
  // Generation 5 thinks unless told not to; 4.x only when asked.
  const optional = (efforts: Effort[], defaultEffort: Effort | null, extra: Partial<ReasoningCaps> = {}): ReasoningCaps => ({
    thinking: "optional",
    thinkingDefault: version >= 5,
    efforts,
    defaultEffort,
    ...extra,
  });
  const noEffort = "This model has no effort setting.";

  if (family === "fable" || family === "mythos") return alwaysOn("high");
  if (family === "opus") {
    if (version >= 5.5) return alwaysOn("medium");
    if (version >= 5) return optional(ALL, "high", { offMaxEffort: "high" });
    if (version >= 4.7) return optional(ALL, "high");
    if (version >= 4.6) return optional(["low", "medium", "high", "max"], "high");
    if (version >= 4.5) return optional(THREE, "high");
    return optional([], null, { note: noEffort });
  }
  if (family === "sonnet") {
    if (version >= 5.5) return optional(ALL, "high", { offMaxEffort: "high" });
    if (version >= 5) return optional(ALL, "high");
    if (version >= 4.6) return optional(["low", "medium", "high", "max"], "high");
    return optional([], null, { note: noEffort });
  }
  if (version >= 5.5) return optional(ALL, "medium", { offMaxEffort: "high" });
  if (version >= 4.5) return optional([], null, { note: noEffort });
  return NO_CONTROLS;
}

function openaiCaps(model: string): ReasoningCaps {
  // Routers prefix the vendor (`openai/gpt-5.5`).
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();

  // These go to the Responses API (`uses_responses` in providers/openai_responses.rs: keep in step),
  // except through a router, whose prefixed ids stay on Chat Completions.
  const responses = !model.includes("/");
  if (/^gpt-5\.6(\b|-)|^gpt-6-(sol|luna)(\b|-)/.test(id)) {
    // Chat Completions takes their tools only with reasoning off.
    if (!responses) {
      return {
        thinking: "never",
        thinkingDefault: false,
        efforts: [],
        defaultEffort: null,
        note: "Through this provider, the model's tools only work with thinking off.",
      };
    }
    return { thinking: "optional", thinkingDefault: true, efforts: ALL, defaultEffort: "medium", offDisablesEffort: true };
  }
  if (/^gpt-6\.\d|^gpt-6-astra/.test(id)) {
    const base = { thinkingDefault: true, efforts: ALL, defaultEffort: "medium" as const, offDisablesEffort: true };
    // Chat Completions doesn't take their tools at all.
    if (!responses) return { ...base, thinking: "always", note: "Through this provider, requests with tools may fail." };
    return /^gpt-6\.\d+-terra/.test(id) ? { ...base, thinking: "optional" } : { ...base, thinking: "always", note: "This model always thinks. Effort sets how much." };
  }
  if (/^gpt-5\.5(\b|-)/.test(id) && !/-pro\b/.test(id)) {
    return { thinking: "optional", thinkingDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", offDisablesEffort: true };
  }
  if (/-(pro|chat|search|audio|realtime|image|transcribe|tts|codex)\b/.test(id)) return NO_CONTROLS;
  // These think only when asked.
  if (/^gpt-5\.[1-4](\b|-)/.test(id)) {
    return { thinking: "optional", thinkingDefault: false, efforts: THREE, defaultEffort: null, offDisablesEffort: true };
  }
  // These can't be switched off: they have no `none` level.
  if (/^(gpt-5|o[134])(-|$)/.test(id)) {
    return { thinking: "always", thinkingDefault: true, efforts: THREE, defaultEffort: "medium", offDisablesEffort: true, note: "This model always thinks. Effort sets how much." };
  }
  return NO_CONTROLS;
}

export function reasoningCaps(format: WireFormat | undefined, model: string | undefined): ReasoningCaps {
  if (!format || !model) return NO_CONTROLS;
  return format === "anthropic-messages" ? claudeCaps(model) : openaiCaps(model);
}

// Claude Code and Codex say which effort levels each of their models takes
// (`EngineView.models`), so their caps come from the CLI, not from the id.
const engineCaps = new Map<string, ReasoningCaps>();
const engineKey = (providerId: string, model: string) => `${providerId}\n${model}`;

export function setEngineCaps(engine: EngineView) {
  for (const m of engine.models) {
    engineCaps.set(
      engineKey(engine.id, m.id),
      m.efforts.length
        ? { thinking: "always", thinkingDefault: true, efforts: m.efforts, defaultEffort: null, note: `${engine.name} decides when to think. Effort sets how much.` }
        : { ...NO_CONTROLS, note: `${engine.name} sets this model's thinking itself.` },
    );
  }
}

/** The caps for a pick: an engine's from what its CLI listed, any other model's from its id. */
export function capsFor(providerId: string | undefined, format: WireFormat | undefined, model: string | undefined): ReasoningCaps {
  if (isEngine(providerId)) return (model && engineCaps.get(engineKey(providerId!, model))) || NO_CONTROLS;
  return reasoningCaps(format, model);
}

export interface ReasoningPrefs {
  /** Null follows the model. */
  thinking: boolean | null;
  /** Null follows the model. */
  effort: Effort | null;
}

/** Whether a level can be picked given the thinking state. */
export function effortAllowed(caps: ReasoningCaps, e: Effort, thinking: boolean): boolean {
  if (!caps.efforts.includes(e)) return false;
  if (thinking) return true;
  if (caps.offDisablesEffort) return false;
  return !caps.offMaxEffort || ALL.indexOf(e) <= ALL.indexOf(caps.offMaxEffort);
}

/** What actually applies to this model: the saved choice is global, so it can ask for more than a model offers. */
export function effectiveReasoning(caps: ReasoningCaps, prefs: ReasoningPrefs): { thinking: boolean; effort: Effort | null } {
  const thinking =
    caps.thinking === "always" ? true : caps.thinking === "optional" ? (prefs.thinking ?? caps.thinkingDefault) : false;
  // A level the model lacks steps down to the nearest one it has, not to its default.
  const wanted = prefs.effort ? ALL.indexOf(prefs.effort) : -1;
  const effort = ALL.slice(0, wanted + 1).findLast((e) => effortAllowed(caps, e, thinking))
    ?? (wanted >= 0 ? ALL.find((e) => effortAllowed(caps, e, thinking)) : undefined);
  return { thinking, effort: effort ?? null };
}

/** The fields for a run's config. Anything left out keeps the model's own default. */
export function reasoningRequest(caps: ReasoningCaps, prefs: ReasoningPrefs): { thinking?: boolean; effort?: Effort } {
  if (caps.thinking === "none") return {};
  const { thinking, effort } = effectiveReasoning(caps, prefs);
  const out: { thinking?: boolean; effort?: Effort } = {};
  if (caps.thinking === "never") out.thinking = false;
  else if (caps.thinking === "optional" && prefs.thinking !== null) out.thinking = thinking;
  if (effort) out.effort = effort;
  // Switched on with no level, on a model that stays off without one.
  else if (thinking && caps.offDisablesEffort && !caps.thinkingDefault) out.effort = "medium";
  return out;
}
