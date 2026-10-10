// One-shot, non-chat model calls (draft a skill, revise memory): send a system
// prompt and one user message, collect the streamed text.

import { Channel } from "@tauri-apps/api/core";

import { api, type ChatRequest, type StreamFrame } from "@/lib/tauri";
import type { ModelTarget } from "@/lib/transport";

export async function complete(target: ModelTarget, system: string, user: string): Promise<string> {
  const request: ChatRequest = {
    model: target.model,
    system,
    messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
  };

  let text = "";
  let error: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const channel = new Channel<StreamFrame>();
    channel.onmessage = (frame) => {
      if (frame.type === "end") resolve();
      else if (frame.event.type === "text-delta") text += frame.event.delta;
      else if (frame.event.type === "error") error = frame.event.message;
    };
    api.chatStream(crypto.randomUUID(), target.providerId, request, channel).catch(reject);
  });
  if (error) throw new Error(error);
  return text;
}

/** The first `{...}` object in a reply, for models that wrap JSON in prose or fences. */
export function extractJson(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
