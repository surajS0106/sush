// Workflows to start from, on the Workflows page. Each builds a fresh graph
// (new ids every time) laid out top to bottom.

import type { Graph, NodeConfig, NodeType, Port, WfNode } from "@/lib/workflows";

export interface WorkflowTemplate {
  name: string;
  description: string;
  /** Its step types, for the card's icons. */
  steps: NodeType[];
  graph: () => Graph;
}

const ROW = 148;

/** Steps in a column (or side by side where `col` is set), each linked from the one `after` it names. */
function build(steps: { key: string; type: NodeType; label: string; config: NodeConfig; after?: string; port?: Port; col?: number; row?: number }[]): Graph {
  const ids = new Map<string, string>();
  const nodes: WfNode[] = steps.map((s, i) => {
    const id = crypto.randomUUID().slice(0, 8);
    ids.set(s.key, id);
    return { id, type: s.type, label: s.label, key: s.key, x: (s.col ?? 0) * 280, y: (s.row ?? i) * ROW, config: s.config };
  });
  const edges = steps.flatMap((s) =>
    s.after ? [{ id: crypto.randomUUID().slice(0, 8), from: ids.get(s.after)!, port: s.port ?? ("out" as Port), to: ids.get(s.key)! }] : [],
  );
  return { nodes, edges };
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    name: "Welcome a new customer",
    description: "When a deal is won: research the company, log onboarding notes on the deal, and add a kickoff task to your Board.",
    steps: ["crm-event", "agent", "crm-log", "board-task"],
    graph: () =>
      build([
        { key: "trigger", type: "crm-event", label: "Deal won", config: { event: "stage-changed", kind: "deal", toStage: "won" } },
        {
          key: "research",
          type: "agent",
          label: "Research the customer",
          after: "trigger",
          config: {
            prompt:
              "Our deal “{{trigger.record.name}}” with {{trigger.record.company}} was just won. Look the company up on the web " +
              "and write three short onboarding notes: what they do, who to involve, and what they'll likely need first.",
            output: "text",
          },
        },
        { key: "log", type: "crm-log", label: "Log the notes", after: "research", config: { record: "{{trigger.record.id}}", kind: "ai", body: "{{research}}" } },
        {
          key: "task",
          type: "board-task",
          label: "Kickoff task",
          after: "log",
          config: { title: "Kick off {{trigger.record.company}}", description: "{{research}}", priority: "high" },
        },
      ]),
  },
  {
    name: "Size up new leads",
    description: "When a company is added: Sush researches it, and if it looks like a big account, asks you before marking it Qualified.",
    steps: ["crm-event", "agent", "if", "approval", "crm-update"],
    graph: () =>
      build([
        { key: "trigger", type: "crm-event", label: "Company added", config: { event: "created", kind: "company" } },
        {
          key: "profile",
          type: "agent",
          label: "Profile the company",
          after: "trigger",
          config: {
            prompt:
              "Find out about the company “{{trigger.record.name}}” ({{trigger.record.domain}}) on the web. Return JSON with the keys " +
              "industry, employees (roughly how many people work there, as a number) and summary (one line on what it does).",
            output: "json",
          },
        },
        {
          key: "big",
          type: "if",
          label: "Big account?",
          after: "profile",
          config: { mode: "compare", left: "{{profile.employees}}", op: "gt", right: "200" },
        },
        {
          key: "ask",
          type: "approval",
          label: "Qualify it?",
          after: "big",
          port: "yes",
          config: { message: "{{trigger.record.name}} looks big ({{profile.employees}} people). Mark it Qualified?" },
        },
        { key: "qualify", type: "crm-update", label: "Mark Qualified", after: "ask", port: "yes", config: { record: "{{trigger.record.id}}", stage: "Qualified" } },
        {
          key: "note",
          type: "crm-log",
          label: "Log the profile",
          after: "big",
          port: "no",
          col: 1,
          row: 3,
          config: { record: "{{trigger.record.id}}", kind: "ai", body: "{{profile}}" },
        },
      ]),
  },
  {
    name: "Brief me before a call",
    description: "Run it by hand with a company's name: Sush gathers what the CRM and the web know and puts a one-page brief in a notification.",
    steps: ["manual", "agent", "notify"],
    graph: () =>
      build([
        { key: "trigger", type: "manual", label: "Run by hand", config: { input: "" } },
        {
          key: "brief",
          type: "agent",
          label: "Write the brief",
          after: "trigger",
          config: {
            prompt:
              "Write a short call brief on {{trigger.input}}: what the CRM has on them (crm_search, crm_read), recent news from the web, " +
              "and three questions worth asking. Keep it under 150 words.",
            output: "text",
          },
        },
        { key: "tell", type: "notify", label: "Show the brief", after: "brief", config: { title: "Brief: {{trigger.input}}", body: "{{brief}}" } },
      ]),
  },
];
