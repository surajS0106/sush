import { useCallback, useEffect, useState } from "react";

import { api, errorMessage, type ModelInfo, type ProviderView } from "@/lib/tauri";

export interface ProviderModels {
  provider: ProviderView;
  models: ModelInfo[];
  error?: string;
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
        try {
          return { provider, models: await api.listModels(provider.id) };
        } catch (e) {
          return { provider, models: [], error: errorMessage(e) };
        }
      }),
    );
    setCatalog(results);
    setLoadingModels(false);
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.error("Loading providers failed", e));
  }, [refresh]);

  return { providers, catalog, loadingModels, refresh };
}
