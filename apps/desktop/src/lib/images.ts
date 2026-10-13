// Image generation: which provider/model makes images (Settings → Images), and
// the `image_generate` tool that uses it. Rust calls the provider and keeps the
// image as a blob (`images.rs`); the chat shows it from the tool's output.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, errorMessage, type GeneratedImage, type ImageApi, type ImageAspect, type ProviderView, type ToolSpec } from "@/lib/tauri";

export interface ImageSettings {
  /** null: image generation is off. */
  providerId: string | null;
  model: string;
  api: ImageApi;
}

const images = createStore<ImageSettings>("sush.images", { providerId: null, model: "", api: "images" });

export const useImageSettings = () => useSyncExternalStore(images.subscribe, images.get);
export const setImageSettings = (patch: Partial<ImageSettings>) => images.set((s) => ({ ...s, ...patch }));

/** Whether a model is set up to make images, so the tool is offered. */
export const imagesEnabled = () => {
  const s = images.get();
  return !!s.providerId && !!s.model.trim();
};

/** Claude doesn't output images, so Anthropic-format providers can't make them. */
export const canGenerateImages = (p: ProviderView) => p.format === "openai-chat";

export const isOpenRouter = (p: ProviderView) => /openrouter\.ai/.test(p.baseUrl);

/** The API a provider most likely speaks for images. */
export const defaultImageApi = (p: ProviderView): ImageApi => (isOpenRouter(p) ? "chat-modalities" : "images");

export const defaultImageModel = (p: ProviderView) =>
  isOpenRouter(p) ? "google/gemini-2.5-flash-image" : /api\.openai\.com/.test(p.baseUrl) ? "gpt-image-1" : "";

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
}

const ASPECTS: ImageAspect[] = ["square", "landscape", "portrait"];

export async function runImageGenerate(input: unknown): Promise<{ output: ImageOutput } | { errorText: string }> {
  const { prompt, aspect } = (input ?? {}) as ImageInput;
  if (typeof prompt !== "string" || !prompt.trim()) return { errorText: "image_generate needs a `prompt`." };
  if (aspect !== undefined && !ASPECTS.includes(aspect)) {
    return { errorText: "`aspect` must be square, landscape or portrait, or left out." };
  }
  const s = images.get();
  if (!s.providerId || !s.model.trim()) return { errorText: IMAGES_OFF };
  try {
    const image = await api.imageGenerate(s.providerId, s.model.trim(), s.api, prompt.trim(), aspect ?? null);
    return { output: { ...image, prompt: prompt.trim(), note: "The image is shown to the user." } };
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
