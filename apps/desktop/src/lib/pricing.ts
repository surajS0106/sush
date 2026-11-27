// Per-message cost from token usage. Prices are USD per million tokens at
// first-party list rates; unknown models get no estimate rather than a guess.
// Input read from the prompt cache costs a tenth of the input rate unless the model
// lists its own cached rate. Cache writes (a quarter more than input on Anthropic)
// are counted as plain input.

import type { ImageUsage } from "@/lib/tauri";

/** What a cached input token costs, as a share of the input rate, when a model lists no cached rate. */
const CACHED_SHARE = 0.1;

interface Rates {
  input: number;
  output: number;
  /** Cached input per million tokens, where it isn't a tenth of `input`. */
  cached?: number;
}

interface Price extends Rates {
  /** Rates for a whole request once its prompt reaches 200K tokens, for models billed that way. */
  long?: Rates;
}

/** The usage a reply's metadata counts from steps whose prompt reached 200K tokens (part of its totals). */
export interface LongUsage {
  longInputTokens?: number;
  longOutputTokens?: number;
  longCachedInputTokens?: number;
}

// Longest prefix wins, so dated IDs (claude-haiku-4-5-20251001) still match.
const PRICES = ([
  ["claude-fable-5-1", { input: 10, output: 50 }],
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-mythos-5-1", { input: 10, output: 50 }],
  ["claude-opus-5-5", { input: 4, output: 20 }],
  ["claude-opus-5", { input: 5, output: 25 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-opus-4-7", { input: 5, output: 25 }],
  ["claude-opus-4-6", { input: 5, output: 25 }],
  ["claude-sonnet-5-5", { input: 2, output: 10 }],
  ["claude-sonnet-5", { input: 2, output: 10 }],
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
  // xAI (docs.x.ai/developers/models, Nov 2026). A request whose prompt reaches 200K
  // tokens is billed at the `long` rates throughout.
  ["grok-4.7", { input: 2, output: 6, cached: 0.5, long: { input: 4, output: 12, cached: 1 } }],
  ["grok-4.6", { input: 2, output: 6, cached: 0.5, long: { input: 4, output: 12, cached: 1 } }],
  ["grok-4.5", { input: 2, output: 6, cached: 0.3, long: { input: 4, output: 12, cached: 0.6 } }],
  ["grok-4.3", { input: 1.25, output: 2.5, cached: 0.2, long: { input: 2.5, output: 5, cached: 0.4 } }],
  ["grok-4.20", { input: 1.25, output: 2.5, cached: 0.2, long: { input: 2.5, output: 5, cached: 0.4 } }],
] satisfies [string, Price][]).sort((a, b) => b[0].length - a[0].length);

/** Strips router/cloud prefixes: "anthropic/claude-…", "anthropic.claude-…", "x-ai/grok-…", "xai.grok-…". */
function normalize(model: string) {
  return model.toLowerCase().replace(/^.*[/]/, "").replace(/^(anthropic|xai)\./, "");
}

export function priceFor(model: string): Price | undefined {
  const id = normalize(model);
  return PRICES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** True for servers on this machine (Ollama, LM Studio), which cost nothing per token. */
export function isLocalUrl(baseUrl: string) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Estimated USD for a reply: 0 for local models, undefined when the price is unknown. */
export function costUsd(
  model: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number,
  local: boolean,
  /** The part of `inputTokens` read from the prompt cache. */
  cachedTokens = 0,
  /** The part of the usage from long-context steps, for models with a long-context rate. */
  long: LongUsage = {},
) {
  if (local) return 0;
  const price = model && priceFor(model);
  if (!price) return undefined;
  const input = inputTokens ?? 0;
  if (!price.long) return usdAt(price, input, cachedTokens, outputTokens);
  const longInput = Math.min(long.longInputTokens ?? 0, input);
  const longCached = Math.min(long.longCachedInputTokens ?? 0, cachedTokens);
  const longOutput = Math.min(long.longOutputTokens ?? 0, outputTokens);
  return (
    usdAt(price, input - longInput, cachedTokens - longCached, outputTokens - longOutput) +
    usdAt(price.long, longInput, longCached, longOutput)
  );
}

function usdAt(rates: Rates, input: number, cachedTokens: number, output: number) {
  const cached = Math.min(cachedTokens, input);
  const cachedRate = rates.cached ?? rates.input * CACHED_SHARE;
  return ((input - cached) * rates.input + cached * cachedRate + output * rates.output) / 1_000_000;
}

/** "$0.0123", "$4.21", "<$0.0001". */
export function formatUsd(usd: number) {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/**
 * "$0.0123", "Free" for local models, or undefined when the price is unknown.
 */
export function formatCost(
  model: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  local: boolean,
  cachedTokens = 0,
  long: LongUsage = {},
): string | undefined {
  if (outputTokens === undefined) return undefined;
  if (local) return "Free";
  const usd = costUsd(model, inputTokens, outputTokens, false, cachedTokens, long);
  return usd === undefined ? undefined : formatUsd(usd);
}

// --- images ---------------------------------------------------------------------------

/** gpt-image prices per million tokens, from OpenAI's pricing page (Images, Standard). */
interface ImagePrice {
  textInput: number;
  imageInput: number;
  imageOutput: number;
  /** Only models that bill text output list it. */
  textOutput: number;
}

const GPT_IMAGE_2: ImagePrice = { textInput: 5, imageInput: 8, imageOutput: 30, textOutput: 0 };
const GPT_IMAGE_1_5: ImagePrice = { textInput: 5, imageInput: 8, imageOutput: 32, textOutput: 10 };

// Longest prefix wins, as for chat models.
const IMAGE_PRICES = ([
  ["gpt-image-2", GPT_IMAGE_2],
  ["gpt-image-2.5", GPT_IMAGE_2],
  ["gpt-image-2.6", GPT_IMAGE_2],
  ["gpt-image-1.5", GPT_IMAGE_1_5],
  ["chatgpt-image-latest", GPT_IMAGE_1_5],
  ["gpt-image-1-mini", { textInput: 2, imageInput: 2.5, imageOutput: 8, textOutput: 0 }],
] satisfies [string, ImagePrice][]).sort((a, b) => b[0].length - a[0].length);

/** What an image cost in USD from its billed tokens, or undefined for a model whose price isn't known. */
export function imageCostUsd(model: string, usage: ImageUsage): number | undefined {
  const id = normalize(model);
  const price = IMAGE_PRICES.find(([prefix]) => id.startsWith(prefix))?.[1];
  if (!price) return undefined;
  return (
    (usage.inputTextTokens * price.textInput +
      usage.inputImageTokens * price.imageInput +
      usage.outputImageTokens * price.imageOutput +
      usage.outputTextTokens * price.textOutput) /
    1_000_000
  );
}
