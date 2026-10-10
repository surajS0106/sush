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
//   <connector>__*  sent to an MCP connector, after the user approves

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
import { api, type ToolSpec } from "@/lib/tauri";

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

/** Model-facing tool names: `<connector>__<tool>`, within the 64-char limit providers enforce. */
function toolName(connector: Connector, tool: string) {
  const slug = connector.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "connector";
  return `${slug}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export interface ConnectorTool {
  name: string;
  connector: Connector;
  tool: string;
  spec: ToolSpec;
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

  const tools: ToolSpec[] = [
    ...(askUser ? [askUserTool] : []),
    ...(skills ? [skillTool] : []),
    skillSaveTool,
    ...(prefs.memory ? memoryTools : []),
    ...(prefs.referenceChats ? chatTools : []),
    ...connectorTools().map((t) => t.spec),
  ];

  return { system: sections.length > 0 ? sections.join("\n\n---\n\n") : undefined, tools, research };
}

// --- running tools --------------------------------------------------------------

export type ToolResult = { output: unknown } | { errorText: string };

export type ToolKind = "ask-user" | "memory" | "chats" | "skill" | "skill-save" | "connector" | "unknown";

export function toolKind(name: string): ToolKind {
  if (name === ASK_USER) return "ask-user";
  if (name === MEMORY_WRITE || name === MEMORY_DELETE || name === MEMORY_SAVE) return "memory";
  if (name === CHATS_SEARCH || name === CHAT_READ) return "chats";
  if (name === SKILL) return "skill";
  if (name === SKILL_SAVE) return "skill-save";
  if (findConnectorTool(name)) return "connector";
  return "unknown";
}

/** Whether a call can run without the user approving it first. */
export function runsWithoutApproval(name: string): boolean {
  const kind = toolKind(name);
  if (kind === "memory" || kind === "chats" || kind === "skill") return true;
  if (kind !== "connector") return false;
  const t = findConnectorTool(name)!;
  return isToolAllowed(t.connector.id, t.tool);
}

/** Run a memory, chats, skill or connector tool. Never throws; failures become error results the model can read. */
export async function runTool(name: string, input: unknown): Promise<ToolResult> {
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
    const t = findConnectorTool(name);
    if (t) {
      const out = await api.connectorCall(t.connector.id, t.tool, input ?? {});
      return out.isError ? { errorText: out.text || "The tool reported an error." } : { output: out.text };
    }
    return { errorText: `Unknown tool ${name}. It may belong to a connector that was turned off.` };
  } catch (e) {
    return { errorText: e instanceof Error ? e.message : String(e) };
  }
}
