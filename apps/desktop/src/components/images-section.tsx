// Settings → Images: which provider and model generate images for the
// `image_generate` tool. Off until a provider and model are picked.

import { useEffect, useId, useState } from "react";

import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { Input } from "@/components/ui/input";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import {
  canGenerateImages,
  defaultImageApi,
  defaultImageModel,
  setImageSettings,
  useImageSettings,
} from "@/lib/images";
import { api, type ModelInfo, type ProviderView } from "@/lib/tauri";

const OFF = "off";

const PROVIDER_HINT =
  "Where image prompts are sent. Claude models don't output images, so Anthropic providers can't make them.";
const API_HINT =
  "The images endpoint for OpenAI, Azure Foundry, xAI and Ollama's image models. Chat with image output for OpenRouter's image models.";

const modelHint = (imageApi: string) =>
  imageApi === "chat-modalities"
    ? "An image-output model, such as google/gemini-2.5-flash-image on OpenRouter."
    : "An image model such as gpt-image-1 or dall-e-3. On Azure Foundry, use your deployment name.";

export function ImagesSection({ providers }: { providers: ProviderView[] }) {
  const settings = useImageSettings();
  const providerId = settings.providerId ?? OFF;
  const off = providerId === OFF;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const listId = useId();

  useEffect(() => {
    setModels([]);
    if (off) return;
    let live = true;
    api.listModels(providerId).then((m) => live && setModels(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [providerId, off]);

  const pickProvider = (id: string) => {
    if (id === OFF) return setImageSettings({ providerId: null });
    const p = providers.find((x) => x.id === id);
    if (p) setImageSettings({ providerId: id, api: defaultImageApi(p), model: defaultImageModel(p) });
  };

  return (
    <Page>
      <Group title="Image generation">
        <Setting title="Provider" description={PROVIDER_HINT}>
          <DropdownMenu
            label="Image provider"
            align="end"
            variant="field"
            className="w-full sm:w-56"
            value={providerId}
            onChange={pickProvider}
            items={[
              { value: OFF, label: "Off" },
              ...providers.map((p) => ({
                value: p.id,
                label: p.name,
                hint: canGenerateImages(p) ? undefined : "no image output",
                disabled: !canGenerateImages(p),
              })),
            ]}
          />
        </Setting>
        {!off && (
          <>
            <Setting title="Model" description={modelHint(settings.api)}>
              <Input
                aria-label="Image model"
                className="w-full sm:w-56"
                list={listId}
                value={settings.model}
                placeholder={settings.api === "chat-modalities" ? "google/gemini-2.5-flash-image" : "gpt-image-1"}
                onChange={(e) => setImageSettings({ model: e.target.value })}
                spellCheck={false}
              />
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
              </datalist>
            </Setting>
            <Setting title="API" description={API_HINT}>
              <Segmented
                label="Image API"
                value={settings.api}
                onChange={(v) => setImageSettings({ api: v })}
                options={[
                  { value: "images", label: "Images endpoint" },
                  { value: "chat-modalities", label: "Chat with image output" },
                ]}
              />
            </Setting>
          </>
        )}
      </Group>
      <p className="text-sm text-muted-foreground">
        {off
          ? "Pick a provider and model to let chats create images. Any chat model can ask for one; the image model draws it."
          : "Chats can now create images. Any chat model can ask for one; this model draws it, and each image is billed by the provider."}
      </p>
    </Page>
  );
}
