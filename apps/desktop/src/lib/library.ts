// What the user has set up for the model beyond the chat itself: skills,
// design systems, connectors and plugins, plus the `+` menu toggles. Memory lives in memory.ts.
// Persisted in localStorage like conversations (see store.ts).

import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import { assertionFor } from "@/lib/auth";
import { createStore } from "@/lib/store";
import { MEETING_RECIPES, YAMMER_CONNECTOR_ID } from "@/lib/yammer";
import {
  api,
  errorMessage,
  type DeviceCode,
  type McpTool,
  type Plugin,
  type ServerCommand,
  type ServerSpec,
} from "@/lib/tauri";

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  /** Set for items a plugin provides; those are edited by reloading the plugin. */
  pluginId?: string;
}

export interface DesignSystem {
  id: string;
  name: string;
  description: string;
  guidelines: string;
  pluginId?: string;
}

export interface Connector {
  id: string;
  name: string;
  server: ServerSpec;
  enabled: boolean;
  pluginId?: string;
  /** Set when added from Discover; picks the logo and description (connector-catalog.ts). */
  catalogId?: string;
}

export interface InstalledPlugin {
  id: string;
  dir: string;
  name: string;
  version?: string | null;
  description?: string | null;
  enabled: boolean;
}

/** Manual asks before each connector tool; Auto runs them and asks only when one looks unsafe. */
export type PermissionMode = "manual" | "auto";

export interface Prefs {
  /** Generate memory from chats: memory goes in the prompt and the model can edit it. */
  memory: boolean;
  /** Let the model search and read past chats. */
  referenceChats: boolean;
  /** Allow sensitive topics (health, beliefs, ...) in memory. */
  memorySensitive: boolean;
  /** The composer's Research mode: search thoroughly and cite. Needs `webSearch`. */
  research: boolean;
  /** Offer web search and page reading; the model decides when to use them. */
  webSearch: boolean;
  designSystemId: string | null;
  permissionMode: PermissionMode;
  /** The composer's thinking switch; null follows the model. `lib/reasoning.ts` fits it to each model. */
  thinking: boolean | null;
  /** The composer's effort level; null follows the model. */
  reasoningEffort: import("@/lib/tauri").Effort | null;
}

const DEFAULT_PREFS: Prefs = {
  thinking: null,
  reasoningEffort: null,
  memory: true,
  referenceChats: true,
  memorySensitive: false,
  research: false,
  webSearch: true,
  designSystemId: null,
  permissionMode: "manual",
};

const skills = createStore<Skill[]>("sush.skills", []);
const designSystems = createStore<DesignSystem[]>("sush.designSystems", []);
const connectors = createStore<Connector[]>("sush.connectors", []);
// Connectors saved before remote ones existed kept the command at the top level.
connectors.set((all) =>
  all.map((c) => {
    const { command, ...rest } = c as Connector & { command?: ServerCommand };
    return command && !rest.server ? { ...rest, server: { type: "stdio", ...command } } : c;
  }),
);
const plugins = createStore<InstalledPlugin[]>("sush.plugins", []);
const prefs = createStore<Prefs>("sush.prefs", DEFAULT_PREFS);
// Saved prefs predate newer fields; fill them in.
prefs.set((p) => ({ ...DEFAULT_PREFS, ...p }));
/** Set once Sush has added the Yammer connector, so deleting it keeps it gone. */
const yammerAdded = createStore<boolean>("sush.yammerConnectorAdded", false);
/** Connector tools the user said never to ask about again, as `connectorId/tool`. */
const allowedTools = createStore<string[]>("sush.allowedTools", []);

export type ConnectorStatus =
  | { state: "connecting" }
  | { state: "ready"; tools: McpTool[]; serverName?: string | null }
  | { state: "needs-auth"; rejected?: string | null }
  /** Waiting for the user to finish signing in in the browser. */
  | { state: "authorizing"; code?: DeviceCode }
  | { state: "error"; error: string };
const connectorStatus = createStore<Record<string, ConnectorStatus>>("sush.connectorStatus", {}, false);

const use = <T>(s: { subscribe: (l: () => void) => () => void; get: () => T }) =>
  useSyncExternalStore(s.subscribe, s.get);

export const useSkills = () => use(skills);
export const useDesignSystems = () => use(designSystems);
export const useConnectors = () => use(connectors);
export const usePlugins = () => use(plugins);
export const usePrefs = () => use(prefs);
export const useConnectorStatus = () => use(connectorStatus);

/** Snapshots for code outside React (request building, tool execution). */
export const library = {
  skills: () => skills.get(),
  designSystems: () => designSystems.get(),
  connectors: () => connectors.get(),
  plugins: () => plugins.get(),
  prefs: () => prefs.get(),
  connectorStatus: () => connectorStatus.get(),
  allowedTools: () => allowedTools.get(),
};

/** Items whose plugin is switched off behave as if absent. */
function fromLivePlugin(item: { pluginId?: string }) {
  return !item.pluginId || plugins.get().some((p) => p.id === item.pluginId && p.enabled);
}

export const activeSkills = () => skills.get().filter((s) => s.enabled && fromLivePlugin(s));
export const activeConnectors = () => connectors.get().filter((c) => c.enabled && fromLivePlugin(c));
export const availableSkills = () => skills.get().filter(fromLivePlugin);
export const availableConnectors = () => connectors.get().filter(fromLivePlugin);
export const availableDesignSystems = () => designSystems.get().filter(fromLivePlugin);
export function activeDesignSystem(): DesignSystem | null {
  const id = prefs.get().designSystemId;
  return availableDesignSystems().find((d) => d.id === id) ?? null;
}

export const setPrefs = (patch: Partial<Prefs>) => prefs.set((p) => ({ ...p, ...patch }));

// --- skills -----------------------------------------------------------------

export function saveSkill(skill: Omit<Skill, "id"> & { id?: string }): Skill {
  const saved = { ...skill, id: skill.id ?? crypto.randomUUID() };
  skills.set((all) => (all.some((s) => s.id === saved.id) ? all.map((s) => (s.id === saved.id ? saved : s)) : [...all, saved]));
  return saved;
}
export const deleteSkill = (id: string) => skills.set((all) => all.filter((s) => s.id !== id));
export const toggleSkill = (id: string, enabled: boolean) =>
  skills.set((all) => all.map((s) => (s.id === id ? { ...s, enabled } : s)));

// --- design systems ---------------------------------------------------------

export function saveDesignSystem(ds: Omit<DesignSystem, "id"> & { id?: string }): DesignSystem {
  const saved = { ...ds, id: ds.id ?? crypto.randomUUID() };
  designSystems.set((all) =>
    all.some((d) => d.id === saved.id) ? all.map((d) => (d.id === saved.id ? saved : d)) : [...all, saved],
  );
  return saved;
}
export function deleteDesignSystem(id: string) {
  designSystems.set((all) => all.filter((d) => d.id !== id));
  if (prefs.get().designSystemId === id) setPrefs({ designSystemId: null });
}

// --- connectors -------------------------------------------------------------

export function saveConnector(c: Omit<Connector, "id"> & { id?: string }): Connector {
  const saved = { ...c, id: c.id ?? crypto.randomUUID() };
  connectors.set((all) => (all.some((x) => x.id === saved.id) ? all.map((x) => (x.id === saved.id ? saved : x)) : [...all, saved]));
  void syncConnectors();
  return saved;
}
export function deleteConnector(id: string) {
  connectors.set((all) => all.filter((c) => c.id !== id));
  setStatus(id, null);
  void api.connectorCancelAuthorize(id).catch(() => {});
  void api.connectorForget(id).catch(() => {});
  void syncConnectors();
}
export function toggleConnector(id: string, enabled: boolean) {
  connectors.set((all) => all.map((c) => (c.id === id ? { ...c, enabled } : c)));
  void syncConnectors();
}

const setStatus = (id: string, status: ConnectorStatus | null) =>
  connectorStatus.set((all) => {
    const next = { ...all };
    if (status) next[id] = status;
    else delete next[id];
    return next;
  });

/**
 * Yammer, Sush's notetaker, serves its meetings over MCP (`yammer --mcp`, read-only, on this
 * computer). Once Yammer says it can (its `mcp.json`, `yammer.rs`), add a connector for them,
 * once: delete it and it stays deleted. An existing one follows Yammer when it moves.
 */
export async function syncYammerConnector() {
  const found = await api.yammerMcpServer().catch(() => null);
  if (!found) return;
  const server: ServerSpec = { type: "stdio", command: found.command, args: found.args, env: {} };
  const existing = connectors.get().find((c) => c.id === YAMMER_CONNECTOR_ID);
  if (existing) {
    const s = existing.server;
    const moved = s.type !== "stdio" || s.command !== server.command || s.args.join(" ") !== server.args.join(" ");
    if (moved) saveConnector({ ...existing, server });
    return;
  }
  if (yammerAdded.get()) return;
  yammerAdded.set(true);
  saveConnector({ id: YAMMER_CONNECTOR_ID, name: "Yammer", server, enabled: true });
  // Its recipes come with it, as skills (`/meeting-promises`), unless one by that name exists.
  const have = new Set(skills.get().map((s) => s.name.toLowerCase()));
  for (const r of MEETING_RECIPES) if (!have.has(r.name.toLowerCase())) saveSkill({ ...r, enabled: true });
}

/** Start active connectors that aren't running and stop ones that were turned off. */
export async function syncConnectors() {
  const active = activeConnectors();
  for (const id of Object.keys(connectorStatus.get())) {
    if (!active.some((c) => c.id === id)) {
      setStatus(id, null);
      void api.connectorDisconnect(id).catch(() => {});
    }
  }
  await Promise.all(active.map((c) => connect(c)));
}

/** (Re)connect one connector. The Rust side reuses a running client if the server is unchanged. */
export async function connect(c: Connector) {
  const current = connectorStatus.get()[c.id]?.state;
  if (current === "connecting" || current === "authorizing") return;
  setStatus(c.id, { state: "connecting" });
  try {
    const outcome = await api.connectorConnect(c.id, c.server);
    // A sign-in started meanwhile (adding from Discover does both) owns the status now.
    if (connectorStatus.get()[c.id]?.state === "authorizing") return;
    if (activeConnectors().some((x) => x.id === c.id)) setStatus(c.id, outcome);
  } catch (e) {
    if (connectorStatus.get()[c.id]?.state === "authorizing") return;
    setStatus(c.id, { state: "error", error: errorMessage(e) });
  }
}

/** Sign a remote connector in through the browser, then connect it. */
export async function signIn(c: Connector) {
  if (c.server.type !== "http") return;
  setStatus(c.id, { state: "authorizing" });
  try {
    // Signed in to Plinth as this same account? Then Plinth lets Sush in without its pairing prompt.
    const assertion = c.id === "plinth" ? await assertionFor("plinth") : null;
    await api.connectorAuthorize(
      c.id,
      c.server.url,
      c.server.oauthClientId,
      (code) => {
        setStatus(c.id, { state: "authorizing", code });
        // Ready to paste on the page that just opened.
        void navigator.clipboard.writeText(code.userCode).catch(() => {});
      },
      assertion,
    );
  } catch (e) {
    const error = errorMessage(e);
    // Cancelling isn't an error worth showing; go back to "Sign in".
    setStatus(c.id, error === "Sign-in cancelled" ? { state: "needs-auth" } : { state: "error", error });
    return;
  }
  setStatus(c.id, null);
  if (c.enabled) await connect(c);
}

export const cancelSignIn = (id: string) => void api.connectorCancelAuthorize(id).catch(() => {});

/** Forget a remote connector's credentials; it'll ask to sign in again. */
export async function signOut(c: Connector) {
  await api.connectorForget(c.id);
  setStatus(c.id, null);
  if (c.enabled) await connect(c);
}

export const isToolAllowed = (connectorId: string, tool: string) => allowedTools.get().includes(`${connectorId}/${tool}`);
export const allowTool = (connectorId: string, tool: string) =>
  allowedTools.set((all) => [...new Set([...all, `${connectorId}/${tool}`])]);

// --- plugins ----------------------------------------------------------------

/** Install or reload a plugin folder, replacing everything it provided before. */
export async function installPlugin(dir: string): Promise<InstalledPlugin> {
  const p: Plugin = await api.loadPlugin(dir);
  const existing = plugins.get().find((x) => x.dir === p.dir);
  const id = existing?.id ?? crypto.randomUUID();
  const installed: InstalledPlugin = {
    id,
    dir: p.dir,
    name: p.name,
    version: p.version,
    description: p.description,
    enabled: existing?.enabled ?? true,
  };
  plugins.set((all) => (existing ? all.map((x) => (x.id === id ? installed : x)) : [...all, installed]));

  // Keep on/off choices for items that survive a reload.
  const wasEnabled = new Map(skills.get().filter((s) => s.pluginId === id).map((s) => [s.name, s.enabled]));
  skills.set((all) => [
    ...all.filter((s) => s.pluginId !== id),
    ...p.skills.map((s) => ({
      id: `${id}:skill:${s.name}`,
      name: s.name,
      description: s.description ?? "",
      instructions: s.text,
      enabled: wasEnabled.get(s.name) ?? true,
      pluginId: id,
    })),
  ]);
  designSystems.set((all) => [
    ...all.filter((d) => d.pluginId !== id),
    ...p.designSystems.map((d) => ({
      id: `${id}:design:${d.name}`,
      name: d.name,
      description: d.description ?? "",
      guidelines: d.text,
      pluginId: id,
    })),
  ]);
  const connWasEnabled = new Map(connectors.get().filter((c) => c.pluginId === id).map((c) => [c.name, c.enabled]));
  connectors.set((all) => [
    ...all.filter((c) => c.pluginId !== id),
    ...p.connectors.map(({ name, ...command }) => ({
      id: `${id}:connector:${name}`,
      name,
      server: { type: "stdio" as const, ...command },
      enabled: connWasEnabled.get(name) ?? true,
      pluginId: id,
    })),
  ]);
  void syncConnectors();
  return installed;
}

export function togglePlugin(id: string, enabled: boolean) {
  plugins.set((all) => all.map((p) => (p.id === id ? { ...p, enabled } : p)));
  void syncConnectors();
}

export function removePlugin(id: string) {
  plugins.set((all) => all.filter((p) => p.id !== id));
  skills.set((all) => all.filter((s) => s.pluginId !== id));
  designSystems.set((all) => all.filter((d) => d.pluginId !== id));
  connectors.set((all) => all.filter((c) => c.pluginId !== id));
  if (prefs.get().designSystemId?.startsWith(`${id}:`)) setPrefs({ designSystemId: null });
  void syncConnectors();
}

// --- settings dialog ----------------------------------------------------------

export type SettingsSection =
  | "general"
  | "account"
  | "sushi"
  | "providers"
  | "usage"
  | "speech"
  | "images"
  | "maps"
  | "flights"
  | "search"
  | "memory"
  | "sharing"
  | "design"
  | "skills"
  | "connectors"
  | "plugins"
  | "changelog";

export interface SettingsState {
  section: SettingsSection;
}

const settings = createStore<SettingsState | null>("sush.settings", null, false);
export const useSettings = () => use(settings);
/** Connectors have a page of their own in the sidebar now, so asking for them in Settings opens that. */
export const openSettings = (state: SettingsState) =>
  state.section === "connectors" ? openConnectors() : settings.set(state);
export const closeSettings = () => settings.set(null);

// --- page requests -------------------------------------------------------------

/** A sidebar page App should show, asked for from outside the sidebar. `id` tells repeat requests apart. */
const pageRequest = createStore<{ id: string; page: "connectors" } | null>("sush.pageRequest", null, false);
export const usePageRequest = () => use(pageRequest);
export function openConnectors() {
  closeSettings();
  pageRequest.set({ id: crypto.randomUUID(), page: "connectors" });
}

// --- chat requests -------------------------------------------------------------

/** A chat App should open with the composer prefilled. `id` tells repeat requests apart. */
export interface ChatRequest {
  id: string;
  prompt: string;
}

const chatRequest = createStore<ChatRequest | null>("sush.chatRequest", null, false);
export const useChatRequest = () => use(chatRequest);
export const requestChat = (prompt: string) => chatRequest.set({ id: crypto.randomUUID(), prompt });

/** The composer's text for asking about a Yammer meeting: @Yammer loads its tools, the link names the meeting. */
export function askAboutMeetingPrompt(meeting: number, title: string): string {
  const name = title.trim() ? `“${title.trim()}” ` : "";
  return `@Yammer About my meeting ${name}(yammer://meeting/${meeting}): `;
}

/**
 * Act on `sush://` links (`deep_link.rs`): one that started Sush is waiting already, later ones
 * arrive as a `deep-link` event. They only ever prefill the composer; the user sends it.
 * Run in one window (`whenLeader`), so a link opens one chat.
 */
export function startDeepLinks() {
  const take = () =>
    void api.deepLinkTake().then(
      (links) => {
        for (const link of links) {
          if (link.kind === "ask-meeting") requestChat(askAboutMeetingPrompt(link.meeting, link.title));
        }
      },
      () => {},
    );
  take();
  void listen("deep-link", take);
}

/** Skills are made with Sush in chat: open a new one ready for `/create-skill`. */
export function createSkillInChat() {
  closeSettings();
  requestChat("/create-skill ");
}
