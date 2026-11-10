// Runs workflows (`lib/workflows.ts`). A run walks the graph from its
// trigger: a step runs once every connection into it is settled and at least
// one of them carried the run (an If's untaken branch skips what only it
// reaches); independent branches run side by side. Each step's result is
// `{{its key}}` to the steps after it.
//
// Agent steps are ordinary runs on threads of their own (`stepThread` gives
// them their instructions and tools), so they stream, ask before risky tool
// calls and can be opened from the run. Runs live in this window: triggers
// start them in the leader, Test run in the window it was pressed in; any
// window can answer an approval or stop one through the shared run record.

import { toast } from "sonner";

import { createTask } from "@/lib/board";
import { complete } from "@/lib/complete";
import { addActivity, formatMoney, getCrm, loadCrm, onCrmEvent, recordById, saveRecord, stageOf, stagesFor } from "@/lib/crm";
import { sendMessage, setSessionTarget, stop as stopThread, watchThread, type ThreadView } from "@/lib/sessions";
import { findConnectorTool } from "@/lib/agent";
import { createConversation, createStore } from "@/lib/store";
import { api, errorMessage, type CrmActivityKind, type CrmEvent, type CrmRecord } from "@/lib/tauri";
import { whenLeader } from "@/lib/windows";
import { getWorkspaces, onFilesChanged } from "@/lib/workspaces";
import {
  addStepThread,
  defOf,
  getRuns,
  getWorkflows,
  isTrigger,
  modelFor,
  patchRun,
  providerTrouble,
  putRun,
  render,
  subscribeRuns,
  type Graph,
  type Port,
  type StepRun,
  type WfNode,
  type WfRun,
  type Workflow,
} from "@/lib/workflows";

/** This window, as the runner of the runs it started. */
const WINDOW = crypto.randomUUID();

class Stopped extends Error {}

const runOf = (id: string) => getRuns().find((r) => r.id === id);

function setStep(runId: string, nodeId: string, patch: Partial<StepRun>) {
  patchRun(runId, (r) => ({ ...r, steps: { ...r.steps, [nodeId]: { ...r.steps[nodeId], ...patch } } }));
}

/** Resolves when `check` returns a value, re-checked on every run-store change; throws if the run is stopped. */
function waitFor<T>(runId: string, check: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (runOf(runId)?.stopRequested) {
        off();
        reject(new Stopped());
        return;
      }
      const v = check();
      if (v !== undefined) {
        off();
        resolve(v);
      }
    };
    const off = subscribeRuns(tick);
    tick();
  });
}

/** Start `workflow` (its live graph, or the draft for a test). Returns the run's id, or null if it can't start. */
export function startWorkflow(
  workflow: Workflow,
  opts: { test: boolean; trigger: Record<string, unknown>; reason: string },
): string | null {
  const graph: Graph = opts.test || !workflow.live ? workflow : workflow.live;
  const trigger = graph.nodes.find(isTrigger);
  if (!trigger) {
    toast.error(`“${workflow.name}” has no trigger`, { description: "Add one on the canvas." });
    return null;
  }
  const run: WfRun = {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    test: opts.test,
    status: "running",
    startedAt: Date.now(),
    reason: opts.reason,
    trigger: opts.trigger,
    steps: Object.fromEntries(graph.nodes.map((n) => [n.id, { status: "pending" } as StepRun])),
    runner: WINDOW,
  };
  putRun(run);
  void execute(run.id, workflow, structuredClone(graph), trigger);
  return run.id;
}

async function execute(runId: string, workflow: Workflow, graph: Graph, trigger: WfNode) {
  const ctx: Record<string, unknown> = { trigger: runOf(runId)?.trigger ?? {} };
  const status: Record<string, StepRun["status"]> = Object.fromEntries(graph.nodes.map((n) => [n.id, "pending"]));
  const ports: Record<string, Port | undefined> = {};
  const now = Date.now();
  status[trigger.id] = "done";
  ports[trigger.id] = "out";
  setStep(runId, trigger.id, { status: "done", startedAt: now, endedAt: now, output: JSON.stringify(ctx.trigger, null, 1), port: "out" });

  const running = new Map<string, Promise<void>>();
  let failed = false;
  let stopped = false;

  const settleSkips = () => {
    // Anything never connected to the trigger, or whose every way in went unused, is skipped.
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of graph.nodes) {
        if (status[n.id] !== "pending" || n.id === trigger.id) continue;
        const incoming = graph.edges.filter((e) => e.to === n.id);
        const settled = incoming.every((e) => ["done", "failed", "skipped"].includes(status[e.from]));
        const carried = incoming.some((e) => status[e.from] === "done" && ports[e.from] === e.port);
        if (incoming.length === 0 || (settled && !carried)) {
          status[n.id] = "skipped";
          setStep(runId, n.id, { status: "skipped" });
          changed = true;
        }
      }
    }
  };

  const ready = () =>
    graph.nodes.filter((n) => {
      if (status[n.id] !== "pending" || running.has(n.id)) return false;
      const incoming = graph.edges.filter((e) => e.to === n.id);
      // A join set to the first branch goes as soon as one branch arrives.
      if (n.type === "join" && n.config.mode === "first") return incoming.some((e) => status[e.from] === "done" && ports[e.from] === e.port);
      return (
        incoming.length > 0 &&
        incoming.every((e) => ["done", "failed", "skipped"].includes(status[e.from])) &&
        incoming.some((e) => status[e.from] === "done" && ports[e.from] === e.port)
      );
    });

  const launch = (node: WfNode) => {
    status[node.id] = "running";
    const started = Date.now();
    setStep(runId, node.id, { status: "running", startedAt: started });
    // The steps whose answers arrived here, for a join.
    const sources = graph.edges
      .filter((e) => e.to === node.id && status[e.from] === "done" && ports[e.from] === e.port)
      .flatMap((e) => graph.nodes.filter((x) => x.id === e.from));
    const p = runStep(runId, workflow, node, ctx, sources)
      .then(({ output, port, input, fail }) => {
        status[node.id] = "done";
        ports[node.id] = port;
        ctx[node.key] = output;
        setStep(runId, node.id, { status: "done", endedAt: Date.now(), output, port, input, waitingFor: undefined });
        if (fail) {
          failed = true;
          patchRun(runId, (r) => ({ ...r, error: fail }));
        }
        announce(`${node.label} done`);
      })
      .catch((e: unknown) => {
        if (e instanceof Stopped) {
          stopped = true;
          status[node.id] = "skipped";
          setStep(runId, node.id, { status: "skipped", endedAt: Date.now(), waitingFor: undefined });
          return;
        }
        failed = true;
        status[node.id] = "failed";
        const raw = e instanceof Error ? e.message : String(e);
        // A provider's account problem reads in plain words; the original stays for the details.
        const trouble = providerTrouble(raw);
        setStep(runId, node.id, {
          status: "failed",
          endedAt: Date.now(),
          error: trouble?.text ?? raw,
          errorDetail: trouble ? raw : undefined,
          waitingFor: undefined,
        });
        announce(`${node.label} failed`);
      })
      .finally(() => running.delete(node.id));
    running.set(node.id, p);
  };

  try {
    for (;;) {
      if (runOf(runId)?.stopRequested) stopped = true;
      if (stopped) break;
      settleSkips();
      for (const n of ready()) launch(n);
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    if (stopped) await Promise.allSettled(running.values());
  } catch (e) {
    failed = true;
    patchRun(runId, (r) => ({ ...r, error: e instanceof Error ? e.message : String(e) }));
  }
  // Steps a stop left behind.
  for (const n of graph.nodes) if (status[n.id] === "pending") setStep(runId, n.id, { status: "skipped" });
  const final = stopped ? "stopped" : failed ? "failed" : "done";
  patchRun(runId, (r) => ({ ...r, status: final, endedAt: Date.now() }));
  announce(`${workflow.name} ${final === "done" ? "finished" : final}`);
  if (final === "failed" && !runOf(runId)?.test) {
    toast.error(`Workflow “${workflow.name}” failed`, { description: "Open it to see which step and why." });
  }
}

/** Run progress for screen readers (the page's live region reads it). */
const listeners = new Set<(text: string) => void>();
export function onAnnounce(l: (text: string) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const announce = (text: string) => listeners.forEach((l) => l(text));

// --- steps ---------------------------------------------------------------------------------

interface StepResult {
  output: string;
  port: Port;
  input?: string;
  /** An End step set to fail: the run's error. */
  fail?: string;
}

const str = (v: unknown) => (v == null ? "" : String(v));

async function runStep(runId: string, workflow: Workflow, node: WfNode, ctx: Record<string, unknown>, sources: WfNode[]): Promise<StepResult> {
  const c = node.config;
  const fill = (v: unknown) => render(str(v), ctx).trim();
  switch (node.type) {
    case "agent": {
      const prompt = fill(c.prompt);
      const json = c.output === "json";
      const system =
        `You are one step, "${node.label}", of the user's workflow "${workflow.name}", running on its own: the user isn't ` +
        "watching, so don't ask them questions; do the task with your tools and finish. Your last message is passed to the " +
        "next steps, so end with the result itself, not a description of what you did." +
        (json ? " End with only a JSON object holding the result's fields, no prose and no code fences." : "");
      const text = await agentRun(runId, workflow, node, prompt, system, str(c.workspaceId) || undefined);
      return { output: json ? jsonOnly(text) : text, port: "out", input: prompt };
    }
    case "tool": {
      const tool = str(c.tool);
      if (!tool) throw new Error("Pick a tool for this step.");
      const args = fill(c.args);
      const prompt =
        `Call the tool \`${tool}\` once${args ? ` with these arguments (as JSON, or described): ${args}` : ""}. ` +
        "Then reply with the tool's result, trimmed to what matters; nothing else.";
      const system =
        `You are the step "${node.label}" of the user's workflow "${workflow.name}". Call exactly the one tool you're given, ` +
        "once, then report its result. Don't ask questions.";
      const text = await agentRun(runId, workflow, node, prompt, system, undefined, [tool]);
      return { output: text, port: "out", input: args };
    }
    case "if": {
      if (c.mode === "ai") {
        const question = fill(c.question);
        const target = modelFor(workflow, node);
        if (!target) throw new Error("Pick a model for this workflow (at the top of the editor).");
        const answer = await complete(
          target,
          "Answer the question about the given facts with exactly one word: yes or no.",
          question,
        );
        const yes = /^\W*yes\b/i.test(answer.trim());
        return { output: yes ? "yes" : "no", port: yes ? "yes" : "no", input: question };
      }
      const left = fill(c.left);
      const right = fill(c.right);
      const yes = compare(left, str(c.op), right);
      return { output: yes ? "yes" : "no", port: yes ? "yes" : "no", input: `${left} ${c.op} ${right}` };
    }
    case "approval": {
      const message = fill(c.message) || `Continue “${workflow.name}”?`;
      setStep(runId, node.id, { status: "waiting", waitingFor: message });
      patchRun(runId, (r) => ({ ...r, status: "waiting" }));
      toast(`“${workflow.name}” is waiting for you`, { description: message });
      const yes = await waitFor(runId, () => runOf(runId)?.decisions?.[node.id]);
      patchRun(runId, (r) => ({ ...r, status: "running" }));
      return { output: yes ? "approved" : "declined", port: yes ? "yes" : "no", input: message };
    }
    case "parallel":
      return { output: "Branches started", port: "out" };
    case "join": {
      // Every arrived branch's answer, by its step's name, for the steps after.
      const answers = Object.fromEntries(sources.map((n) => [n.label, ctx[n.key] ?? ""]));
      return { output: JSON.stringify(answers), port: "out", input: sources.map((n) => n.label).join(", ") };
    }
    case "end": {
      const message = fill(c.message);
      if (c.outcome === "failed") {
        toast.error(`“${workflow.name}” ended as failed`, { description: message || undefined });
        return { output: message || "Ended as failed", port: "out", fail: message || "Ended at a step set to fail." };
      }
      if (message) toast(workflow.name, { description: message });
      return { output: message || "Finished", port: "out" };
    }
    case "delay": {
      const minutes = Math.min(24 * 60, Math.max(0, Number(c.minutes) || 0));
      const until = Date.now() + minutes * 60_000;
      setStep(runId, node.id, { waitingFor: `Until ${new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          resolve();
        }, minutes * 60_000);
        const off = subscribeRuns(() => {
          if (runOf(runId)?.stopRequested) {
            clearTimeout(timer);
            off();
            reject(new Stopped());
          }
        });
      });
      return { output: `Waited ${minutes} min`, port: "out" };
    }
    case "crm-update": {
      await loadCrm();
      const record = findRecord(fill(c.record));
      const patch: Partial<CrmRecord> = {};
      const changes: string[] = [];
      const stageName = fill(c.stage);
      if (stageName) {
        const stage = stagesFor(getCrm().settings, record.kind).find((s) => s.name.toLowerCase() === stageName.toLowerCase() || s.id === stageName);
        if (!stage) throw new Error(`No ${record.kind} stage “${stageName}”.`);
        patch.stage = stage.id;
        changes.push(`stage → ${stage.name}`);
      }
      const owner = fill(c.owner);
      if (owner) {
        patch.owner = owner;
        changes.push(`owner → ${owner}`);
      }
      const value = fill(c.value);
      if (value) {
        const n = Number(value.replace(/[^0-9.-]/g, ""));
        if (!Number.isFinite(n)) throw new Error(`“${value}” isn't a number.`);
        patch.value = n;
        changes.push(`value → ${formatMoney(n, getCrm().settings.currency)}`);
      }
      const field = fill(c.field);
      if (field) {
        patch.fields = { ...record.fields, [field]: fill(c.fieldValue) };
        changes.push(`${field} → ${fill(c.fieldValue) || "cleared"}`);
      }
      const saved = await saveRecord({ ...record, ...patch });
      if (!saved) throw new Error("Couldn't save the record.");
      return { output: `Updated ${saved.name}: ${changes.join(", ")}`, port: "out" };
    }
    case "crm-log": {
      await loadCrm();
      const record = findRecord(fill(c.record));
      const body = fill(c.body);
      if (!body) throw new Error("Nothing to log: the text came out empty.");
      if (!(await addActivity(record.id, (str(c.kind) || "ai") as CrmActivityKind, body))) throw new Error("Couldn't log it.");
      return { output: `Logged on ${record.name}`, port: "out", input: body };
    }
    case "board-task": {
      const title = fill(c.title);
      const task = createTask({
        title,
        description: fill(c.description),
        priority: (["low", "medium", "high"].includes(str(c.priority)) ? str(c.priority) : "medium") as "low" | "medium" | "high",
        status: "todo",
      });
      return { output: `Created the task “${task.title}”`, port: "out" };
    }
    case "notify": {
      const title = fill(c.title) || workflow.name;
      const body = fill(c.body);
      toast(title, { description: body || undefined, duration: 10_000 });
      return { output: body ? `${title}: ${body}` : title, port: "out" };
    }
    case "cowork": {
      const prompt = fill(c.prompt);
      const workspaceId = str(c.workspaceId);
      if (workspaceId && !getWorkspaces().some((w) => w.id === workspaceId)) throw new Error("Its folder was removed. Pick another.");
      const target = modelFor(workflow);
      if (!target) throw new Error("Pick a model for this workflow (at the top of the editor).");
      const convo = createConversation(workspaceId || undefined, `${workflow.name}`);
      setSessionTarget(convo.id, target);
      sendMessage(convo.id, prompt, []);
      return { output: `Started a session: ${convo.id}`, port: "out", input: prompt };
    }
    default:
      throw new Error(`${defOf(node.type).label} steps can't run yet.`);
  }
}

function compare(left: string, op: string, right: string): boolean {
  const l = left.trim().toLowerCase();
  const r = right.trim().toLowerCase();
  const nl = Number(left.replace(/[^0-9.-]/g, ""));
  const nr = Number(right.replace(/[^0-9.-]/g, ""));
  const numeric = l !== "" && r !== "" && Number.isFinite(nl) && Number.isFinite(nr);
  switch (op) {
    case "is":
      return l === r;
    case "is-not":
      return l !== r;
    case "contains":
      return l.includes(r);
    case "gt":
      return numeric ? nl > nr : l > r;
    case "lt":
      return numeric ? nl < nr : l < r;
    case "empty":
      return l === "";
    case "not-empty":
      return l !== "";
    default:
      return false;
  }
}

function findRecord(ref: string): CrmRecord {
  if (!ref) throw new Error("Say which record (for example {{trigger.record.id}}).");
  const { records } = getCrm();
  const r = records.find((x) => x.id === ref) ?? records.filter((x) => x.name.toLowerCase() === ref.toLowerCase()).at(0);
  if (!r) throw new Error(`No CRM record “${ref}”.`);
  return r;
}

/** The JSON object at the end of a reply, as text; the whole reply if there's none. */
function jsonOnly(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return text;
  try {
    return JSON.stringify(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return text;
  }
}

/** Run a model on a step thread of its own and return its final text. */
async function agentRun(
  runId: string,
  workflow: Workflow,
  node: WfNode,
  prompt: string,
  system: string,
  workspaceId?: string,
  only?: string[],
): Promise<string> {
  if (!prompt) throw new Error("The prompt came out empty.");
  const target = modelFor(workflow, node);
  if (!target) throw new Error("Pick a model for this workflow (at the top of the editor).");
  if (workspaceId && !getWorkspaces().some((w) => w.id === workspaceId)) throw new Error("Its folder was removed. Pick another.");
  const convo = createConversation(workspaceId, `${workflow.name} · ${node.label}`);
  addStepThread(convo.id, { workflowId: workflow.id, runId, nodeId: node.id, system, only, target });
  setSessionTarget(convo.id, target);
  setStep(runId, node.id, { threadId: convo.id });
  sendMessage(convo.id, prompt, []);
  return new Promise<string>((resolve, reject) => {
    let started = false;
    const offRuns = subscribeRuns(() => {
      if (runOf(runId)?.stopRequested) {
        stopThread(convo.id);
        cleanup();
        reject(new Stopped());
      }
    });
    const offThread = watchThread(convo.id, (v: ThreadView) => {
      if (v.status === "submitted" || v.status === "streaming") {
        started = true;
        setStep(runId, node.id, { status: "running", waitingFor: undefined });
        return;
      }
      if (v.status === "awaiting") {
        started = true;
        setStep(runId, node.id, { status: "waiting", waitingFor: "A tool call needs your approval" });
        patchRun(runId, (r) => ({ ...r, status: "waiting" }));
        return;
      }
      if (!started) return;
      patchRun(runId, (r) => (r.status === "waiting" ? { ...r, status: "running" } : r));
      cleanup();
      if (v.status === "error") reject(new Error(v.error ?? "The model stopped with an error."));
      else {
        const last = v.messages.findLast((m) => m.role === "assistant");
        if (last?.metadata?.paused) {
          reject(new Error("The step was stopped before it finished."));
          return;
        }
        const text = (last?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n").trim();
        if (!text) reject(new Error("The step finished without an answer."));
        else resolve(text);
      }
    });
    const cleanup = () => {
      offRuns();
      offThread();
    };
  });
}

// --- triggers ------------------------------------------------------------------------------

/** A CRM event as a trigger's input: names for links and stages. */
function crmTrigger(event: CrmEvent): Record<string, unknown> {
  const { settings } = getCrm();
  const r = event.record;
  const stageName = (id: string | null | undefined) => stagesFor(settings, r.kind).find((s) => s.id === id)?.name ?? "";
  return {
    event: event.type,
    kind: r.kind,
    record: {
      id: r.id,
      kind: r.kind,
      name: r.name,
      company: recordById(r.companyId)?.name ?? "",
      contact: recordById(r.contactId)?.name ?? "",
      stage: stageOf(settings, r)?.name ?? "",
      value: r.value ?? "",
      owner: r.owner ?? "",
      email: r.email ?? "",
      domain: r.domain ?? "",
      closeDate: r.closeDate ?? "",
    },
    from: event.type === "stage-changed" ? stageName(event.from) : "",
    to: event.type === "stage-changed" ? stageName(event.to) : "",
    changed: "changed" in event ? event.changed : [],
  };
}

/** Does a CRM trigger's setup match this event? */
export function crmMatches(config: WfNode["config"], event: CrmEvent): boolean {
  const kind = str(config.kind);
  if (kind && kind !== "any" && kind !== event.record.kind) return false;
  const want = str(config.event) || "any";
  if (want === "any") return true;
  if (want === "updated") {
    // Any change, stage moves included, optionally of one field.
    if (event.type !== "updated" && event.type !== "stage-changed") return false;
    const field = str(config.field);
    return !field || event.changed.includes(field);
  }
  if (want !== event.type) return false;
  if (event.type === "stage-changed") {
    const to = str(config.toStage);
    if (to && to !== event.to) return false;
  }
  return true;
}

function describeCrm(event: CrmEvent): string {
  const r = event.record;
  const what = `${r.kind[0].toUpperCase()}${r.kind.slice(1)} “${r.name}”`;
  if (event.type === "created") return `${what} added`;
  if (event.type === "deleted") return `${what} deleted`;
  if (event.type === "stage-changed") {
    const t = crmTrigger(event);
    return `${what} moved to ${t.to || "no stage"}`;
  }
  return `${what} changed`;
}

/** Runs triggers fired in the last little while, so a burst (a bulk edit) can't start hundreds of runs. */
const recentStarts: number[] = [];
const BURST = 20;

function fire(match: (w: Workflow, trigger: WfNode) => boolean, data: () => Record<string, unknown>, reason: string) {
  for (const w of getWorkflows()) {
    if (!w.enabled || !w.live) continue;
    const trigger = w.live.nodes.find(isTrigger);
    if (!trigger || !match(w, trigger)) continue;
    const now = Date.now();
    while (recentStarts.length && now - recentStarts[0] > 60_000) recentStarts.shift();
    if (recentStarts.length >= BURST) {
      toast.error("Workflows paused for a minute", { description: `More than ${BURST} runs started in a minute; “${w.name}” didn't run for: ${reason}.` });
      continue;
    }
    recentStarts.push(now);
    startWorkflow(w, { test: false, trigger: data(), reason });
  }
}

/** Run a workflow that has a chat or automation trigger (or a manual one), with `input`. */
export function runByName(nameOrId: string, input: string, via: "chat" | "automation"): { ok: true; runId: string; name: string } | { ok: false; error: string } {
  const all = getWorkflows();
  const w = all.find((x) => x.id === nameOrId) ?? all.find((x) => x.name.toLowerCase() === nameOrId.trim().toLowerCase());
  if (!w) return { ok: false, error: `No workflow called “${nameOrId}”. Workflows: ${all.map((x) => x.name).join(", ") || "none"}.` };
  const graph = w.live ?? w;
  const trigger = graph.nodes.find(isTrigger);
  if (!trigger || !["manual", "chat", "automation"].includes(trigger.type)) {
    return { ok: false, error: `“${w.name}” starts on its own trigger (${trigger ? defOf(trigger.type).label : "none"}), not from ${via === "chat" ? "a chat" : "an automation"}.` };
  }
  const runId = startWorkflow(w, { test: !w.live, trigger: { input }, reason: via === "chat" ? "Asked in a chat" : "Started by an automation" });
  return runId ? { ok: true, runId, name: w.name } : { ok: false, error: "It couldn't start." };
}

let started = false;

/** Listen for triggers. Call once at startup; only the leader window acts on them. */
export function startWorkflowTriggers() {
  if (started) return;
  started = true;
  whenLeader(() => {
    cleanUpOrphans();
    onCrmEvent((event) => {
      if (!getWorkflows().some((w) => w.enabled)) return;
      void loadCrm().then(() =>
        fire(
          (_, t) => t.type === "crm-event" && crmMatches(t.config, event),
          () => crmTrigger(event),
          describeCrm(event),
        ),
      );
    });
    // Folder changes, a few seconds after the last one so a burst of edits is one run.
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    onFilesChanged((workspaceId) => {
      clearTimeout(pending.get(workspaceId));
      pending.set(
        workspaceId,
        setTimeout(() => {
          pending.delete(workspaceId);
          const folder = getWorkspaces().find((w) => w.id === workspaceId)?.name ?? "a folder";
          fire(
            (_, t) => t.type === "file" && t.config.workspaceId === workspaceId,
            () => ({ folder, workspaceId }),
            `Files changed in ${folder}`,
          );
        }, 5_000),
      );
    });
    // Mail and calendar, checked through read-only connector tools.
    setInterval(() => void pollConnectors(), 60_000);
  });
}

// --- mail and calendar ----------------------------------------------------------------------

/** What each watching workflow has seen, by workflow id. */
const cursors = createStore<Record<string, { seen: string[]; at: number }>>("sush.workflow-cursors", {});

/** Items in a tool's answer: a JSON list (or the first list in an object), else its lines. */
export function itemsOf(text: string): { id: string; item: unknown }[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ id: l, item: l }));
  }
  const list = Array.isArray(data)
    ? data
    : ((Object.values((data ?? {}) as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? [data]);
  return list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = o.id ?? o.messageId ?? o.threadId ?? o.eventId ?? o.uid;
    return { id: id != null ? String(id) : JSON.stringify(item), item };
  });
}

/** A time field of an item (`start`, `start.dateTime`, `startTime`…), in ms. */
function timeOf(item: unknown, names: string[]): number | null {
  const o = (item ?? {}) as Record<string, unknown>;
  for (const n of names) {
    let v = o[n];
    if (v && typeof v === "object") v = (v as Record<string, unknown>).dateTime ?? (v as Record<string, unknown>).date;
    if (typeof v === "string" || typeof v === "number") {
      const t = new Date(v).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

function fieldOf(item: unknown, names: string[]): string {
  const o = (item ?? {}) as Record<string, unknown>;
  for (const n of names) if (o[n] != null) return typeof o[n] === "string" ? (o[n] as string) : JSON.stringify(o[n]);
  return "";
}

let polling = false;

async function pollConnectors() {
  if (polling) return;
  polling = true;
  try {
    for (const w of getWorkflows()) {
      if (!w.enabled || !w.live) continue;
      const t = w.live.nodes.find(isTrigger);
      if (!t || (t.type !== "email" && t.type !== "calendar")) continue;
      const every = Math.max(1, Number(t.config.every) || 10) * 60_000;
      const cursor = cursors.get()[w.id];
      if (cursor && Date.now() - cursor.at < every) continue;
      await pollOne(w, t, cursor);
    }
  } finally {
    polling = false;
  }
}

/** Ask a mail or calendar trigger's read-only tool for its current items. */
async function readItems(t: WfNode): Promise<{ id: string; item: unknown }[]> {
  const found = findConnectorTool(String(t.config.tool ?? ""));
  if (!found) throw new Error("Its connector isn't connected. Reconnect it, or pick another tool.");
  const now = new Date();
  const argsText = render(String(t.config.args ?? ""), { now: now.toISOString(), today: now.toISOString().slice(0, 10) });
  let args: unknown = {};
  if (argsText.trim()) {
    try {
      args = JSON.parse(argsText);
    } catch {
      args = { query: argsText };
    }
  }
  try {
    return itemsOf(await api.connectorRead(found.connector.id, found.tool, args));
  } catch (e) {
    throw new Error(`Couldn't check ${found.connector.name}: ${errorMessage(e)}`);
  }
}

/** One mail or calendar item as the trigger's input, and the run's reason. */
function itemTrigger(t: WfNode, item: unknown): { data: Record<string, unknown>; reason: string } {
  if (t.type === "email") {
    const subject = fieldOf(item, ["subject", "title", "snippet"]);
    return { data: { subject, from: fieldOf(item, ["from", "sender"]), item }, reason: `New email: ${subject || "(no subject)"}` };
  }
  const title = fieldOf(item, ["summary", "title", "subject", "name"]);
  return { data: { title, start: fieldOf(item, ["start", "startTime"]), item }, reason: `Calendar: ${title || "an event"}` };
}

async function pollOne(w: Workflow, t: WfNode, cursor: { seen: string[]; at: number } | undefined) {
  const save = (seen: string[]) => cursors.set((all) => ({ ...all, [w.id]: { seen: seen.slice(-500), at: Date.now() } }));
  let items: { id: string; item: unknown }[];
  try {
    items = await readItems(t);
  } catch (e) {
    save(cursor?.seen ?? []);
    toast.error(`“${w.name}” couldn't run its check`, { description: errorMessage(e) });
    return;
  }
  const seen = new Set(cursor?.seen ?? []);
  const fresh: { id: string; item: unknown }[] = [];
  if (t.type === "email") {
    // The first check only notes what's there.
    if (cursor) fresh.push(...items.filter((i) => !seen.has(i.id)));
  } else {
    const ahead = Math.max(0, Number(t.config.minutes) || 0) * 60_000;
    const window = Math.max(Number(t.config.every) || 5, 5) * 60_000 * 2;
    const at = Date.now();
    for (const i of items) {
      if (seen.has(i.id)) continue;
      const start = timeOf(i.item, ["start", "startTime", "begin", "startsAt"]);
      const end = timeOf(i.item, ["end", "endTime", "endsAt"]);
      const due = t.config.when === "ended" ? end != null && end <= at && at - end <= window : start != null && start >= at && start - at <= ahead;
      if (due) fresh.push(i);
    }
  }
  save([...seen, ...(t.type === "email" ? items.map((i) => i.id) : fresh.map((i) => i.id))]);
  for (const i of fresh.slice(0, 5)) {
    const { data, reason } = itemTrigger(t, i.item);
    fire((x) => x.id === w.id, () => data, reason);
  }
}

/** Runs left "running" when Sush last quit (started before this window opened, by another) won't finish: mark them stopped. */
function cleanUpOrphans() {
  const stale = getRuns().filter((r) => (r.status === "running" || r.status === "waiting") && r.runner !== WINDOW && r.startedAt < performance.timeOrigin);
  for (const r of stale) {
    patchRun(r.id, (x) => ({
      ...x,
      status: "stopped",
      endedAt: Date.now(),
      error: "Sush closed while it ran.",
      steps: Object.fromEntries(
        Object.entries(x.steps).map(([k, s]) => [
          k,
          s.status === "running" || s.status === "waiting" || s.status === "pending" ? { ...s, status: "skipped" as const, waitingFor: undefined } : s,
        ]),
      ),
    }));
  }
}

/** Test a CRM trigger with a record of the right kind, for Test run. */
export async function sampleCrmTrigger(config: WfNode["config"]): Promise<Record<string, unknown> | null> {
  await loadCrm();
  const { records } = getCrm();
  const kind = str(config.kind);
  const r = records.find((x) => !kind || kind === "any" || x.kind === kind);
  if (!r) return null;
  const to = str(config.toStage) || r.stage || null;
  // Pretend it came from the stage before, so "moved from … to …" reads right.
  const stages = stagesFor(getCrm().settings, r.kind);
  const at = stages.findIndex((s) => s.id === to);
  const from = at > 0 ? stages[at - 1].id : r.stage && r.stage !== to ? r.stage : null;
  const event: CrmEvent =
    str(config.event) === "stage-changed"
      ? { type: "stage-changed", record: { ...r, stage: to ?? undefined }, from, to, changed: ["stage"] }
      : str(config.event) === "created"
        ? { type: "created", record: r }
        : str(config.event) === "deleted"
          ? { type: "deleted", record: r }
          : { type: "updated", record: r, changed: [str(config.field) || "notes"] };
  return crmTrigger(event);
}

/**
 * What a Test run starts with, for any trigger: a real CRM record, the newest
 * mail or calendar item its tool returns, the picked folder, or the test input.
 * Throws with a reason the page shows when there's nothing to test with.
 */
export async function sampleTrigger(trigger: WfNode): Promise<{ data: Record<string, unknown>; reason: string }> {
  switch (trigger.type) {
    case "crm-event": {
      const sample = await sampleCrmTrigger(trigger.config);
      if (!sample) {
        const kind = String(trigger.config.kind ?? "");
        throw new Error(`There's no ${kind && kind !== "any" ? kind : "record"} in your CRM to test with. Add one on the CRM page (in the sidebar), or change what the start step listens to.`);
      }
      return { data: sample, reason: `Test run with “${(sample.record as { name: string }).name}”` };
    }
    case "email":
    case "calendar": {
      const items = await readItems(trigger);
      if (items.length === 0) throw new Error(`Its tool found no ${trigger.type === "email" ? "emails" : "events"} to test with. Loosen its arguments.`);
      const { data, reason } = itemTrigger(trigger, items[0].item);
      return { data, reason: `Test run with ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` };
    }
    case "file": {
      const workspaceId = String(trigger.config.workspaceId ?? "");
      const folder = getWorkspaces().find((w) => w.id === workspaceId)?.name;
      if (!folder) throw new Error("Pick a folder for the trigger first.");
      return { data: { folder, workspaceId }, reason: `Test run as if files changed in ${folder}` };
    }
    default:
      return { data: { input: String(trigger.config.input ?? "") }, reason: "Test run" };
  }
}
