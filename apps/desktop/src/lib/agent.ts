// What each request carries beyond the messages (system prompt, tools,
// research) and how tool calls that come back are run.
//
// Tool kinds:
//   ask_user        answered by the user in the chat (AskUserCard)
//   memory_*        run immediately against local memory (memory.ts)
//   chats_search,
//   chat_read       run immediately against saved chats
//   skill           runs immediately: returns a skill's instructions (skills.ts)
//   skill_save      saves a skill, after the user approves
//   artifact_write  runs immediately: the chat shows it as a versioned artifact (artifacts.ts)
//   <connector>__*  sent to an MCP connector, after the user approves

import { useSyncExternalStore } from "react";

import { ARTIFACT_WRITE, artifactTool, validateArtifact } from "@/lib/artifacts";
import { ASK_USER, askUserTool } from "@/lib/ask-user";
import { activeConnectors, activeDesignSystem, isToolAllowed, library, type Connector } from "@/lib/library";
import {
  deleteMemory,
  getMemoryFiles,
  normalizePath,
  ORGANISATION,
  readChat,
  renderMemory,
  searchChats,
  SENSITIVE_OFF,
  SENSITIVE_ON,
  writeMemory,
} from "@/lib/memory";
import { loadSkill, SKILL, SKILL_SAVE, skillSaveTool, skillsPrompt, skillTool } from "@/lib/skills";
import { createStore } from "@/lib/store";
import { api, type McpTool, type ToolSpec } from "@/lib/tauri";

export const MEMORY_WRITE = "memory_write";
export const MEMORY_DELETE = "memory_delete";
/** Pre-files memory tool; still recognised so old chats render. */
export const MEMORY_SAVE = "memory_save";
export const CHATS_SEARCH = "chats_search";
export const CHAT_READ = "chat_read";

const memoryTools: ToolSpec[] = [
  {
    name: MEMORY_WRITE,
    description:
      "Create or replace a memory file. This rewrites the whole file, so include everything it should keep, " +
      "merged with what you learned. Use it when you learn something durable about the user or their work, " +
      "or when a saved fact turns out to be wrong.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "profile, topics/<slug> or areas/<slug>, e.g. topics/communication" },
        title: { type: "string", description: "Short name, e.g. 'Communication'" },
        description: { type: "string", description: "One line on what the file covers" },
        content: { type: "string", description: "The full markdown content of the file" },
      },
      required: ["path", "title", "description", "content"],
    },
  },
  {
    name: MEMORY_DELETE,
    description: "Delete a memory file that is obsolete, by its path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const chatTools: ToolSpec[] = [
  {
    name: CHATS_SEARCH,
    description:
      "Search the user's past chats with you by keyword. Use it when the user refers to an earlier conversation " +
      "or when details from past work would help. Returns matching chats with ids and snippets.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords; every word must appear in the chat" } },
      required: ["query"],
    },
  },
  {
    name: CHAT_READ,
    description: "Read the transcript of a past chat by the id chats_search returned.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

// --- connectors ---------------------------------------------------------------

/** What every model-facing tool name of a connector starts with, e.g. `github__`. */
export function connectorToolPrefix(connector: Connector) {
  return `${connector.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "connector"}__`;
}

/** Model-facing tool names: `<connector>__<tool>`, within the 64-char limit providers enforce. */
function toolName(connector: Connector, tool: string) {
  return `${connectorToolPrefix(connector)}${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export interface ConnectorTool {
  name: string;
  connector: Connector;
  tool: string;
  spec: ToolSpec;
  annotations?: McpTool["annotations"];
}

/** Tools of every active connector that's connected. */
export function connectorTools(): ConnectorTool[] {
  const status = library.connectorStatus();
  return activeConnectors().flatMap((connector) => {
    const s = status[connector.id];
    if (s?.state !== "ready") return [];
    return s.tools.map((t) => {
      const name = toolName(connector, t.name);
      return {
        name,
        connector,
        tool: t.name,
        annotations: t.annotations,
        spec: {
          name,
          description: `[${connector.name}] ${t.description ?? t.name}`,
          inputSchema: t.inputSchema ?? { type: "object" },
        },
      };
    });
  });
}

export const findConnectorTool = (name: string) => connectorTools().find((t) => t.name === name);

// --- request context ----------------------------------------------------------

export interface RequestContext {
  system?: string;
  tools: ToolSpec[];
  research: boolean;
}

export function buildContext({ askUser, research }: { askUser: boolean; research: boolean }): RequestContext {
  const prefs = library.prefs();
  const sections: string[] = [];

  const skills = skillsPrompt();
  if (skills) sections.push(skills);

  const design = activeDesignSystem();
  if (design) {
    sections.push(
      `When you produce UI, front-end code, or visual designs, follow the "${design.name}" design system:\n\n` +
        `<design_system>\n${design.guidelines}\n</design_system>`,
    );
  }

  if (prefs.memory) {
    sections.push(
      "You have a long-term memory about this user, shared across conversations and stored on their device. " +
        "Use it to personalise answers without mentioning it unless it's relevant. Keep it current with " +
        "memory_write and memory_delete as you learn things worth remembering; don't save one-off details.\n\n" +
        `${ORGANISATION}\n\n${prefs.memorySensitive ? SENSITIVE_ON : SENSITIVE_OFF}\n\n${renderMemory()}`,
    );
  }

  if (prefs.referenceChats) {
    sections.push(
      "You can look up the user's past chats with chats_search and chat_read. Do so when they refer to an " +
        "earlier conversation or when past context would clearly help; don't search on every message.",
    );
  }

  const connectors = connectorTools();
  if (connectors.length > 0) {
    sections.push(
      "Pull requests and commits returned by connector tools are shown to the user as cards right under " +
        "the tool call, with their title, message, author, sha, branches and diff stats. Don't repeat those " +
        "details in tables or lists; answer the question or add what the card doesn't show.",
    );
  }

  const tools: ToolSpec[] = [
    ...(askUser ? [askUserTool] : []),
    ...(skills ? [skillTool] : []),
    skillSaveTool,
    artifactTool,
    ...(prefs.memory ? memoryTools : []),
    ...(prefs.referenceChats ? chatTools : []),
    ...connectors.map((t) => t.spec),
  ];

  return { system: sections.length > 0 ? sections.join("\n\n---\n\n") : undefined, tools, research };
}

// --- running tools --------------------------------------------------------------

export type ToolResult = { output: unknown } | { errorText: string };

export type ToolKind = "ask-user" | "memory" | "chats" | "skill" | "skill-save" | "artifact" | "connector" | "unknown";

export function toolKind(name: string): ToolKind {
  if (name === ASK_USER) return "ask-user";
  if (name === MEMORY_WRITE || name === MEMORY_DELETE || name === MEMORY_SAVE) return "memory";
  if (name === CHATS_SEARCH || name === CHAT_READ) return "chats";
  if (name === SKILL) return "skill";
  if (name === SKILL_SAVE) return "skill-save";
  if (name === ARTIFACT_WRITE) return "artifact";
  if (findConnectorTool(name)) return "connector";
  return "unknown";
}

// Verbs of tools that delete, overwrite, or act for the user outside the app.
const RISKY = /(^|_|-)(delete|remove|destroy|drop|purge|erase|wipe|revoke|reset|force|overwrite|merge|transfer|pay|charge|refund|send|publish|post|invite|archive|close|cancel|ban|kick)(?=$|[_-])/i;

/**
 * Whether Auto mode should still ask: the server says the tool is destructive, or it
 * doesn't say it's harmless and its name sounds risky.
 */
export function looksUnsafe(t: ConnectorTool): boolean {
  const a = t.annotations ?? {};
  if (a.readOnlyHint === true) return false;
  if (a.destructiveHint === true) return true;
  return RISKY.test(t.tool);
}

/** Whether a call can run without the user approving it first. */
export function runsWithoutApproval(name: string): boolean {
  const kind = toolKind(name);
  if (kind === "memory" || kind === "chats" || kind === "skill" || kind === "artifact") return true;
  if (kind !== "connector") return false;
  const t = findConnectorTool(name)!;
  if (isToolAllowed(t.connector.id, t.tool)) return true;
  return library.prefs().permissionMode === "auto" && !looksUnsafe(t);
}

export const STOPPED = "Stopped by the user.";

/** Connector calls in flight, by tool call id, so Stop can cancel them. */
const runningCalls = createStore<ReadonlySet<string>>("sush.running-tool-calls", new Set(), false);
export const useRunningToolCalls = () => useSyncExternalStore(runningCalls.subscribe, runningCalls.get);

/** Stop connector calls in flight; each one's `runTool` then resolves with `STOPPED`. */
export function cancelToolCalls(ids: Iterable<string>) {
  for (const id of ids) if (runningCalls.get().has(id)) void api.connectorCancelCall(id);
}

/** Run a memory, chats, skill, artifact or connector tool. Never throws; failures become error results the model can read. */
export async function runTool(name: string, input: unknown, callId: string): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    if (name === MEMORY_WRITE) {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        return { errorText: "memory_write needs `path` and `content`." };
      }
      const f = writeMemory({
        path: args.path,
        title: typeof args.title === "string" ? args.title : undefined,
        description: typeof args.description === "string" ? args.description : undefined,
        content: args.content,
      });
      return { output: `Saved ${f.path}.` };
    }
    if (name === MEMORY_DELETE) {
      const path = normalizePath(String(args.path ?? ""));
      if (!path || !deleteMemory(path)) {
        return { errorText: `No memory file at ${args.path}. Files: ${getMemoryFiles().map((f) => f.path).join(", ") || "none"}.` };
      }
      return { output: `Deleted ${path}.` };
    }
    if (name === MEMORY_SAVE) return { errorText: "memory_save was replaced by memory_write." };
    if (name === CHATS_SEARCH) {
      const hits = searchChats(String(args.query ?? ""));
      return { output: hits.length > 0 ? JSON.stringify(hits, null, 1) : "No chats matched. Try fewer or different words." };
    }
    if (name === CHAT_READ) {
      const chat = readChat(String(args.id ?? ""));
      if (!chat) return { errorText: `No chat with id ${args.id}.` };
      return { output: `# ${chat.title}\n\n${chat.transcript}` };
    }
    if (name === SKILL) return loadSkill(String(args.name ?? ""));
    if (name === ARTIFACT_WRITE) {
      const invalid = validateArtifact(args);
      return invalid ? { errorText: invalid } : { output: `Showed ${args.filename} to the user as an artifact.` };
    }
    const t = findConnectorTool(name);
    if (t) {
      runningCalls.set((prev) => new Set(prev).add(callId));
      const out = await api.connectorCall(t.connector.id, t.tool, input ?? {}, callId).finally(() =>
        runningCalls.set((prev) => {
          const next = new Set(prev);
          next.delete(callId);
          return next;
        }),
      );
      return out.isError ? { errorText: out.text || "The tool reported an error." } : { output: out.text };
    }
    return { errorText: `Unknown tool ${name}. It may belong to a connector that was turned off.` };
  } catch (e) {
    return { errorText: e instanceof Error ? e.message : String(e) };
  }
}
