// Settings → Images: which provider and model generate images for the
// `image_generate` tool. Automatic by default: the first added provider that can draw.
// The card on top says, in words, what happens when you ask for a picture.

import { ImageIcon, ImageOffIcon, MessageSquareIcon, PlusIcon, ReceiptIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { Logo } from "@/components/model-picker";
import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Input } from "@/components/ui/input";
import {
  autoImageProvider,
  canGenerateImages,
  defaultImageApi,
  defaultImageModel,
  drawsImages,
  IMAGES_OFF_ID,
  setImageSettings,
  useActiveImageSettings,
  useImageSettings,
} from "@/lib/images";
import { providerLogo } from "@/lib/logos";
import { friendlyName, isImageOnlyModel } from "@/lib/model-names";
import { api, type ModelInfo, type ProviderView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const AUTO = "auto";

const PROVIDER_HINT = "Where image prompts go. Automatic uses the first of your providers that can draw.";
const API_HINT =
  "The images endpoint for OpenAI, Azure Foundry, xAI and Ollama's image models. Chat with image output for OpenRouter's image models.";

const modelHint = (imageApi: string) =>
  imageApi === "chat-modalities"
    ? "An image-output model, such as google/gemini-2.5-flash-image on OpenRouter."
    : "An image model such as gpt-image-1 or grok-imagine-image. On Azure Foundry, use your deployment name.";

export function ImagesSection({ providers }: { providers: ProviderView[] }) {
  const settings = useImageSettings();
  const active = useActiveImageSettings();
  const providerId = settings.providerId ?? AUTO;
  const off = providerId === IMAGES_OFF_ID;
  const auto = providerId === AUTO;
  const autoProvider = autoImageProvider();
  const activeProvider = active ? providers.find((p) => p.id === active.providerId) : undefined;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const listId = useId();

  useEffect(() => {
    setModels([]);
    if (off || auto) return;
    let live = true;
    api.listModels(providerId).then((m) => live && setModels(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [providerId, off, auto]);

  // Image models first in the suggestions: they're the ones that belong here.
  const suggestions = useMemo(
    () => [...models].sort((a, b) => Number(isImageOnlyModel(b.id)) - Number(isImageOnlyModel(a.id))),
    [models],
  );

  const pickProvider = (id: string) => {
    if (id === AUTO) return setImageSettings({ providerId: null, model: "" });
    if (id === IMAGES_OFF_ID) return setImageSettings({ providerId: IMAGES_OFF_ID });
    const p = providers.find((x) => x.id === id);
    if (p) setImageSettings({ providerId: id, api: defaultImageApi(p), model: defaultImageModel(p) });
  };

  const logo = (p: ProviderView) => <Logo src={providerLogo(p)} className="size-4" />;

  return (
    <Page>
      <StatusCard
        off={off}
        provider={activeProvider}
        model={active?.model}
        automatic={auto}
      />

      <Group title="Image model">
        <Setting title="Provider" description={PROVIDER_HINT}>
          <DropdownMenu
            label="Image provider"
            align="end"
            variant="field"
            className="w-full sm:w-64"
            value={providerId}
            onChange={pickProvider}
            items={[
              {
                value: AUTO,
                label: "Automatic",
                icon: <ImageIcon className="size-4 text-muted-foreground" />,
                hint: autoProvider ? autoProvider.name : "none yet",
              },
              ...providers.map((p) => ({
                value: p.id,
                label: p.name,
                icon: logo(p),
                // The tag: which providers make images out of the box, and which can't at all.
                hint: !canGenerateImages(p) ? "no images" : drawsImages(p) ? "Images" : "name a model",
                disabled: !canGenerateImages(p),
              })),
              { value: IMAGES_OFF_ID, label: "Off", icon: <ImageOffIcon className="size-4 text-muted-foreground" /> },
            ]}
          />
        </Setting>
        {!off && !auto && (
          <>
            <Setting title="Model" description={modelHint(settings.api)}>
              <Input
                aria-label="Image model"
                className="w-full sm:w-64"
                list={listId}
                value={settings.model}
                placeholder={settings.api === "chat-modalities" ? "google/gemini-2.5-flash-image" : "gpt-image-1"}
                onChange={(e) => setImageSettings({ model: e.target.value })}
                spellCheck={false}
              />
              <datalist id={listId}>
                {suggestions.map((m) => (
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

      {!off && (
        <Group title="Making images">
          <Tip icon={<MessageSquareIcon />} title="Just ask">
            Say “draw a lighthouse at dusk” in any chat, with any model, and the picture appears in the reply.
          </Tip>
          <Tip icon={<PlusIcon />} title="Image chip">
            Pick Create image from the + menu and every message you send is drawn, until you remove the chip.
          </Tip>
          <Tip icon={<ReceiptIcon />} title="Billing">
            Each image is billed by {activeProvider?.name ?? "the image provider"}, separately from the chat model.
          </Tip>
        </Group>
      )}
    </Page>
  );
}

/** What happens when you ask for a picture, in one glance. */
function StatusCard({
  off,
  provider,
  model,
  automatic,
}: {
  off: boolean;
  provider?: ProviderView;
  model?: string;
  automatic: boolean;
}) {
  const on = !off && !!provider && !!model;
  const title = off ? "Images are off" : on ? "Images are on" : "No image model yet";
  const text = off
    ? "Chats won't create images. Pick Automatic or a provider below to turn them on."
    : on
      ? null
      : "Add an OpenAI, xAI or OpenRouter provider in Settings → Providers, or pick a provider below and name its image model.";

  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-xl border p-4",
        on ? "border-sky-500/25 bg-sky-500/[0.06]" : "bg-muted/30",
      )}
    >
      <div
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-xl",
          on ? "bg-sky-500/15 text-sky-600 dark:text-sky-300" : "bg-muted text-muted-foreground",
        )}
      >
        {off ? <ImageOffIcon className="size-6" /> : <ImageIcon className="size-6" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {on && provider && model ? (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            Drawn by
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-background/60 px-1.5 py-0.5 text-foreground">
              <Logo src={providerLogo(provider)} className="size-3.5" />
              {friendlyName(model)}
            </span>
            on {provider.name}
            {automatic && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">Automatic</span>}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">{text}</p>
        )}
      </div>
    </div>
  );
}

function Tip({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
