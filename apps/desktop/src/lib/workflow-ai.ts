// The Workflow Builder's AI: one-shot model calls (`complete`) with the step
// catalog and the graph as JSON, answered as JSON.
//
//   describeWorkflow  "When a deal is won, research the company…" → a graph, or a changed one
//   suggestNext       2–3 likely next steps after a step
//   fixStep           a failed step's config, input and error → a corrected config and why
//   setUpStep         fill a step's settings from its name and the values before it
//   sampleInput       test input for a manual or chat trigger
//
// Every result goes through the same checks as a hand-made edit (known types,
// no loops, one trigger) and lands as one undoable edit.

import { complete, extractJson } from "@/lib/complete";
import { getCrm } from "@/lib/crm";
import { getTarget } from "@/lib/store";
import type { ModelTarget } from "@/lib/transport";
import {
  defOf,
  editGraph,
  getWorkflow,
  isTrigger,
  keyFor,
  makesCycle,
  modelFor,
  NODE_DEFS,
  providerTrouble,
  variablesFor,
  type Graph,
  type NodeConfig,
  type NodeType,
  type Port,
  type WfNode,
} from "@/lib/workflows";

const ROW = 148;

/** The step catalog as the model reads it. */
function catalog(): string {
  const { settings } = getCrm();
  const lines = NODE_DEFS.map(
    (d) => `- ${d.type} (${d.group}${d.ports.length > 1 ? `, outputs ${d.ports.join("/")}` : ""}): ${d.description} Config keys: ${Object.keys(d.defaults).join(", ") || "none"}.`,
  );
  return [
    "Step types:",
    ...lines,
    "",
    "Config notes: crm-event.event is any|created|updated|stage-changed|deleted; crm-event.kind is any|company|contact|deal; " +
      `crm-event.toStage is a stage id (deal stages: ${settings.dealStages.map((s) => `${s.id}=${s.name}`).join(", ") || "none"}; ` +
      `company stages: ${settings.companyStages.map((s) => `${s.id}=${s.name}`).join(", ") || "none"}). agent.output is text|json. ` +
      "if.mode is compare|ai, if.op is is|is-not|contains|gt|lt|empty|not-empty. crm-log.kind is ai|note|call|meeting|email. " +
      "board-task.priority is low|medium|high. join.mode is all|first; end.outcome is done|failed with end.message. " +
      "To do things at the same time, follow a parallel step with each branch and bring them back with a join; end a branch early with an end step. " +
      "Text config can use {{trigger.input}}, {{trigger.record.name}}, {{trigger.record.id}}, " +
      "{{trigger.record.company}}, {{trigger.to}} (new stage name) and {{<key>}} or {{<key>.<field>}} for an earlier step's result.",
  ].join("\n");
}

interface SpecStep {
  key: string;
  type: NodeType;
  label: string;
  config?: NodeConfig;
  /** Keys of the steps this one follows, with the port: "key" or "key:yes" / "key:no". */
  after?: string[];
}

/** A graph as the model reads and writes it. */
function toSpec(g: Graph): SpecStep[] {
  return g.nodes.map((n) => ({
    key: n.key,
    type: n.type,
    label: n.label,
    config: n.config,
    after: g.edges
      .filter((e) => e.to === n.id)
      .map((e) => {
        const from = g.nodes.find((x) => x.id === e.from);
        return from ? (e.port === "out" ? from.key : `${from.key}:${e.port}`) : "";
      })
      .filter(Boolean),
  }));
}

/** Turn the model's steps into a graph, keeping the ids and places of steps it kept (by key). */
function fromSpec(spec: SpecStep[], old: Graph): Graph | string {
  if (!Array.isArray(spec) || spec.length === 0) return "No steps came back.";
  const types = new Set(NODE_DEFS.map((d) => d.type));
  const nodes: WfNode[] = [];
  const byKey = new Map<string, WfNode>();
  for (const s of spec) {
    if (!types.has(s.type)) return `Unknown step type “${s.type}”.`;
    const kept = old.nodes.find((n) => n.key === s.key && n.type === s.type);
    const def = defOf(s.type);
    const key = def.group === "trigger" ? "trigger" : kept?.key ?? keyFor(s.key || s.label, nodes.map((n) => n.key));
    const node: WfNode = {
      id: kept?.id ?? crypto.randomUUID().slice(0, 8),
      type: s.type,
      label: String(s.label || def.label).slice(0, 60),
      key,
      x: kept?.x ?? 0,
      y: kept?.y ?? 0,
      config: { ...def.defaults, ...(s.config ?? {}) },
    };
    nodes.push(node);
    byKey.set(s.key, node);
    byKey.set(key, node);
  }
  if (nodes.filter(isTrigger).length !== 1) return "A workflow needs exactly one trigger.";
  const g: Graph = { nodes, edges: [] };
  for (const s of spec) {
    const to = byKey.get(s.key)!;
    for (const ref of s.after ?? []) {
      const [k, p] = String(ref).split(":");
      const from = byKey.get(k);
      if (!from || isTrigger(to)) continue;
      const port = (p || defOf(from.type).ports[0]) as Port;
      if (!defOf(from.type).ports.includes(port)) continue;
      if (makesCycle(g, from.id, to.id)) continue;
      g.edges.push({ id: crypto.randomUUID().slice(0, 8), from: from.id, port, to: to.id });
    }
  }
  layout(g, new Set(old.nodes.map((n) => n.id)));
  return g;
}

/** Place new steps: one row below the step they follow (branches side by side), the trigger on top. */
function layout(g: Graph, placed: Set<string>) {
  const depth = new Map<string, number>();
  const visit = (id: string, d: number) => {
    if ((depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    for (const e of g.edges) if (e.from === id) visit(e.to, d + 1);
  };
  for (const n of g.nodes) if (isTrigger(n)) visit(n.id, 0);
  const perRow = new Map<number, number>();
  for (const n of g.nodes) {
    if (placed.has(n.id)) continue;
    const d = depth.get(n.id) ?? Math.max(0, ...depth.values()) + 1;
    const i = perRow.get(d) ?? 0;
    perRow.set(d, i + 1);
    const parent = g.edges.find((e) => e.to === n.id);
    const px = parent ? g.nodes.find((x) => x.id === parent.from)?.x ?? 0 : 0;
    n.x = px + i * 280;
    n.y = d * ROW;
  }
}

/** The workflow's model (else the default), for the builder's AI. */
let current: ModelTarget | null = null;
function model() {
  const target = current ?? getTarget();
  if (!target) throw new Error("Pick a model for this workflow (at the top of the editor).");
  return target;
}

async function ask<T>(system: string, user: string): Promise<T> {
  let text: string;
  try {
    text = await complete(model(), system, user);
  } catch (e) {
    // An account or connection problem, in plain words.
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(providerTrouble(raw)?.text ?? raw);
  }
  try {
    return extractJson(text) as T;
  } catch {
    throw new Error("The model's answer wasn't the JSON asked for. Try again, or pick a stronger model.");
  }
}

/** Build the workflow from a description, or change the one there. One undoable edit. */
export async function describeWorkflow(workflowId: string, description: string): Promise<{ name?: string; summary: string }> {
  const w = getWorkflow(workflowId);
  current = w ? modelFor(w) : null;
  if (!w) throw new Error("That workflow is gone.");
  const blank = w.nodes.length <= 1 && w.edges.length === 0;
  const system =
    "You design workflows for Sush, a desktop AI app. A workflow is one trigger and the steps after it, run top to bottom. " +
    "Answer with only a JSON object: {\"name\": short name, \"summary\": one sentence on what changed, \"steps\": [{\"key\": snake_case id, " +
    "\"type\": a step type, \"label\": short name, \"config\": {...}, \"after\": [keys it follows; \"key:yes\" or \"key:no\" after an if or approval]}]}. " +
    "Return every step of the whole workflow, unchanged ones too, keeping their keys. Prefer few steps. Use an agent step for anything " +
    "needing judgement, research or writing; put an approval step before anything that changes data the user would want to check.\n\n" +
    catalog();
  const user = blank
    ? `Build a workflow that does this: ${description}`
    : `The workflow now:\n${JSON.stringify(toSpec(w))}\n\nChange it: ${description}`;
  const out = await ask<{ name?: string; summary?: string; steps: SpecStep[] }>(system, user);
  const g = fromSpec(out.steps, w);
  if (typeof g === "string") throw new Error(g);
  editGraph(workflowId, () => g);
  return { name: blank ? out.name : undefined, summary: out.summary ?? "Done." };
}

export interface Suggestion {
  type: NodeType;
  label: string;
  config: NodeConfig;
  why: string;
}

/** Likely next steps after `nodeId`. */
export async function suggestNext(workflowId: string, nodeId: string): Promise<Suggestion[]> {
  const w = getWorkflow(workflowId);
  current = w ? modelFor(w) : null;
  const node = w?.nodes.find((n) => n.id === nodeId);
  if (!w || !node) return [];
  const out = await ask<{ suggestions: Suggestion[] }>(
    "Suggest the 3 most useful next steps for a workflow, after the given step. Answer with only JSON: " +
      "{\"suggestions\": [{\"type\", \"label\", \"config\", \"why\": a few words}]}.\n\n" +
      catalog(),
    `Workflow "${w.name}":\n${JSON.stringify(toSpec(w))}\n\nAfter the step "${node.key}".`,
  );
  const types = new Set(NODE_DEFS.filter((d) => d.group !== "trigger").map((d) => d.type));
  return (out.suggestions ?? []).filter((s) => types.has(s.type)).slice(0, 3);
}

/** A corrected config for a failed step, with the reason. */
export async function fixStep(
  workflowId: string,
  nodeId: string,
  run: { input?: string; error?: string },
): Promise<{ config: NodeConfig; why: string }> {
  const w = getWorkflow(workflowId);
  const node = w?.nodes.find((n) => n.id === nodeId);
  current = w ? modelFor(w, node) : null;
  if (!w || !node) throw new Error("That step is gone.");
  const vars = variablesFor(w, nodeId).map((v) => `{{${v.key}}}: ${v.label}`);
  const out = await ask<{ config: NodeConfig; why: string }>(
    "A workflow step failed. Work out why and return a corrected config for it. If the problem isn't in the step's own " +
      "config (a missing connector, no model, a record that doesn't exist), keep the config and say what the user should do. " +
      'Answer with only JSON: {"config": {...the whole config}, "why": one or two sentences}.\n\n' +
      catalog(),
    `Step ${JSON.stringify({ type: node.type, label: node.label, config: node.config })}\n` +
      `Values it can use: ${vars.join(", ") || "none"}\nIt was given: ${run.input ?? "(nothing)"}\nIt failed with: ${run.error ?? "(no message)"}`,
  );
  return { config: { ...defOf(node.type).defaults, ...out.config }, why: out.why ?? "" };
}

/** Fill a step's settings from its name and the values before it. */
export async function setUpStep(workflowId: string, nodeId: string, hint: string): Promise<NodeConfig> {
  const w = getWorkflow(workflowId);
  current = w ? modelFor(w) : null;
  const node = w?.nodes.find((n) => n.id === nodeId);
  if (!w || !node) throw new Error("That step is gone.");
  const vars = variablesFor(w, nodeId).map((v) => `{{${v.key}}}: ${v.label}`);
  const out = await ask<{ config: NodeConfig }>(
    "Fill in one workflow step's config so it does what its name (and the note) says, using the values from earlier steps " +
      'where they fit. Answer with only JSON: {"config": {...}}.\n\n' +
      catalog(),
    `Workflow "${w.name}": ${JSON.stringify(toSpec(w))}\n\nStep "${node.key}" (${node.type}, "${node.label}"). ` +
      `Values it can use: ${vars.join(", ") || "none"}.${hint ? ` Note: ${hint}` : ""}`,
  );
  return { ...node.config, ...out.config };
}

/** Plausible test input for a manual or chat trigger. */
export async function sampleInput(workflowId: string): Promise<string> {
  const w = getWorkflow(workflowId);
  current = w ? modelFor(w) : null;
  if (!w) return "";
  const out = await ask<{ input: string }>(
    'Write realistic test input for this workflow\'s trigger ({{trigger.input}}), short. Answer with only JSON: {"input": "..."}.',
    JSON.stringify({ name: w.name, description: w.description, steps: toSpec(w) }),
  );
  return String(out.input ?? "");
}
