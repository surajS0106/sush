// Per-message cost from token usage. Prices are USD per million tokens at
// first-party list rates; unknown models get no estimate rather than a guess.

interface Price {
  input: number;
  output: number;
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
] satisfies [string, Price][]).sort((a, b) => b[0].length - a[0].length);

/** Strips router/cloud prefixes: "anthropic/claude-…", "anthropic.claude-…". */
function normalize(model: string) {
  return model.toLowerCase().replace(/^.*[/]/, "").replace(/^anthropic\./, "");
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

/**
 * "$0.0123", "Free" for local models, or undefined when the price is unknown.
 */
export function formatCost(
  model: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  local: boolean,
): string | undefined {
  if (outputTokens === undefined) return undefined;
  if (local) return "Free";
  const price = model && priceFor(model);
  if (!price) return undefined;
  const usd = ((inputTokens ?? 0) * price.input + outputTokens * price.output) / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(usd < 1 ? 3 : 2)}`;
}
