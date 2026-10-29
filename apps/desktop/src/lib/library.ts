// What the user has set up for the model beyond the chat itself: skills,
// design systems, connectors and plugins, plus the `+` menu toggles. Memory lives in memory.ts.
// Persisted in localStorage like conversations (see store.ts).

import { useSyncExternalStore } from "react";

import { assertionFor } from "@/lib/auth";
import { createStore } from "@/lib/store";
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
  research: boolean;
  designSystemId: string | null;
  permissionMode: PermissionMode;
}

const DEFAULT_PREFS: Prefs = {
  memory: true,
  referenceChats: true,
  memorySensitive: false,
  research: false,
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
  | "memory"
  | "sharing"
  | "design"
  | "skills"
  | "connectors"
  | "plugins";

export interface SettingsState {
  section: SettingsSection;
}

const settings = createStore<SettingsState | null>("sush.settings", null, false);
export const useSettings = () => use(settings);
export const openSettings = (state: SettingsState) => settings.set(state);
export const closeSettings = () => settings.set(null);

// --- chat requests -------------------------------------------------------------

/** A chat App should open with the composer prefilled. `id` tells repeat requests apart. */
export interface ChatRequest {
  id: string;
  prompt: string;
}

const chatRequest = createStore<ChatRequest | null>("sush.chatRequest", null, false);
export const useChatRequest = () => use(chatRequest);
export const requestChat = (prompt: string) => chatRequest.set({ id: crypto.randomUUID(), prompt });

/** Skills are made with Sush in chat: open a new one ready for `/create-skill`. */
export function createSkillInChat() {
  closeSettings();
  requestChat("/create-skill ");
}
