// How many tokens of context each model takes, for the composer's context
// meter. Longest prefix wins, matched on the model id without a router prefix
// ("anthropic/claude-…", "openai/gpt-…"). Unknown models get no window, and the
// meter shows what's used without a share.

const WINDOWS = ([
  // Anthropic
  ["claude-fable-5", 1_000_000],
  ["claude-mythos-5", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-haiku-5", 200_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-sonnet-4-5", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4-5", 200_000],
  ["claude-3", 200_000],
  // OpenAI
  ["gpt-6", 400_000],
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["o4", 200_000],
  ["o3", 200_000],
  ["gpt-oss", 131_072],
  // Google
  ["gemini-3", 1_048_576],
  ["gemini-2.5", 1_048_576],
  ["gemma3", 131_072],
  ["gemma-3", 131_072],
  // Open models, as their makers ship them (a local server may run them with less)
  ["llama-4", 1_000_000],
  ["llama4", 1_000_000],
  ["llama3", 131_072],
  ["llama-3", 131_072],
  ["qwen3-coder", 262_144],
  ["qwen3", 131_072],
  ["deepseek", 131_072],
  ["kimi-k2", 262_144],
  ["glm-4", 131_072],
  ["mistral-large", 131_072],
  ["nemotron", 131_072],
] satisfies [string, number][]).sort((a, b) => b[0].length - a[0].length);

/** Strips router/cloud prefixes: "anthropic/claude-…", "anthropic.claude-…", "us.anthropic.claude-…". */
function normalize(model: string) {
  return model.toLowerCase().replace(/^.*[/]/, "").replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
}

/** The model's context window in tokens, or undefined when it isn't known. */
export function contextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = normalize(model);
  return WINDOWS.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** A rough token count for text: about four characters a token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
