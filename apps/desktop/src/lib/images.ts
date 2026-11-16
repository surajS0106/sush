// Image generation: which provider/model makes images (Settings → Images), and
// the `image_generate` tool that uses it. Rust calls the provider and keeps the
// image as a blob (`images.rs`); the chat shows it from the tool's output.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, errorMessage, type GeneratedImage, type ImageApi, type ImageAspect, type ProviderView, type ToolSpec } from "@/lib/tauri";

export interface ImageSettings {
  /** null: automatic (the first added provider that can draw); `IMAGES_OFF_ID`: off. */
  providerId: string | null;
  model: string;
  api: ImageApi;
}

export const IMAGES_OFF_ID = "off";

const images = createStore<ImageSettings>("sush.images", { providerId: null, model: "", api: "images" });

export const useImageSettings = () => useSyncExternalStore(images.subscribe, images.get);
export const setImageSettings = (patch: Partial<ImageSettings>) => images.set((s) => ({ ...s, ...patch }));

/** The providers the user has added, so "automatic" can pick one. Kept current by `useProviders`. */
let known: ProviderView[] = [];
const knownListeners = new Set<() => void>();
export const setImageProviders = (list: ProviderView[]) => {
  known = list;
  knownListeners.forEach((l) => l());
};
const subscribeKnown = (l: () => void) => {
  knownListeners.add(l);
  return () => void knownListeners.delete(l);
};
const getKnown = () => known;

/** A provider's settings for images, when we know a model it draws with and it's ready to call. */
const autoFor = (p: ProviderView): ImageSettings | null => {
  const model = defaultImageModel(p);
  const ready = p.auth.type !== "api-key" || p.hasKey;
  return canGenerateImages(p) && ready && model ? { providerId: p.id, model, api: defaultImageApi(p) } : null;
};

/**
 * What draws images right now: the user's pick, or automatically the first added provider that can
 * (OpenAI, xAI, OpenRouter), so a chat with any model can make images without visiting Settings.
 * null when off or nothing can draw.
 */
export function activeImageSettings(): ImageSettings | null {
  const s = images.get();
  if (s.providerId === IMAGES_OFF_ID) return null;
  if (s.providerId) {
    if (s.model.trim()) return { ...s, model: s.model.trim() };
    const p = known.find((x) => x.id === s.providerId);
    return p ? autoFor(p) : null;
  }
  for (const p of known) {
    const auto = autoFor(p);
    if (auto) return auto;
  }
  return null;
}

/** Whether a model is set up to make images, so the tool is offered. */
export const imagesEnabled = () => activeImageSettings() !== null;

/** The provider "automatic" would use, for Settings to name it. */
export const autoImageProvider = () => known.find((p) => autoFor(p));

/** What draws images right now, re-rendering as settings or the provider list change. */
export function useActiveImageSettings(): ImageSettings | null {
  useSyncExternalStore(images.subscribe, images.get);
  useSyncExternalStore(subscribeKnown, getKnown);
  return activeImageSettings();
}

export const useImagesReady = () => useActiveImageSettings() !== null;

/** Whether a provider has a model we know draws images, for the "Images" tag in Settings. */
export const drawsImages = (p: ProviderView) => canGenerateImages(p) && !!defaultImageModel(p);

/** Claude doesn't output images, so Anthropic-format providers can't make them. */
export const canGenerateImages = (p: ProviderView) => p.format === "openai-chat";

export const isOpenRouter = (p: ProviderView) => /openrouter\.ai/.test(p.baseUrl);

/** The API a provider most likely speaks for images. */
export const defaultImageApi = (p: ProviderView): ImageApi => (isOpenRouter(p) ? "chat-modalities" : "images");

export const defaultImageModel = (p: ProviderView) =>
  isOpenRouter(p)
    ? "google/gemini-2.5-flash-image"
    : /api\.openai\.com/.test(p.baseUrl)
      ? "gpt-image-1"
      : /api\.x\.ai/.test(p.baseUrl)
        ? "grok-imagine-image"
        : "";

// --- the tool ------------------------------------------------------------------------

export const IMAGE_GENERATE = "image_generate";

export const imageTool: ToolSpec = {
  name: IMAGE_GENERATE,
  description:
    "Generate an image (a picture, illustration, photo, wallpaper, logo, icon, diagram-like art) from a text " +
    "description and show it to the user. Use it whenever the user asks you to create, draw, make or design an " +
    "image; don't write HTML, SVG or an artifact instead unless they ask for code. Each call makes one image; to " +
    "change an image, call it again with a revised prompt. The image is shown to the user right under the call, " +
    "so don't link, embed or describe it at length; say in a sentence what you made.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A detailed description of the image: subject, composition, style, lighting, colours, mood, and any text " +
          "it should contain, written in English.",
      },
      aspect: {
        type: "string",
        enum: ["square", "landscape", "portrait"],
        description: "Shape of the image. Landscape for wallpapers and banners, portrait for phone wallpapers and posters.",
      },
    },
    required: ["prompt"],
  },
};

/**
 * In the system prompt while images are on: a request for a picture is answered by drawing it at once,
 * the way ChatGPT does, not by planning, asking or offering options first.
 */
export const IMAGES_SECTION =
  "When the user asks you to create, draw, generate, make or design an image, picture, photo, illustration, " +
  "logo, icon or wallpaper, call image_generate straight away as your first step. Write the detailed prompt " +
  "yourself from their words, choosing the style, composition, lighting and colours they didn't specify. " +
  "Don't ask clarifying questions, don't make a to-do list, don't describe options or ask which they prefer, " +
  "and don't search the web first unless the image depends on facts you don't know. After the image, say in " +
  "one short sentence what you made.";

/** Sent with a message written in image mode (the composer's Image chip): draw it, nothing else. */
export const IMAGE_MODE_INSTRUCTION =
  "The user picked Create image for this message: call image_generate now, with a detailed prompt built from " +
  "the message above (and any attached image as reference for its content and style). Don't ask questions or " +
  "plan first. Then say in one short sentence what you made.";

export const IMAGES_OFF =
  "You can't generate images in this chat: no image model is set up. If the user asks for an image, say so " +
  "and tell them they can pick an image model in Settings → Images; don't offer HTML or SVG as a substitute " +
  "unless they ask for it.";

export interface ImageInput {
  prompt?: string;
  aspect?: ImageAspect;
}

/** What the tool's output holds; the chat renders it. */
export interface ImageOutput extends GeneratedImage {
  prompt: string;
  note: string;
  /** Which provider and model drew it, for the card; stripped before the model (`CARD_ONLY`). Missing on older images. */
  cardOnly?: { model: string; provider?: string };
}

const ASPECTS: ImageAspect[] = ["square", "landscape", "portrait"];

export async function runImageGenerate(input: unknown): Promise<{ output: ImageOutput } | { errorText: string }> {
  const { prompt, aspect } = (input ?? {}) as ImageInput;
  if (typeof prompt !== "string" || !prompt.trim()) return { errorText: "image_generate needs a `prompt`." };
  if (aspect !== undefined && !ASPECTS.includes(aspect)) {
    return { errorText: "`aspect` must be square, landscape or portrait, or left out." };
  }
  const s = activeImageSettings();
  if (!s?.providerId) return { errorText: IMAGES_OFF };
  try {
    const image = await api.imageGenerate(s.providerId, s.model, s.api, prompt.trim(), aspect ?? null);
    // The provider's name as it is now, so renaming or removing it later doesn't change the record.
    const provider = known.find((p) => p.id === s.providerId)?.name;
    return {
      output: { ...image, prompt: prompt.trim(), note: "The image is shown to the user.", cardOnly: { model: s.model, provider } },
    };
  } catch (e) {
    return { errorText: `Image generation failed: ${errorMessage(e)}` };
  }
}

/** Save a generated image through a save dialog. */
export async function saveImage(output: ImageOutput) {
  const dataUrl = await api.blobDataUrl(output.url);
  const ext = output.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const name = output.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  return api.saveBytesFileAs(`${name}.${ext}`, dataUrl.slice(dataUrl.indexOf(",") + 1));
}
