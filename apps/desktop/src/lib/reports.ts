// Security reviews, code reviews and wikis of a Cowork folder ("reports").
// Rust keeps them (`reports.rs`, `sush_core::reports`) and runs each as a
// read-only agent run on a thread of its own, which isn't listed as a session.
// What a run records reaches every window as a `report` frame; changes made
// here (starting, deleting, a wiki's questions) are broadcast to the others.
//
// Fixing a finding is an ordinary Cowork session, so its edits ask, are
// checkpointed and can be undone like any other.

import type { DynamicToolUIPart } from "ai";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { connectorTools, looksUnsafe, runTools } from "@/lib/agent";
import { sendMessage, stop, useSessionStatus, useThread } from "@/lib/sessions";
import { createConversation, createStore, deleteConversation, getConversations, getOrCreateEmptyConversation, getTarget } from "@/lib/store";
import { api, errorMessage, type Finding, type Report, type ReportKind, type ReportScope, type ReportStatus, type RunTool } from "@/lib/tauri";
import { broadcast, onBroadcast } from "@/lib/windows";
import { openFile } from "@/lib/workspaces";

const reports = createStore<Report[]>("sush.reports-cache", [], false);

type Shared = { type: "upsert"; report: Report } | { type: "delete"; id: string };
const REPORTS_EVENT = "sush://reports";

/** Deleted reports. Deleting stops the run, whose last frame may come after the report is gone here. */
const gone = new Set<string>();

function upsert(report: Report) {
  if (gone.has(report.id)) return;
  reports.set((all) => (all.some((r) => r.id === report.id) ? all.map((r) => (r.id === report.id ? report : r)) : [report, ...all]));
}

function remove(id: string) {
  gone.add(id);
  reports.set((all) => all.filter((r) => r.id !== id));
}

onBroadcast<Shared>(REPORTS_EVENT, (change) => (change.type === "delete" ? remove(change.id) : upsert(change.report)));

/** Take a report as Rust returned it, here and in the other windows. */
function share(report: Report) {
  upsert(report);
  void broadcast(REPORTS_EVENT, { type: "upsert", report } satisfies Shared);
}

/** Load the reports. Call before rendering, so their threads stay out of the session list. */
export async function initReports() {
  reports.set(await api.reportsList());
}

/** A run's `report` frame; Rust sends it to every window. */
export const applyReport = upsert;

export const useReports = () => useSyncExternalStore(reports.subscribe, reports.get);

const threadSets = new WeakMap<Report[], ReadonlySet<string>>();

function threadsOf(all: Report[]): ReadonlySet<string> {
  let set = threadSets.get(all);
  if (!set) threadSets.set(all, (set = new Set(all.flatMap((r) => (r.askThreadId ? [r.threadId, r.askThreadId] : [r.threadId])))));
  return set;
}

/** Threads that belong to reports. They aren't sessions the user started, so they aren't listed as such. */
export const isReportThread = (id: string) => threadsOf(reports.get()).has(id);
export const useReportThreads = () => threadsOf(useReports());

export const reportForThread = (id: string) => reports.get().find((r) => r.threadId === id || r.askThreadId === id);

const isGithub = (t: ReturnType<typeof connectorTools>[number]) => /github/i.test(t.connector.name);

/** Whether a GitHub connector is connected, so pull requests can be reviewed. */
export const githubConnected = () => connectorTools().some(isGithub);

/**
 * The UI's tools a report thread's run gets: a pull request's review reads it
 * through the GitHub connector, so its read-only tools. Rust adds the rest
 * and drops anything else.
 */
export function reportRunTools(report: Report, threadId: string): RunTool[] {
  if (report.scope.type !== "pull-request" || report.threadId !== threadId) return [];
  return runTools(connectorTools().filter((t) => isGithub(t) && !looksUnsafe(t)).map((t) => t.spec));
}

// --- running ----------------------------------------------------------------------

/** What each kind is called, in titles and messages. */
export const KIND_LABEL: Record<ReportKind, string> = { security: "Security review", review: "Code review", wiki: "Wiki" };

/** The first message of a run; the instructions are in the system prompt Rust adds. */
const KICKOFF: Record<ReportKind, string> = {
  security: "Run the security review.",
  review: "Review the changes.",
  wiki: "Write the wiki.",
};

const needsModel = () => {
  if (getTarget()) return false;
  toast.error("Pick a model first", { description: "Choose one in a chat, or add a provider in Settings." });
  return true;
};

/** Start a report on a workspace. Returns it, or null if it couldn't start. */
export async function startReport(kind: ReportKind, workspaceId: string, scope: ReportScope): Promise<Report | null> {
  if (needsModel()) return null;
  const convo = createConversation(workspaceId, KIND_LABEL[kind]);
  try {
    const report = await api.reportCreate(workspaceId, kind, scope, convo.id);
    share(report);
    sendMessage(convo.id, KICKOFF[kind], []);
    return report;
  } catch (e) {
    deleteConversation(convo.id);
    toast.error(`Couldn’t start the ${KIND_LABEL[kind].toLowerCase()}`, { description: errorMessage(e) });
    return null;
  }
}

/** Write a wiki again for the code as it is now. Its pages stay until the new run finishes. */
export async function regenerateWiki(report: Report) {
  if (needsModel()) return;
  const convo = createConversation(report.workspaceId, KIND_LABEL.wiki);
  try {
    share(await api.reportRerun(report.id, convo.id));
    deleteConversation(report.threadId);
    sendMessage(convo.id, "Update the wiki for the code as it is now.", []);
  } catch (e) {
    deleteConversation(convo.id);
    toast.error("Couldn’t regenerate the wiki", { description: errorMessage(e) });
  }
}

/** Ask about the codebase from its wiki. Questions go on in one thread until it's cleared. */
export async function askWiki(report: Report, question: string) {
  if (needsModel()) return;
  let threadId = report.askThreadId;
  if (!threadId || !getConversations().some((c) => c.id === threadId)) {
    const convo = createConversation(report.workspaceId, "Wiki questions");
    try {
      share(await api.reportAskThread(report.id, convo.id));
    } catch (e) {
      deleteConversation(convo.id);
      return void toast.error("Couldn’t ask that", { description: errorMessage(e) });
    }
    threadId = convo.id;
  }
  sendMessage(threadId, question, []);
}

/** Start the wiki's questions over. */
export async function clearWikiQuestions(report: Report) {
  const old = report.askThreadId;
  if (!old) return;
  share(await api.reportAskThread(report.id, null));
  deleteConversation(old);
}

export const stopReport = (report: Report) => stop(report.threadId);

export async function deleteReport(report: Report) {
  try {
    await api.reportDelete(report.id);
  } catch (e) {
    return void toast.error("Couldn’t delete it", { description: errorMessage(e) });
  }
  remove(report.id);
  void broadcast(REPORTS_EVENT, { type: "delete", id: report.id } satisfies Shared);
  deleteConversation(report.threadId);
  if (report.askThreadId) deleteConversation(report.askThreadId);
}

/** Hand a finding to a new Cowork session to fix. Returns the session's id, or null if it couldn't start. */
export function fixFinding(report: Report, f: Finding): string | null {
  if (needsModel()) return null;
  const where = f.file ? ` in \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
  const what = report.kind === "security" ? "security issue" : "problem a code review found";
  const prompt = [
    `Fix this ${what}${where}.`,
    `**${f.title}** (${f.severity})\n\n${f.description}`,
    f.suggestion ? `Suggested fix:\n\n${f.suggestion}` : "",
    "Read the code first and check the problem is real. Then make the smallest change that fixes it, and tell me what you changed.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const convo = createConversation(report.workspaceId, `Fix: ${f.title}`);
  sendMessage(convo.id, prompt, []);
  return convo.id;
}

/**
 * Show a workspace file (at a line) in the Cowork file viewer. Returns the
 * session whose side panel shows it, for the caller to open.
 */
export function viewFile(workspaceId: string, path: string, line?: number): string {
  openFile(workspaceId, path, line);
  return getOrCreateEmptyConversation(workspaceId).id;
}

// --- state ---------------------------------------------------------------------------

/** A report's status with its run's: `needs-input` while a call waits for approval (e.g. reading a `.env`). */
export type ReportState = ReportStatus | "needs-input";

export function useReportState(report: Report): ReportState {
  const session = useSessionStatus(report.threadId);
  if (session === "needs-input") return "needs-input";
  if (session === "working") return "running";
  return report.status;
}

/** What the run is doing now and how many files it has read, from its thread. */
export function useReportActivity(threadId: string): { now: string; read: number } {
  const { messages } = useThread(threadId);
  const tools = (messages.at(-1)?.role === "assistant" ? messages.at(-1)!.parts : []).filter(
    (p): p is DynamicToolUIPart => p.type === "dynamic-tool",
  );
  const read = new Set(tools.filter((t) => t.toolName === "fs_read").map((t) => (t.input as { path?: string })?.path)).size;
  return { now: describeTool(tools.at(-1)), read };
}

function describeTool(t: DynamicToolUIPart | undefined): string {
  const input = (t?.input ?? {}) as Record<string, unknown>;
  const name = t?.toolName;
  switch (name) {
    case undefined:
      return "Starting…";
    case "fs_read":
      return `Reading ${input.path ?? "a file"}`;
    case "fs_search":
      return "Searching the code";
    case "fs_glob":
    case "fs_list":
      return "Looking through the files";
    case "git_diff":
      return "Reading the changes";
    case "report_findings":
      return "Writing up the findings";
    case "wiki_write_page":
      return `Writing “${input.title ?? "a page"}”`;
    default:
      return name.includes("__") ? "Reading the pull request" : "Working…";
  }
}
