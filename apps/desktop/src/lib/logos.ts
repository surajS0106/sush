// Monochrome brand logos (from models.dev), bundled so they load under the app's CSP.

const urls = import.meta.glob<string>("../assets/logos/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(urls).map(([path, url]) => [path.split("/").pop()!.replace(".svg", ""), url]),
);

/** Logos shown in their brand color instead of the surrounding text color. */
const BRAND_COLORS: Record<string, string> = {
  anthropic: "#D97757",
  azure: "#0078D4",
};

const COLOR_BY_URL = new Map(
  Object.entries(BRAND_COLORS).flatMap(([slug, color]) => (LOGOS[slug] ? [[LOGOS[slug], color]] : [])),
);

export function logoColor(url?: string) {
  return url ? COLOR_BY_URL.get(url) : undefined;
}

/** Model-family prefixes → the lab that makes them. Checked before falling back to the provider. */
const MODEL_FAMILIES: [RegExp, string][] = [
  [/claude|opus|sonnet|haiku|fable/i, "anthropic"],
  [/gpt|o\d|chatgpt|davinci|whisper/i, "openai"],
  [/gemini|gemma/i, "google"],
  [/llama/i, "meta"],
  [/mistral|mixtral|codestral|ministral|devstral|magistral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/qwen|qwq/i, "alibaba"],
  [/grok/i, "xai"],
];

/** Hosts / provider names → logo slug. */
const PROVIDERS: [RegExp, string][] = [
  [/anthropic|claude/i, "anthropic"],
  // Before OpenAI: Azure hosts look like {resource}.openai.azure.com.
  [/azure|foundry/i, "azure"],
  [/openai/i, "openai"],
  [/ollama|:11434/i, "ollama"],
  [/lm ?studio|:1234/i, "lmstudio"],
  [/groq/i, "groq"],
  [/google|gemini/i, "google"],
  [/mistral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/x\.ai|xai|grok/i, "xai"],
];

function match(table: [RegExp, string][], ...haystacks: string[]) {
  for (const [re, slug] of table) {
    if (haystacks.some((h) => re.test(h))) return LOGOS[slug];
  }
  return undefined;
}

export function providerLogo(provider: { id: string; name: string; baseUrl: string }) {
  return match(PROVIDERS, provider.id, provider.name, provider.baseUrl);
}

export function modelLogo(modelId: string) {
  // Only match at the start of a path segment so "pro" or "-o1" suffixes don't misfire.
  const name = modelId.split("/").pop() ?? modelId;
  return match(
    MODEL_FAMILIES.map(([re, slug]) => [new RegExp(`^(?:${re.source})`, re.flags), slug]),
    name,
  );
}
