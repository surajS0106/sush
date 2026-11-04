// What each request carries beyond the messages (system prompt, tools,
// research), which tools need the user's approval, and how the tools the UI
// owns are run. The loop itself runs in Rust (`sush_core::agent`): it calls
// connector tools directly and asks the UI (`sessions.ts`) to run the rest.
//
// Tool kinds:
//   ask_user        answered by the user in the chat (AskUserCard)
//   memory_*        run immediately against local memory (memory.ts)
//   chats_search,
//   chat_read       run immediately against saved chats
//   skill           runs immediately: returns a skill's instructions (skills.ts)
//   skill_save      saves a skill, after the user approves
//   automation_save saves an automation, after the user approves (automations.ts)
//   artifact_write  runs immediately: the chat shows it as a versioned artifact (artifacts.ts)
//   slides_write    runs immediately: the deck opens in the slides panel (slides.ts)
//   image_generate  runs immediately with the image model from Settings → Images (images.ts)
//   map_show        runs immediately: the chat shows a Google Map of a route or place (maps.ts)
//   flights_search  runs immediately: the chat shows a flight card to book from (flights.ts)
//   weather_show    runs immediately: the chat shows a pixel-art weather card (weather.ts)
//   location_get    reads the device's position, after the user agrees in its card (location.ts)
//   spawn_agent     offered and run by Rust: a sub-agent on a thread of its own (components/subagents.tsx)
//   <connector>__*  sent to an MCP connector, after the user approves

import { useSyncExternalStore } from "react";

import { ARTIFACT_WRITE, artifactTool, validateArtifact } from "@/lib/artifacts";
import { ASK_USER, askUserTool } from "@/lib/ask-user";
import { AUTOMATION_SAVE, automationSaveTool } from "@/lib/automation-save";
import { placesOrder } from "@/lib/connector-catalog";
import { ORDER_TOOL, swiggyService } from "@/lib/swiggy";
import { FLIGHTS_SEARCH, flightsTool, runFlightsSearch } from "@/lib/flights";
import { IMAGE_GENERATE, imagesEnabled, IMAGES_OFF, imageTool, runImageGenerate } from "@/lib/images";
import { activeConnectors, activeDesignSystem, isToolAllowed, library, type Connector } from "@/lib/library";
import { LOCATION_GET, locationTool } from "@/lib/location";
import { MAP_SHOW, mapTool, runMapShow } from "@/lib/maps";
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
import { SLIDES_WRITE, slidesTool, validateSlides } from "@/lib/slides";
import { createStore } from "@/lib/store";
import type { McpTool, RunTool, ToolSpec } from "@/lib/tauri";
import { runWeatherShow, WEATHER_SHOW, weatherTool } from "@/lib/weather";

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
  /** The `ui://` page the server offers for this tool's results. */
  widget?: string;
}

/** What the model should know about a tool that changes the user's Swiggy cart or spends their money. */
function toolNote(connector: Connector, tool: string) {
  const service = swiggyService(connectorToolPrefix(connector));
  // Results also say this, in place of Swiggy's instructions to draw tables (`instamart_for_model`).
  const shownAsCard = " The app shows the user this result as a card with photos, prices and the bill, so don't repeat any of it in a table or list.";
  if (service === "instamart" && (tool === "search_products" || tool === "your_go_to_items")) {
    return `${shownAsCard} The user can add items from this card without sending a message, and you aren't told. When they say they've picked or selected something, call get_cart and work from that rather than asking them to choose again.`;
  }
  if (service === "instamart" && tool === "get_addresses") {
    return " The app shows the user every address from this result as a card, and picking one sends you its ID in a message. Don't list or recommend the addresses: ask them in one short sentence to pick from the card, then wait. If they've already clearly named one, use its ID and carry on without asking. Once they've picked, don't call this again unless they want to change it.";
  }
  if (service === "instamart" && tool === "clear_cart") {
    return " This empties the cart on the user's Swiggy account. Before saying it's cleared, call get_cart on its own, not alongside this call, and say what it shows. If items are still there, say so plainly and don't guess why.";
  }
  if (service === "instamart" && tool === "get_cart") {
    return `${shownAsCard} Item prices and the bill are only on the card, so point the user there if they ask. The user can also change the cart from the card, so read it again rather than trusting an earlier result.`;
  }
  if (service === "instamart" && tool === "update_cart") {
    return ` This replaces the whole cart on the user's Swiggy account, the same cart they see in the Swiggy app, where changes show after a refresh. It may hold items they added there. The user can also change it from a card without telling you, so always call get_cart first, even if you read it earlier, and send every item to keep along with the new ones. Ask the user before removing anything they didn't ask to remove. This result means Swiggy accepted the change, and the cart can still change afterwards, so say that it was accepted rather than promising it will stay. A later get_cart can show an older cart or lose items. If it does, or the user says something is missing, tell them what it shows, don't add the items again unless they ask, and don't guess why.${shownAsCard}`;
  }
  if (service === "food" && tool === "update_food_cart") {
    return " This is the cart on the user's Swiggy account, so items they added in the Swiggy app are in it too. It holds one restaurant: changing restaurant replaces everything in it. Call get_food_cart first, and if it holds items from another restaurant, ask the user before replacing them. Items added here may not show in the Swiggy app, even after reopening it, though items added in the app do show here. Don't tell the user to look for them in the app. If asked, say this plainly, don't offer other explanations, and don't suggest placing the order as a fix.";
  }
  if (!placesOrder(tool)) return "";
  const retry =
    " This places a real order. The app asks the user to confirm it before it runs. After a server error, check the user's recent orders before trying again, because the order may have gone through.";
  if (!service || tool !== ORDER_TOOL[service]) return retry;
  const upi = `For UPI, this is a desktop app: use scan-QR, don't draw a QR code or repeat the link, tell the user to pay from the card, then poll check_payment_status and call confirm_order. Don't say the order is placed until confirm_order succeeds.`;
  const confirmed = `${retry} The confirmation shows the live cart, address and payment method, so don't ask again once the user has settled on the order. ${upi}`;
  if (service === "food") return confirmed;
  return `${confirmed} Always pass paymentMethod with the method the user chose, or the order can't be confirmed. Never set confirmDuplicate to retry a failed or timed-out checkout, because that can charge the user twice: set it only when a rejection tells you to and the user has said they want another order. A cart across stores becomes one order per store, so report each one's result.`;
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
        widget: t._meta?.ui?.resourceUri ?? t._meta?.["openai/outputTemplate"],
        spec: {
          name,
          description: `[${connector.name}] ${t.description ?? t.name}${toolNote(connector, t.name)}`,
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

export function buildContext({
  askUser,
  research,
  incognito = false,
  project,
}: {
  askUser: boolean;
  research: boolean;
  /** Leave out memory and past chats, both ways: nothing is read from them or written to them. */
  incognito?: boolean;
  /** The project the chat is filed under, for its instructions. */
  project?: { name: string; instructions: string };
}): RequestContext {
  const prefs = library.prefs();
  const memory = prefs.memory && !incognito;
  const referenceChats = prefs.referenceChats && !incognito;
  const sections: string[] = [];

  if (project?.instructions.trim()) {
    sections.push(
      `This chat is part of the user's "${project.name}" project. Follow the project's instructions:\n\n` +
        `<project_instructions>\n${project.instructions.trim()}\n</project_instructions>`,
    );
  }

  const skills = skillsPrompt();
  if (skills) sections.push(skills);

  const design = activeDesignSystem();
  if (design) {
    sections.push(
      `When you produce UI, front-end code, or visual designs, follow the "${design.name}" design system:\n\n` +
        `<design_system>\n${design.guidelines}\n</design_system>`,
    );
  }

  if (memory) {
    sections.push(
      "You have a long-term memory about this user, shared across conversations and stored on their device. " +
        "Use it to personalise answers without mentioning it unless it's relevant. Keep it current with " +
        "memory_write and memory_delete as you learn things worth remembering; don't save one-off details.\n\n" +
        `${ORGANISATION}\n\n${prefs.memorySensitive ? SENSITIVE_ON : SENSITIVE_OFF}\n\n${renderMemory()}`,
    );
  }

  if (referenceChats) {
    sections.push(
      "You can look up the user's past chats with chats_search and chat_read. Do so when they refer to an " +
        "earlier conversation or when past context would clearly help; don't search on every message.",
    );
  }

  const images = imagesEnabled();
  if (!images) sections.push(IMAGES_OFF);

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
    automationSaveTool,
    artifactTool,
    slidesTool,
    ...(images ? [imageTool] : []),
    mapTool,
    flightsTool,
    weatherTool,
    locationTool,
    ...(memory ? memoryTools : []),
    ...(referenceChats ? chatTools : []),
    ...connectors.map((t) => t.spec),
  ];

  return { system: sections.length > 0 ? sections.join("\n\n---\n\n") : undefined, tools, research };
}

// --- running tools --------------------------------------------------------------

export type ToolResult = { output: unknown } | { errorText: string };

export type ToolKind =
  | "ask-user"
  | "memory"
  | "chats"
  | "skill"
  | "skill-save"
  | "automation-save"
  | "artifact"
  | "image"
  | "map"
  | "flights"
  | "weather"
  | "location"
  | "workspace"
  | "browser"
  | "agent"
  | "connector"
  | "unknown";

/** Cowork file and shell tools. Rust offers and runs them (`sush_core::workspace::tools`). */
export const WORKSPACE_TOOLS = new Set([
  "fs_list",
  "fs_glob",
  "fs_read",
  "fs_search",
  "fs_write",
  "fs_edit",
  "fs_move",
  "fs_delete",
  "shell_run",
  "branch_status",
  "git_commit",
  "git_merge",
]);

/** The Cowork tool whose latest call shows as the live pull request card (`components/branch-card.tsx`). */
export const BRANCH_STATUS = "branch_status";

/** Starts a sub-agent. Rust offers and runs it (`sush_core::agent::subagents`). */
export const SPAWN_AGENT = "spawn_agent";

/** Cowork's built-in browser. Rust offers and runs them (`sush_core::browser`). */
export const BROWSER_TOOLS = new Set(["browser_navigate", "browser_read", "browser_click", "browser_type"]);

export function toolKind(name: string): ToolKind {
  if (name === ASK_USER) return "ask-user";
  if (WORKSPACE_TOOLS.has(name)) return "workspace";
  if (BROWSER_TOOLS.has(name)) return "browser";
  if (name === SPAWN_AGENT) return "agent";
  if (name === MEMORY_WRITE || name === MEMORY_DELETE || name === MEMORY_SAVE) return "memory";
  if (name === CHATS_SEARCH || name === CHAT_READ) return "chats";
  if (name === SKILL) return "skill";
  if (name === SKILL_SAVE) return "skill-save";
  if (name === AUTOMATION_SAVE) return "automation-save";
  if (name === ARTIFACT_WRITE || name === SLIDES_WRITE) return "artifact";
  if (name === IMAGE_GENERATE) return "image";
  if (name === MAP_SHOW) return "map";
  if (name === FLIGHTS_SEARCH) return "flights";
  if (name === WEATHER_SHOW) return "weather";
  if (name === LOCATION_GET) return "location";
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
  if (placesOrder(t.tool)) return true;
  const a = t.annotations ?? {};
  if (a.readOnlyHint === true) return false;
  if (a.destructiveHint === true) return true;
  return RISKY.test(t.tool);
}

/** Whether a call can run without the user approving it first. */
export function runsWithoutApproval(name: string): boolean {
  const kind = toolKind(name);
  if (kind === "memory" || kind === "chats" || kind === "skill" || kind === "artifact" || kind === "image" || kind === "map" || kind === "flights" || kind === "weather") return true;
  if (kind !== "connector") return false;
  const t = findConnectorTool(name)!;
  // An old "Always allow" never covers spending money.
  if (placesOrder(t.tool)) return false;
  if (isToolAllowed(t.connector.id, t.tool)) return true;
  return library.prefs().permissionMode === "auto" && !looksUnsafe(t);
}

export const STOPPED = "Stopped by the user.";

/** Connector calls in flight, by tool call id, as the run reports them. */
const runningCalls = createStore<ReadonlySet<string>>("sush.running-tool-calls", new Set(), false);
export const useRunningToolCalls = () => useSyncExternalStore(runningCalls.subscribe, runningCalls.get);

export function setToolRunning(callId: string, running: boolean) {
  runningCalls.set((prev) => {
    const next = new Set(prev);
    if (running) next.add(callId);
    else next.delete(callId);
    return next;
  });
}

/** Tool specs with where each runs and whether it needs the user's approval, for a run's config. */
export function runTools(specs: ToolSpec[]): RunTool[] {
  return specs.map((spec) => {
    const approval = runsWithoutApproval(spec.name) ? "auto" : "ask";
    const t = toolKind(spec.name) === "connector" ? findConnectorTool(spec.name) : undefined;
    return { ...spec, approval, exec: t ? { type: "connector", connectorId: t.connector.id, tool: t.tool } : { type: "client" } };
  });
}

/** Run a memory, chats, skill, artifact, image, map, flights or weather tool. Never throws; failures become error results the model can read. */
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
      const hits = await searchChats(String(args.query ?? ""));
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
    if (name === SLIDES_WRITE) {
      const invalid = validateSlides(args);
      if (invalid) return { errorText: invalid };
      const n = (args.slides as unknown[]).length;
      return { output: `Showed "${args.title}" (${n} ${n === 1 ? "slide" : "slides"}) to the user in the slides panel.` };
    }
    if (name === IMAGE_GENERATE) return runImageGenerate(args);
    if (name === MAP_SHOW) return runMapShow(args);
    if (name === FLIGHTS_SEARCH) return runFlightsSearch(args);
    if (name === WEATHER_SHOW) return runWeatherShow(args);
    return { errorText: `Unknown tool ${name}. It may belong to a connector that was turned off.` };
  } catch (e) {
    return { errorText: e instanceof Error ? e.message : String(e) };
  }
}
