// Word files in a chat: an attached .docx and the versions the model makes of it with
// `docx_edit`. Like decks, versions are read back from the conversation: the attachment is
// version 1 and every successful `docx_edit` call on the same file name adds one, its bytes
// stored as a blob (`cardOnly.url`, kept from the model). The open file shows in a side panel
// beside the chat (components/file-panel.tsx), rendered as pages.
//
// Rust edits the file (`docx_edit` → `sush_core::office::edit`): replaced text keeps its
// formatting and new paragraphs copy an existing one's, so the user gets their own document
// back, not a reformatted copy.

import { useSyncExternalStore } from "react";

// Only called, never read at load, so these modules importing each other is fine.
import { closeDoc } from "@/lib/docs";
import { closeDeck } from "@/lib/slides";
import { createStore } from "@/lib/store";
import { api, errorMessage, type ToolSpec } from "@/lib/tauri";
import { isPhone } from "@/lib/utils";
import type { SushUIMessage } from "@/lib/transport";

export const DOCX_EDIT = "docx_edit";

const WORD_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml",
  "application/vnd.ms-word.document.macroenabled",
  "application/vnd.ms-word.template.macroenabled",
];

/** A Word document (.docx and its kin), by media type or, since Windows often reports none, by name. */
export function isWordFile(mediaType: string, filename?: string): boolean {
  const type = mediaType.toLowerCase();
  if (WORD_TYPES.some((t) => type.startsWith(t))) return true;
  return /\.(docx|docm|dotx|dotm)$/i.test(filename ?? "");
}

export const docxEditTool: ToolSpec = {
  name: DOCX_EDIT,
  description:
    "Edit a Word document the user attached, in the file itself, keeping its formatting (fonts, bullets, " +
    "tab-aligned dates, bold labels); the user sees the new version beside the chat and can download it. " +
    "Use it whenever the user wants changes to an attached .docx (a resume, a letter, a report), instead of " +
    "rewriting it as a doc or in a message. Each call makes one new version from the latest one, so put all " +
    "of a turn's changes in one call. Match text exactly as the attachment (or your last docx_edit result) " +
    "shows it, without the Markdown it adds (`## `, `- `, `|`). Kinds of edit:\n" +
    "- replace: text within one paragraph, unique in the document, and `with` its new text; the new text takes " +
    "the formatting of the text it replaces, so replace just the words that change.\n" +
    "- insert_after / insert_before: a paragraph (its text, or enough to match one paragraph) and the new " +
    "`paragraphs`. Each new paragraph is formatted like the anchor, or like the paragraph named in its `like` " +
    "(copy a heading, a company line, a bullet). Separate parts with a tab (\\t) to copy a line whose parts are " +
    "formatted differently, like \"Role\\tJan 2024 – Present\". Mark bold words with **double asterisks**.\n" +
    "- delete: a paragraph to remove.\n" +
    "Example, a new job above an existing one: {insert_before: \"Synergech Technologies, Chennai, India\", " +
    "paragraphs: [{text: \"CRC, Chennai, India\", like: \"Synergech Technologies, Chennai, India\"}, " +
    "{text: \"Cloud Engineer\\tJan 2026 – Present\", like: \"Software Engineer\"}, " +
    "{text: \"Built **ProvisionX**, …\", like: \"Led a cross-functional team\"}]}.",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "The attachment's file name, e.g. 'Resume.docx'" },
      note: { type: "string", description: "What this version changes, in a few words, e.g. 'Added CRC ProvisionX work'" },
      edits: {
        type: "array",
        description: "Applied in order; if one can't be applied, none are",
        items: {
          type: "object",
          properties: {
            replace: { type: "string", description: "Exact text to replace, within one paragraph" },
            with: { type: "string", description: "Its replacement (empty to remove it)" },
            insert_after: { type: "string", description: "The paragraph to add `paragraphs` after" },
            insert_before: { type: "string", description: "The paragraph to add `paragraphs` before" },
            paragraphs: {
              type: "array",
              description: "New paragraphs: text, or {text, like} to copy another paragraph's formatting",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      like: { type: "string", description: "A paragraph whose formatting to copy" },
                    },
                    required: ["text"],
                  },
                ],
              },
            },
            delete: { type: "string", description: "A paragraph to remove" },
          },
        },
      },
    },
    required: ["file", "edits"],
  },
};

// --- versions in a chat ---------------------------------------------------------------

export interface FileVersion {
  /** The file's name, as attached. */
  name: string;
  /** 1 for the attachment, then one more per edit. */
  number: number;
  /** Where its bytes are: a `data:` URL for an attachment, a blob URL for an edit. */
  url: string;
  note: string;
  /** The `docx_edit` call that made it. */
  callId?: string;
  messageId: string;
}

export interface FileVersions {
  /** Each file's versions, oldest first, by lowercased name. */
  byName: Map<string, FileVersion[]>;
  byCall: Map<string, FileVersion>;
  /** Attachments, by `<message id>:<part index>`. */
  byPart: Map<string, FileVersion>;
}

export const fileKey = (name: string) => name.trim().toLowerCase();

interface DocxEditOutput {
  file?: string;
  version?: number;
  note?: string;
  cardOnly?: { url?: string };
}

/** Every Word file in a thread and its versions. */
export function fileVersions(messages: SushUIMessage[]): FileVersions {
  const byName = new Map<string, FileVersion[]>();
  const byCall = new Map<string, FileVersion>();
  const byPart = new Map<string, FileVersion>();
  const add = (v: Omit<FileVersion, "number">) => {
    const list = byName.get(fileKey(v.name)) ?? [];
    const version = { ...v, number: list.length + 1 };
    list.push(version);
    byName.set(fileKey(v.name), list);
    return version;
  };
  for (const m of messages) {
    m.parts.forEach((p, i) => {
      if (p.type === "file" && m.role === "user" && isWordFile(p.mediaType, p.filename)) {
        const name = p.filename ?? "Document.docx";
        const again = byName.has(fileKey(name));
        byPart.set(`${m.id}:${i}`, add({ name, url: p.url, note: again ? "Attached again" : "Original", messageId: m.id }));
      } else if (p.type === "dynamic-tool" && p.toolName === DOCX_EDIT && p.state === "output-available") {
        const out = (p.output ?? {}) as DocxEditOutput;
        const url = out.cardOnly?.url;
        if (!url || !out.file) return;
        byCall.set(p.toolCallId, add({ name: out.file, url, note: out.note || "Edited", callId: p.toolCallId, messageId: m.id }));
      }
    });
  }
  return { byName, byCall, byPart };
}

// --- the open file --------------------------------------------------------------------

export interface FilePanelState {
  /** `fileKey` of the file shown. */
  key: string;
  /** The version shown, or null to follow the newest. */
  version: number | null;
  /** The panel covers the chat. */
  expanded: boolean;
}

/** The file shown beside each thread, by thread id. Not persisted: a reload starts with the panel closed. */
const panels = createStore<ReadonlyMap<string, FilePanelState>>("sush.file-panels", new Map(), false);

export const useFilePanel = (threadId: string) => useSyncExternalStore(panels.subscribe, () => panels.get().get(threadId) ?? null);

function setPanel(threadId: string, state: FilePanelState | null) {
  panels.set((prev) => {
    const next = new Map(prev);
    if (state) next.set(threadId, state);
    else next.delete(threadId);
    return next;
  });
}

/** Show a file beside the chat, in place of an open doc or deck. */
export function openFile(threadId: string, name: string, version: number | null = null) {
  closeDoc(threadId);
  closeDeck(threadId);
  setPanel(threadId, { key: fileKey(name), version, expanded: panels.get().get(threadId)?.expanded ?? false });
}
export const closeFile = (threadId: string) => setPanel(threadId, null);
export function setFileVersion(threadId: string, version: number | null) {
  const cur = panels.get().get(threadId);
  if (cur) setPanel(threadId, { ...cur, version });
}
export function setFileExpanded(threadId: string, expanded: boolean) {
  const cur = panels.get().get(threadId);
  if (cur) setPanel(threadId, { ...cur, expanded });
}

/** `docx_edit` calls seen running, and those the panel already opened for (so closing it keeps it closed). */
const seenRunning = new Set<string>();
const autoOpened = new Set<string>();

/** Opens the panel on a new version when a call seen running finishes; chats opened later don't pop it open. */
export function autoOpenFile(threadId: string, callId: string, finished: boolean, version?: FileVersion) {
  if (!finished) {
    seenRunning.add(callId);
    return;
  }
  if (!version || !seenRunning.has(callId) || autoOpened.has(callId)) return;
  autoOpened.add(callId);
  // On a phone it would cover the chat; the card opens it.
  if (!isPhone()) openFile(threadId, version.name);
}

// --- bytes ----------------------------------------------------------------------------

/** A version's bytes: attachments are inline `data:` URLs, edits stored blobs. */
export async function fileBytes(url: string): Promise<Uint8Array> {
  const dataUrl = url.startsWith("data:") ? url : await api.blobDataUrl(url);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Save a version where the user picks. Edited versions get " (v2)" before the extension. */
export async function downloadFile(v: FileVersion) {
  const dataUrl = v.url.startsWith("data:") ? v.url : await api.blobDataUrl(v.url);
  const name = v.number === 1 ? v.name : v.name.replace(/(\.[^.]+)?$/, (ext) => ` (v${v.number})${ext}`);
  return api.saveBytesFileAs(name, dataUrl.slice(dataUrl.indexOf(",") + 1));
}

// --- running the tool -----------------------------------------------------------------

const MAX_TEXT = 30_000;

/** `docx_edit`: edits the newest version of the named file into a new one. */
export async function runDocxEdit(input: unknown, threadId?: string): Promise<{ output: unknown } | { errorText: string }> {
  const args = (input ?? {}) as Record<string, unknown>;
  if (!threadId) return { errorText: "docx_edit only works in a chat." };
  if (!Array.isArray(args.edits) || args.edits.length === 0) return { errorText: "docx_edit needs `edits`, a list of changes." };
  // Loaded here: sessions imports agent, which imports this module.
  const { threadMessages } = await import("@/lib/sessions");
  let files = fileVersions(threadMessages(threadId)).byName;
  // A sub-agent's thread (`<parent>:<call id>`) edits the files attached to its parent chat.
  if (files.size === 0 && threadId.includes(":")) files = fileVersions(threadMessages(threadId.split(":")[0])).byName;
  if (files.size === 0) return { errorText: "There's no Word file in this chat. Ask the user to attach the .docx." };
  const wanted = typeof args.file === "string" ? fileKey(args.file) : "";
  const list =
    files.get(wanted) ??
    [...files.values()].find((l) => fileKey(l[0].name).endsWith(wanted) && wanted !== "") ??
    (files.size === 1 ? [...files.values()][0] : undefined);
  if (!list) {
    const names = [...files.values()].map((l) => l[0].name).join(", ");
    return { errorText: `No Word file named "${args.file ?? ""}" in this chat. Files: ${names}.` };
  }
  const latest = list[list.length - 1];
  try {
    const result = await api.docxEdit(latest.url, args.edits);
    const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : "Edited";
    const text = result.text.length > MAX_TEXT ? `${result.text.slice(0, MAX_TEXT)}\n…(cut short)` : result.text;
    return {
      output: {
        file: latest.name,
        version: latest.number + 1,
        note,
        message: `Saved version ${latest.number + 1} of ${latest.name}; the user sees it beside the chat and can download it. Its text now:`,
        text,
        cardOnly: { url: result.url },
      },
    };
  } catch (e) {
    return { errorText: `${errorMessage(e)} Nothing was changed; fix that edit and send them all again.` };
  }
}
