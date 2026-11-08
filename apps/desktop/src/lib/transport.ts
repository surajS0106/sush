// The message shape chats use, and attachment storage. Messages are AI SDK
// `UIMessage`s; Rust builds and streams them (`sush_core::agent::ui`) and
// `sessions.ts` mirrors them for rendering.

import type { FileUIPart, UIMessage } from "ai";

import { api, type ShareAuthor } from "@/lib/tauri";

export interface ModelTarget {
  providerId: string;
  model: string;
}

export interface SushMetadata {
  providerId?: string;
  model?: string;
  /** Input tokens billed across every model step of the reply; each step re-reads the conversation. */
  inputTokens?: number;
  outputTokens?: number;
  /** The part of `inputTokens` read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** The last step's input: how big the conversation the model read was. */
  contextTokens?: number;
  /** How many model steps (calls) the reply took. */
  steps?: number;
  /** When the reply started (ms); missing on replies saved before it was recorded. */
  createdAt?: number;
  /** On a reply that was stopped before it finished; Resume carries on from it. */
  paused?: boolean;
  /** On the "continue" message Resume adds when a reply stopped mid-text. */
  resumed?: boolean;
  /** On the message that brings a background sub-agent's report (`sush_core::agent::subagents::report_message`). */
  subagentReport?: { callId: string; description: string; status: "done" | "failed" };
  /**
   * On a message a card's button sent (the branch card's Merge, Commit, Delete branch): what the model
   * gets in place of the short text shown, and the exact commands the click already approved.
   */
  instruction?: { text: string; approves?: string[] };
  /** In a shared session, on a message someone else wrote (set by the host, never by the sender). */
  author?: ShareAuthor;
  /** On a collaborator's suggestion: who sent it on. */
  acceptedBy?: ShareAuthor;
  /** On a reply in a shared session: who answered its tool calls, by call id (`sush_core::agent::ANSWERS`). */
  sushAnswers?: Record<string, { by: ShareAuthor; decision: "approve" | "deny" | "answer"; at: number }>;
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
