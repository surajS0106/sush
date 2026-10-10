// Artifacts: standalone documents or code files the model writes with
// `artifact_write`. Each call is a version; calls sharing an `id` are one
// artifact's history. Nothing is stored separately: the history is read back
// from the conversation's tool calls.

import type { Version } from "@/components/ui/Artifact";
import type { ToolSpec } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";

export const ARTIFACT_WRITE = "artifact_write";

export const artifactTool: ToolSpec = {
  name: ARTIFACT_WRITE,
  description:
    "Show a standalone document or code file in an artifact panel the user can copy, download and step through " +
    "versions of. Use it for substantial content the user will keep or iterate on: code files, documents, emails, " +
    "configs, anything over about 20 lines meant to be reused. Don't use it for short answers or explanations. " +
    "Always pass the complete content. To revise an artifact, call this again with the same id; each call becomes " +
    "a new version. Don't repeat the content in your reply; say in a sentence what you made or changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Short kebab-case slug, kept the same across revisions, e.g. 'landing-page'" },
      filename: { type: "string", description: "File name with extension, e.g. 'landing-page.html' or 'cover-letter.md'" },
      note: { type: "string", description: "What this version is or changed, in a few words, e.g. 'Added dark mode'" },
      content: { type: "string", description: "The full content of the file" },
    },
    required: ["id", "filename", "content"],
  },
};

export interface ArtifactInput {
  id?: string;
  filename?: string;
  note?: string;
  content?: string;
}

export function validateArtifact(input: unknown): string | null {
  const a = (input ?? {}) as ArtifactInput;
  if (typeof a.id !== "string" || !a.id.trim()) return "artifact_write needs an `id`.";
  if (typeof a.filename !== "string" || !a.filename.trim()) return "artifact_write needs a `filename`.";
  if (typeof a.content !== "string") return "artifact_write needs the full `content`.";
  return null;
}

/** One `artifact_write` call as shown in the chat: its artifact's versions up to and including this one. */
export interface ArtifactView {
  filename: string;
  versions: Version[];
}

/** Every artifact call in a conversation, by tool call id. Failed calls aren't versions. */
export function artifactViews(messages: SushUIMessage[]): Map<string, ArtifactView> {
  const history = new Map<string, Version[]>();
  const views = new Map<string, ArtifactView>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "dynamic-tool" || p.toolName !== ARTIFACT_WRITE || p.state === "output-error") continue;
      // Streaming input is parsed as it arrives, so any field may still be missing.
      const input = (p.input ?? {}) as ArtifactInput;
      const key = typeof input.id === "string" && input.id ? input.id : p.toolCallId;
      const versions = history.get(key) ?? [];
      const n = versions.length + 1;
      versions.push({
        label: `v${n}`,
        note: (typeof input.note === "string" && input.note) || (n === 1 ? "Created" : "Revised"),
        code: typeof input.content === "string" ? input.content : "",
      });
      history.set(key, versions);
      views.set(p.toolCallId, {
        filename: (typeof input.filename === "string" && input.filename) || "Untitled",
        versions: versions.slice(),
      });
    }
  }
  return views;
}
