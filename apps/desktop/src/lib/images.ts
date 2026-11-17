// Image generation: which provider/model makes images (Settings → Images), and
// the `image_generate` tool that uses it. Rust calls the provider and keeps the
// image as a blob (`images.rs`); the chat shows it from the tool's output.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { Channel } from "@tauri-apps/api/core";

import { imageCostUsd, isLocalUrl } from "@/lib/pricing";
import type { SushUIMessage } from "@/lib/transport";
import {
  api,
  errorMessage,
  type GeneratedImage,
  type ImageApi,
  type ImageAspect,
  type ImageQuality,
  type ImageUsage,
  type ProviderView,
  type RunConfig,
  type ToolSpec,
} from "@/lib/tauri";

export interface ImageSettings {
  /** null: automatic (the first added provider that can draw); `IMAGES_OFF_ID`: off. */
  providerId: string | null;
  model: string;
  api: ImageApi;
  /** gpt-image's detail level; missing means `auto` (the model decides). Other models ignore it. */
  quality?: ImageQuality;
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
  return canGenerateImages(p) && ready && model ? { providerId: p.id, model, api: defaultImageApi(p), quality: images.get().quality } : null;
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

/**
 * Image chats: the chats set to draw (an image model picked in the model picker, or Create image from the
 * + menu). Every message in one goes to the image model until a chat model is picked. Kept per chat, so
 * it survives switching chats and restarts.
 */
const imageChats = createStore<Record<string, true>>("sush.image-chats", {});

export const isImageChat = (id: string) => !!imageChats.get()[id];
export const useImageChat = (id: string | undefined) => useSyncExternalStore(imageChats.subscribe, () => !!id && isImageChat(id));
export function setImageChat(id: string, on: boolean) {
  if (on === isImageChat(id)) return;
  imageChats.set((prev) => {
    const next = { ...prev };
    if (on) next[id] = true;
    else delete next[id];
    return next;
  });
}

/** Whether a model takes gpt-image's `quality` (and streams rough versions while it draws). */
export const takesQuality = (model: string) => /^gpt-image/i.test(model.split("/").pop() ?? model);

/** The quality levels a model offers: `xhigh` and `max` arrived with gpt-image-2.6. */
export function qualityLevels(model: string): ImageQuality[] {
  const m = /^gpt-image-(\d+)(?:\.(\d+))?/i.exec(model.split("/").pop() ?? model);
  const newer = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2] ?? 0) >= 6));
  return newer ? ["auto", "low", "medium", "high", "xhigh", "max"] : ["auto", "low", "medium", "high"];
}

/** How each quality level reads in Settings and the composer. */
export const QUALITY_LABELS: Record<ImageQuality, { label: string; hint?: string }> = {
  auto: { label: "Auto", hint: "model decides" },
  low: { label: "Low", hint: "fastest" },
  medium: { label: "Medium" },
  high: { label: "High", hint: "small text, diagrams" },
  xhigh: { label: "Extra high" },
  max: { label: "Max", hint: "slowest" },
};

/** The quality a model draws at: the setting, or Auto where the model doesn't offer it. */
export const effectiveQuality = (s: Pick<ImageSettings, "model" | "quality">): ImageQuality =>
  s.quality && qualityLevels(s.model).includes(s.quality) ? s.quality : "auto";

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
      ? "gpt-image-2.6-flare"
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
    "so don't link, embed or describe it, and don't add a closing sentence about it.",
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
  "and don't search the web first unless the image depends on facts you don't know. After the image, write " +
  "nothing more: it is shown with its prompt.";

const IMAGE_MODE_LEAD = "The user picked Create image for this message";

/**
 * Sent with a message written in image mode (an image chat, `setImageChat`). Such a message goes straight to the
 * image model (`directImageCall`); the chat model only reads this when the message has attachments, which
 * the image model can't take.
 */
export const IMAGE_MODE_INSTRUCTION =
  `${IMAGE_MODE_LEAD}: call image_generate now, with a detailed prompt built from the message above (and any ` +
  "attached image as reference for its content and style). Don't ask questions or plan first, and write nothing " +
  "after the image.";

/**
 * Image mode without the chat model: when the thread ends in a message sent in an image chat, the image
 * model gets its words as typed, and the reply is just the picture. A message with attachments still goes
 * to the chat model, which can look at them and describe what to draw.
 */
export function directImageCall(messages: SushUIMessage[]): RunConfig["direct"] {
  const last = messages.at(-1);
  if (last?.role !== "user" || !last.metadata?.instruction?.text.startsWith(IMAGE_MODE_LEAD)) return undefined;
  if (last.parts.some((p) => p.type === "file") || !imagesEnabled()) return undefined;
  const asked = last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n").trim();
  if (!asked) return undefined;
  // The image model sees no history, so a follow-up ("add snow") is sent with what the last picture was.
  const before = lastImagePrompt(messages.slice(0, -1));
  const prompt = before
    ? `The previous image in this conversation was drawn from this description:\n${before}\n\n` +
      `The user now says: ${asked}\n\nIf that asks to change the previous image, draw the previous image again ` +
      "with that change and everything else kept the same. Otherwise draw only what the user now asks for."
    : asked;
  // The card shows what the user typed; `description` is what the picture now shows, for the next follow-up.
  return {
    name: IMAGE_GENERATE,
    input: before ? { prompt, caption: asked, description: `${before}\nThen changed: ${asked}` } : { prompt },
  };
}

/**
 * What the latest picture in a thread shows: the full description it was drawn from. A follow-up's own
 * description already carries the one before it, so changes build up ("add snow", then "make it night").
 */
function lastImagePrompt(messages: SushUIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.type !== "dynamic-tool" || p.toolName !== IMAGE_GENERATE || p.state !== "output-available") continue;
      const out = p.output as Partial<ImageOutput>;
      return out.revisedPrompt ?? out.drawnFrom ?? out.prompt;
    }
  }
  return undefined;
}

export const IMAGES_OFF =
  "You can't generate images in this chat: no image model is set up. If the user asks for an image, say so " +
  "and tell them they can pick an image model in Settings → Images; don't offer HTML or SVG as a substitute " +
  "unless they ask for it.";

export interface ImageInput {
  prompt?: string;
  aspect?: ImageAspect;
  /** An image chat's follow-up: what the card shows (what the user typed), as `prompt` carries context too. */
  caption?: string;
  /** An image chat's follow-up: everything the picture shows, built up over the follow-ups. */
  description?: string;
}

/** What the tool's output holds; the chat renders it. */
export interface ImageOutput extends Omit<GeneratedImage, "usage"> {
  prompt: string;
  /** After an image chat's follow-up: everything the picture shows, where `prompt` is only the change asked for. */
  drawnFrom?: string;
  note: string;
  /** Which provider and model drew it, for the card; stripped before the model (`CARD_ONLY`). Missing on older images. */
  cardOnly?: {
    model: string;
    provider?: string;
    /** What it cost in USD: 0 on a local server, missing when the provider gave no usage or the price isn't known. */
    costUsd?: number;
    usage?: ImageUsage;
  };
}

const ASPECTS: ImageAspect[] = ["square", "landscape", "portrait"];

// --- rough versions while it draws -----------------------------------------------------

/** The latest rough version of each image being made, by tool call id. Never stored. */
const previews = new Map<string, string>();
const previewListeners = new Set<() => void>();
const setPreview = (callId: string, url: string | null) => {
  if (url) previews.set(callId, url);
  else previews.delete(callId);
  previewListeners.forEach((l) => l());
};
const subscribePreviews = (l: () => void) => {
  previewListeners.add(l);
  return () => void previewListeners.delete(l);
};

/** The rough version streamed so far for a call, while it draws. */
export const useImagePreview = (callId: string) => useSyncExternalStore(subscribePreviews, () => previews.get(callId));

export async function runImageGenerate(input: unknown, callId?: string): Promise<{ output: ImageOutput } | { errorText: string }> {
  const { prompt, aspect, caption, description } = (input ?? {}) as ImageInput;
  if (typeof prompt !== "string" || !prompt.trim()) return { errorText: "image_generate needs a `prompt`." };
  if (aspect !== undefined && !ASPECTS.includes(aspect)) {
    return { errorText: "`aspect` must be square, landscape or portrait, or left out." };
  }
  const s = activeImageSettings();
  if (!s?.providerId) return { errorText: IMAGES_OFF };
  try {
    const onPartial = new Channel<string>();
    if (callId) onPartial.onmessage = (url) => setPreview(callId, url);
    // Auto is the API's default; a level the model doesn't offer (Max on an older model) is left to it too.
    const level = effectiveQuality(s);
    const quality = takesQuality(s.model) && level !== "auto" ? level : null;
    const image = await api
      .imageGenerate(s.providerId, s.model, s.api, prompt.trim(), aspect ?? null, quality, onPartial)
      .finally(() => callId && setPreview(callId, null));
    // The provider's name as it is now, so renaming or removing it later doesn't change the record.
    const source = known.find((p) => p.id === s.providerId);
    const provider = source?.name;
    // The cost from the tokens billed (gpt-image), on the card only: the model doesn't need it.
    const { usage, ...made } = image;
    const costUsd = source && isLocalUrl(source.baseUrl) ? 0 : usage ? imageCostUsd(s.model, usage) : undefined;
    return {
      output: {
        ...made,
        prompt: caption?.trim() || prompt.trim(),
        drawnFrom: description,
        note: "The image is shown to the user.",
        cardOnly: { model: s.model, provider, costUsd, usage: usage ?? undefined },
      },
    };
  } catch (e) {
    const message = errorMessage(e);
    // OpenAI's content filter (`moderation_blocked`): say so plainly, keeping the request ID for its support.
    if (/safety system|moderation_blocked|content policy/i.test(message)) {
      const request = /req_[A-Za-z0-9]+/.exec(message)?.[0];
      return {
        errorText:
          `${s.model} declined this picture: the provider's safety system blocked it. Images of copyrighted ` +
          `characters, real people and some other subjects are often refused.${request ? ` Request ID: ${request}.` : ""}`,
      };
    }
    return { errorText: `Image generation failed: ${message}` };
  }
}

/** Save a generated image through a save dialog. */
export async function saveImage(output: ImageOutput) {
  const dataUrl = await api.blobDataUrl(output.url);
  const ext = output.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const name = output.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  return api.saveBytesFileAs(`${name}.${ext}`, dataUrl.slice(dataUrl.indexOf(",") + 1));
}
