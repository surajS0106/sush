// Bridges AI SDK's `useChat` to the Rust core: instead of POSTing to an HTTP
// route, `sendMessages` invokes the `chat_stream` command and translates the
// normalised `ChatEvent`s from its channel into `UIMessageChunk`s.

import { Channel } from "@tauri-apps/api/core";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

import { api, errorMessage, type ChatEvent, type CoreMessage, type CorePart, type FinishReason, type StreamFrame } from "@/lib/tauri";
import type { RequestContext } from "@/lib/agent";
import { expandSlash } from "@/lib/skills";

export interface ModelTarget {
  providerId: string;
  model: string;
}

export interface SushMetadata {
  providerId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
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

export class TauriChatTransport implements ChatTransport<SushUIMessage> {
  constructor(
    private readonly getTarget: () => ModelTarget | null,
    private readonly getContext: () => RequestContext = () => ({ tools: [], research: false }),
  ) {}

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<SushUIMessage>["sendMessages"]>[0]): Promise<ReadableStream<UIMessageChunk<SushMetadata>>> {
    const target = this.getTarget();
    if (!target) throw new Error("Pick a model first. Add a provider in Settings if the list is empty.");

    const streamId = crypto.randomUUID();
    const { system, tools, research } = this.getContext();
    const request = { model: target.model, messages: toCoreMessages(messages), system, tools, research };

    return new ReadableStream<UIMessageChunk<SushMetadata>>({
      start(controller) {
        const parts = new PartTracker((c) => controller.enqueue(c));
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          parts.end();
          controller.close();
        };

        parts.emit({ type: "start", messageMetadata: { providerId: target.providerId, model: target.model } });
        parts.emit({ type: "start-step" });

        const channel = new Channel<StreamFrame>();
        channel.onmessage = (frame) => {
          if (closed) return;
          if (frame.type === "end") {
            parts.finish();
            close();
          } else {
            parts.handle(frame.event);
          }
        };

        abortSignal?.addEventListener("abort", () => {
          void api.cancelStream(streamId);
          close();
        });

        api.chatStream(streamId, target.providerId, request, channel).catch((e) => {
          if (closed) return;
          parts.emit({ type: "error", errorText: errorMessage(e) });
          close();
        });
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk<SushMetadata>> | null> {
    return null; // streams live in-process; nothing to resume
  }
}

/** Opens/closes text, reasoning and tool parts as provider events arrive. */
class PartTracker {
  private text: string | null = null;
  private reasoning: string | null = null;
  private tools = new Map<number, { id: string; name: string; args: string }>();
  private web = new Map<string, WebActivity>();
  private usage: SushMetadata = {};
  private finishReason: FinishReason | undefined;
  private failed = false;
  private seq = 0;

  constructor(readonly emit: (chunk: UIMessageChunk<SushMetadata>) => void) {}

  private nextId(kind: string) {
    return `${kind}-${this.seq++}`;
  }

  handle(ev: ChatEvent) {
    switch (ev.type) {
      case "text-delta":
        this.closeReasoning();
        if (!this.text) {
          this.text = this.nextId("text");
          this.emit({ type: "text-start", id: this.text });
        }
        this.emit({ type: "text-delta", id: this.text, delta: ev.delta });
        break;
      case "reasoning-delta":
        this.closeText();
        if (!this.reasoning) {
          this.reasoning = this.nextId("reasoning");
          this.emit({ type: "reasoning-start", id: this.reasoning });
        }
        this.emit({ type: "reasoning-delta", id: this.reasoning, delta: ev.delta });
        break;
      case "tool-call-delta": {
        let tool = this.tools.get(ev.index);
        if (!tool) {
          tool = { id: ev.id ?? this.nextId("call"), name: ev.name ?? "unknown", args: "" };
          this.tools.set(ev.index, tool);
          this.emit({ type: "tool-input-start", toolCallId: tool.id, toolName: tool.name, dynamic: true });
        }
        if (ev.argsDelta) {
          tool.args += ev.argsDelta;
          this.emit({ type: "tool-input-delta", toolCallId: tool.id, inputTextDelta: ev.argsDelta });
        }
        break;
      }
      case "server-tool-call": {
        // Text after a search belongs after it, so start a new text part.
        this.closeText();
        this.closeReasoning();
        const activity = { name: ev.name, input: ev.input, sources: [] };
        this.web.set(ev.id, activity);
        this.emit({ type: "data-web", id: ev.id, data: activity });
        break;
      }
      case "web-sources": {
        const activity = this.web.get(ev.callId);
        if (!activity) break;
        activity.sources = [...activity.sources, ...ev.sources];
        this.emit({ type: "data-web", id: ev.callId, data: { ...activity } });
        break;
      }
      case "usage":
        this.usage = { inputTokens: ev.inputTokens ?? undefined, outputTokens: ev.outputTokens ?? undefined };
        break;
      case "finish":
        this.finishReason = ev.reason;
        break;
      case "error":
        this.failed = true;
        this.emit({ type: "error", errorText: ev.message });
        break;
    }
  }

  /** Normal end of stream: flush tool inputs, usage and the finish reason. */
  finish() {
    if (this.failed) return; // the error chunk already ended the message
    this.closeText();
    this.closeReasoning();
    for (const tool of this.tools.values()) {
      this.emit({
        type: "tool-input-available",
        toolCallId: tool.id,
        toolName: tool.name,
        input: parseJson(tool.args),
        dynamic: true,
      });
    }
    this.tools.clear();
    this.emit({ type: "finish-step" });
    if (this.usage.inputTokens !== undefined || this.usage.outputTokens !== undefined) {
      this.emit({ type: "message-metadata", messageMetadata: this.usage });
    }
    this.emit({ type: "finish", finishReason: this.finishReason });
  }

  /** Close any open parts (also used when aborting). */
  end() {
    this.closeText();
    this.closeReasoning();
  }

  private closeText() {
    if (this.text) this.emit({ type: "text-end", id: this.text });
    this.text = null;
  }

  private closeReasoning() {
    if (this.reasoning) this.emit({ type: "reasoning-end", id: this.reasoning });
    this.reasoning = null;
  }
}

function parseJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const UNANSWERED = "No result: the user continued the conversation instead.";

/** UIMessage parts -> sush-core message parts. */
export function toCoreMessages(messages: SushUIMessage[]): CoreMessage[] {
  return messages
    .map((m): CoreMessage => {
      const parts: CorePart[] = [];
      for (const p of m.parts) {
        if (p.type === "text") {
          // `/skill args` reaches the model as the skill's instructions plus the arguments.
          const text = m.role === "user" && p === m.parts.find((x) => x.type === "text") ? expandSlash(p.text) : p.text;
          if (text) parts.push({ type: "text", text });
        } else if (p.type === "reasoning") {
          parts.push({ type: "reasoning", text: p.text });
        } else if (p.type === "file") {
          const part = filePart(p.url, p.mediaType, p.filename);
          if (part) parts.push(part);
        } else if (p.type === "dynamic-tool") {
          parts.push({ type: "tool-call", id: p.toolCallId, name: p.toolName, input: p.input ?? {} });
          if (p.state === "output-available") {
            parts.push({ type: "tool-result", callId: p.toolCallId, output: p.output });
          } else if (p.state === "output-error") {
            parts.push({ type: "tool-result", callId: p.toolCallId, output: p.errorText, isError: true });
          } else {
            // Providers reject a tool call without a result. If the user moved on
            // (e.g. typed a message instead of answering), say so.
            parts.push({ type: "tool-result", callId: p.toolCallId, output: UNANSWERED, isError: true });
          }
        }
      }
      return { role: m.role, parts };
    })
    .filter((m) => m.parts.length > 0);
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh|sql|graphql)|$)/;

/** An attachment as the model sees it: images and PDFs natively, text inline. */
function filePart(url: string, mediaType: string, filename?: string): CorePart | null {
  const parsed = parseDataUrl(url);
  if (!parsed) return null;
  const name = filename ?? "attachment";
  if (mediaType.startsWith("image/")) return { type: "image", ...parsed };
  if (mediaType === "application/pdf") return { type: "document", ...parsed, name };
  const text = TEXT_TYPES.test(mediaType) ? decodeText(parsed.data) : null;
  if (text === null) return { type: "text", text: `[Attached ${name} (${mediaType || "unknown type"}): this file type can't be read.]` };
  if (mediaType === FOLDER_MEDIA_TYPE) return { type: "text", text };
  return { type: "text", text: `<file name="${name}">\n${text}\n</file>` };
}

/** UTF-8 text, or null for binary data. */
function decodeText(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (bytes.subarray(0, 8192).includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : null;
}
