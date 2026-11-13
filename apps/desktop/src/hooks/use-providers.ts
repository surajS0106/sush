import { useCallback, useEffect, useState } from "react";

import { setEngineCaps } from "@/lib/reasoning";
import { api, ENGINE_IDS, errorMessage, type EngineView, type ModelInfo, type ProviderView } from "@/lib/tauri";

export interface ProviderModels {
  provider: ProviderView;
  models: ModelInfo[];
  error?: string;
}

/** Why a provider can't be called yet, or undefined once it's set up. */
export function setupIssue(p: ProviderView): string | undefined {
  if (/\{.+\}/.test(p.baseUrl)) return "Finish setup in Settings → Providers: replace the {placeholder} in the base URL.";
  if (p.auth.type === "api-key" && !p.hasKey) return "Finish setup in Settings → Providers: add an API key.";
  return undefined;
}

/**
 * Claude Code or Codex as a picker entry: the user's own CLI, signed in with its own
 * login (`sush_core::engines`). Not a provider in Settings; it only runs Cowork sessions.
 */
function engineEntry(engine: EngineView): ProviderModels {
  const provider: ProviderView = {
    id: engine.id,
    name: engine.name,
    format: engine.id === ENGINE_IDS.codex ? "openai-chat" : "anthropic-messages",
    // Never called; it picks the logo.
    baseUrl: engine.id === ENGINE_IDS.codex ? "https://openai.com/codex" : "https://claude.com/claude-code",
    auth: { type: "none" },
    headers: {},
    models: [],
    hasKey: true,
  };
  const ready = engine.installed && engine.signedIn !== false;
  return { provider, models: ready ? engine.models : [], error: ready ? undefined : (engine.detail ?? undefined) };
}

/** Configured providers plus each one's model list, loaded in parallel. */
export function useProviders() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [catalog, setCatalog] = useState<ProviderModels[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const refresh = useCallback(async () => {
    const list = await api.listProviders();
    setProviders(list);
    setLoadingModels(true);
    const results = await Promise.all(
      list.map(async (provider): Promise<ProviderModels> => {
        const issue = setupIssue(provider);
        if (issue) return { provider, models: [], error: issue };
        try {
          return { provider, models: await api.listModels(provider.id) };
        } catch (e) {
          return { provider, models: [], error: errorMessage(e) };
        }
      }),
    );
    // Only engines that are installed: one the user doesn't have is noise in the picker.
    const engines = await api.enginesList().catch(() => [] as EngineView[]);
    engines.forEach(setEngineCaps);
    setCatalog([...results, ...engines.filter((e) => e.installed).map(engineEntry)]);
    setLoadingModels(false);
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.error("Loading providers failed", e));
  }, [refresh]);

  return { providers, catalog, loadingModels, refresh };
}
