// The message shape chats use, and attachment storage. Messages are AI SDK
// `UIMessage`s; Rust builds and streams them (`sush_core::agent::ui`) and
// `sessions.ts` mirrors them for rendering.

import type { FileUIPart, UIMessage } from "ai";

import { api } from "@/lib/tauri";

export interface ModelTarget {
  providerId: string;
  model: string;
}

export interface SushMetadata {
  providerId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** When the reply started (ms); missing on replies saved before it was recorded. */
  createdAt?: number;
}

/** A provider-run tool (web search/fetch) and the pages it returned. */
export interface WebActivity {
  name: string;
  input: unknown;
  sources: { url: string; title?: string | null }[];
}

export type SushDataTypes = { web: WebActivity };

export type SushUIMessage = UIMessage<SushMetadata, SushDataTypes>;

/** Media type for a folder attachment: one text blob holding all its files. */
export const FOLDER_MEDIA_TYPE = "text/x-sush-folder";

/**
 * Move image and PDF attachments to disk, so messages carry a short URL
 * instead of the bytes. Anything that fails stays inline; saving the chat
 * moves it later.
 */
export async function storeAttachments(files: FileUIPart[]): Promise<FileUIPart[]> {
  return Promise.all(
    files.map(async (f) => {
      if (!f.url.startsWith("data:") || !(f.mediaType.startsWith("image/") || f.mediaType === "application/pdf")) return f;
      try {
        return { ...f, url: await api.blobPut(f.url) };
      } catch (e) {
        console.warn("Could not store attachment", e);
        return f;
      }
    }),
  );
}
