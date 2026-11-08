// What's new: the release notes users see in Settings → What's new, and once after an
// update moves them to a newer version. Written for users, newest release first.
// Add to UNRELEASED as features land; the release skill moves it into a release.

import { getVersion } from "@tauri-apps/api/app";
import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

export type ChangeKind = "new" | "improved" | "fixed";

export interface Change {
  kind: ChangeKind;
  text: string;
}

export interface Release {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** One line on what the release is about. */
  summary?: string;
  changes: Change[];
}

/** Landed since the last release; never shown. Becomes the next release's notes. */
export const UNRELEASED: Change[] = [
  { kind: "new", text: "Dictation goes through Yammer, Sush's dictation app: press the mic or Ctrl+D and it types what you say into the message box. Without Yammer, Sush walks you through getting it, or keeps using its own in Settings → Speech." },
  { kind: "new", text: "Web search: models look things up and read pages when a question needs it, citing their sources. Turn it off or add an Ollama key in Settings → Search." },
  { kind: "improved", text: "Claude and GPT models use their provider's own web search." },
  { kind: "improved", text: "Specialised tools load only when a model needs them, so replies start faster and cost less." },
  { kind: "new", text: "What's new: see what changed in each release, here and after every update." },
];

export const CHANGELOG: Release[] = [
  {
    version: "2.4.0",
    date: "2026-11-06",
    summary: "Updates in the app, and cards for maps, flights, weather and food.",
    changes: [
      { kind: "new", text: "Upgrade now: when a new version is out, a button in the sidebar installs it and restarts Sush." },
      { kind: "new", text: "Maps: routes and places on a Google Map, with live details when you add your own key in Settings → Maps." },
      { kind: "new", text: "Flights: search fares, watch the route on a globe, check the weather where you land and set price alerts." },
      { kind: "new", text: "Weather: the weather now as a pixel-art scene, with the next 24 hours and 7 days." },
      { kind: "new", text: "Swiggy Food and Instamart connectors. Every order is confirmed on a card first, and only you can approve it." },
      { kind: "new", text: "Topic lookups: photos and cited articles about a person, place or thing." },
      { kind: "improved", text: "GPT-5.6 and GPT-6 can reason and use tools in the same reply." },
      { kind: "improved", text: "The pull request card follows GitHub's checks, and you can continue or abort a stopped rebase." },
      { kind: "fixed", text: "Deleting a merged branch removes your local copy too." },
      { kind: "fixed", text: "Landing with a rebase on an older git now says it needs git 2.40, instead of showing a raw error." },
    ],
  },
  {
    version: "2.3.0",
    date: "2026-11-01",
    summary: "Shared sessions grow a room of their own, and Cowork can run on your machine.",
    changes: [
      { kind: "new", text: "A room in every shared session: everyone can chat alongside the work, without it reaching the model." },
      { kind: "new", text: "Guests can follow the host's git graph and built-in browser, and rejoin sessions from their history." },
      { kind: "new", text: "Let others on your Wi-Fi join: the installed app can be the relay. Turn it on in Settings → Sharing." },
      { kind: "new", text: "Cowork can run commands on your machine instead of the sandbox, so servers can listen and installs reach the network." },
      { kind: "new", text: "Connected apps in Settings → Account, for apps you sign in to with your Sush account." },
      { kind: "improved", text: "On macOS and Linux, Sush picks up your shell's PATH, so commands find bun, Homebrew and nvm." },
    ],
  },
  {
    version: "2.2.0",
    date: "2026-10-26",
    summary: "Sush Multiplayer, sub-agents and the git graph.",
    changes: [
      { kind: "new", text: "Share a live session: others watch, suggest messages, or take control. End-to-end encrypted, and viewable in a browser." },
      { kind: "new", text: "Sub-agents: Sush can hand tasks to agents that work in parallel, shown as a graph you can open." },
      { kind: "new", text: "A git graph beside your files, and a branch card with conflicts, commits and merges." },
      { kind: "new", text: "Sushi can take a dizzy fall, with sound effects. Turn it off in Settings → Sushi." },
    ],
  },
  {
    version: "2.1.1",
    date: "2026-10-19",
    changes: [{ kind: "fixed", text: "The Windows installer builds again." }],
  },
  {
    version: "2.1.0",
    date: "2026-10-19",
    summary: "Steer replies, review your code, and generate images.",
    changes: [
      { kind: "new", text: "Steer a reply while it runs, \"Send now\" to cut in, and pause and resume replies." },
      { kind: "new", text: "Security reviews, code reviews and wikis of a workspace." },
      { kind: "new", text: "Generate images in chat with the model you pick in Settings → Images." },
      { kind: "new", text: "A Databricks connector." },
      { kind: "new", text: "Zoom the whole app in and out." },
      { kind: "improved", text: "Usage shows what you've spent, and the macOS icon follows light and dark mode." },
      { kind: "improved", text: "Sush is open source under the MIT license, and each install generates its own sign-in secret." },
    ],
  },
  {
    version: "2.0.0",
    date: "2026-10-12",
    summary: "Cowork: Sush works in your folders.",
    changes: [
      { kind: "new", text: "Cowork: give Sush a folder and it reads, edits and runs commands there, in a sandbox." },
      { kind: "new", text: "A built-in browser, git worktrees, and the files each turn changed, with undo." },
      { kind: "new", text: "A side panel with your files, an editor and a terminal." },
      { kind: "new", text: "Meet Sushi, the mascot, and pick an avatar for your account." },
      { kind: "new", text: "Accent colors and smooth theme changes." },
      { kind: "improved", text: "Resizable sidebar and panels, and pull requests and commits shown as cards." },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-10-10",
    changes: [
      { kind: "new", text: "Connectors (MCP), local dictation, @-mentions and artifacts." },
    ],
  },
];

/** -1, 0 or 1 by semver order (plain `x.y.z`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The releases up to and including `current` (the notes for a newer one aren't out yet). */
export const releasedUpTo = (current: string | null) =>
  current ? CHANGELOG.filter((r) => compareVersions(r.version, current) <= 0) : CHANGELOG;

// --- this install's version ---------------------------------------------------

let appVersion: string | null = null;
const versionListeners = new Set<() => void>();
const versionReady = getVersion()
  .then((v) => {
    appVersion = v;
    versionListeners.forEach((l) => l());
    return v;
  })
  .catch(() => null);

/** The running app's version, once read. */
export function useAppVersion(): string | null {
  return useSyncExternalStore(
    (l) => {
      versionListeners.add(l);
      return () => versionListeners.delete(l);
    },
    () => appVersion,
  );
}

// --- shown once after an update -------------------------------------------------

/** The newest version whose notes this user has seen (or was installed fresh on). Shared by every window. */
const seen = createStore<string | null>("sush.changelog-seen", null);
/** The releases to show in the What's new dialog, or null when it's closed. */
const pending = createStore<Release[] | null>("sush.changelog-pending", null, false);

export const useWhatsNew = () => useSyncExternalStore(pending.subscribe, pending.get);

/**
 * At launch: after an update, open the notes for each release since the last one seen.
 * A fresh install only records its version. Run from the leader window, once.
 */
export async function checkWhatsNew() {
  const current = await versionReady;
  if (!current) return;
  const last = seen.get();
  if (!last) return seen.set(current);
  if (compareVersions(current, last) <= 0) return;
  const fresh = CHANGELOG.filter((r) => compareVersions(r.version, last) > 0 && compareVersions(r.version, current) <= 0);
  if (fresh.length) pending.set(fresh);
  else seen.set(current);
}

/** Close the dialog; its notes count as seen. */
export function dismissWhatsNew() {
  pending.set(null);
  if (appVersion) seen.set(appVersion);
}
