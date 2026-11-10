// The workflow editor's right panel: the picked step's settings, the values
// from earlier steps it can use (chips, added with + Insert), and its
// connections ("Connect to…" and remove). With nothing picked, the workflow's
// own name and what still stops it from running.

import { CircleAlertIcon, LoaderCircleIcon, PlusIcon, SparklesIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { InsertMenu, TokenField, type TokenFieldHandle } from "@/components/token-field";
import { NodeIcon } from "@/components/workflow-canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/components/model-picker";
import type { ProviderModels } from "@/hooks/use-providers";
import { connectorTools } from "@/lib/agent";
import { useTarget } from "@/lib/store";
import { useCrm } from "@/lib/crm";
import { errorMessage } from "@/lib/tauri";
import { sampleInput, setUpStep, suggestNext, type Suggestion } from "@/lib/workflow-ai";
import { useWorkspaces } from "@/lib/workspaces";
import {
  connect,
  defOf,
  editGraph,
  newNode,
  isTrigger,
  keyFor,
  makesCycle,
  stepModel,
  problems,
  removeEdge,
  removeNodes,
  setNode,
  updateWorkflow,
  variableLabel,
  variablesFor,
  type Variable,
  type NodeConfig,
  type Port,
  type WfNode,
  type Workflow,
} from "@/lib/workflows";

const NONE = "__none";

export function WorkflowInspector({
  workflow,
  catalog,
  node,
  onSelect,
  onClose,
}: {
  workflow: Workflow;
  catalog: ProviderModels[];
  node?: WfNode;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <aside aria-label={node ? `${node.label} settings` : "Workflow settings"} className="flex w-80 shrink-0 flex-col overflow-y-auto border-l bg-background">
      {node ? <NodeSettings key={node.id} workflow={workflow} catalog={catalog} node={node} onSelect={onSelect} onClose={onClose} /> : <WorkflowSettings workflow={workflow} onSelect={onSelect} />}
    </aside>
  );
}

function WorkflowSettings({ workflow, onSelect }: { workflow: Workflow; onSelect: (id: string) => void }) {
  const issues = problems(workflow);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="wf-name">Name</Label>
        <Input id="wf-name" value={workflow.name} onChange={(e) => updateWorkflow(workflow.id, (w) => ({ ...w, name: e.target.value }))} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="wf-desc">What it's for</Label>
        <Textarea
          id="wf-desc"
          value={workflow.description}
          placeholder="So you remember later"
          onChange={(e) => updateWorkflow(workflow.id, (w) => ({ ...w, description: e.target.value }))}
          className="min-h-16"
        />
      </div>
      <section aria-label="Checks">
        <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">Before it can run</h3>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing missing. Test it, then publish.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {issues.map((p, i) => (
              <li key={i}>
                <button
                  type="button"
                  disabled={!p.nodeId}
                  onClick={() => p.nodeId && onSelect(p.nodeId)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm enabled:hover:bg-muted"
                >
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-coral" />
                  {p.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <HowItWorks />
    </div>
  );
}

function NodeSettings({
  workflow,
  catalog,
  node,
  onSelect,
  onClose,
}: {
  workflow: Workflow;
  catalog: ProviderModels[];
  node: WfNode;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const def = defOf(node.type);
  const id = workflow.id;
  const set = (config: NodeConfig) => setNode(id, node.id, { config });
  const vars = variablesFor(workflow, node.id);
  const issues = problems(workflow).filter((p) => p.nodeId === node.id);

  const field = (key: string, label: string, opts: { multiline?: boolean; placeholder?: string; type?: string; hint?: ReactNode } = {}) => (
    <TextSetting
      key={key}
      workflow={workflow}
      id={`wf-${key}`}
      label={label}
      value={node.config[key] == null ? "" : String(node.config[key])}
      onChange={(v) => set({ [key]: opts.type === "number" ? Number(v) : v })}
      variables={isTrigger(node) ? [] : vars}
      {...opts}
    />
  );

  const choice = (key: string, label: string, options: { value: string; label: string }[]) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`wf-${key}`}>{label}</Label>
      <Select value={String(node.config[key] ?? "") || NONE} onValueChange={(v) => set({ [key]: v === NONE ? "" : v })}>
        <SelectTrigger id={`wf-${key}`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value || NONE} value={o.value || NONE}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-2">
        <NodeIcon def={def} />
        <div className="min-w-0 flex-1">
          <Input
            value={node.label}
            aria-label="Step name"
            onChange={(e) => setNode(id, node.id, { label: e.target.value })}
            onBlur={() => {
              if (isTrigger(node)) return;
              const key = keyFor(node.label, workflow.nodes.filter((n) => n.id !== node.id).map((n) => n.key));
              if (key !== node.key) setNode(id, node.id, { key });
            }}
            className="h-8 font-medium"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {isTrigger(node) ? "Start · what kicks the workflow off" : node.type === "end" ? def.subtitle : `${def.subtitle} · later steps can use its answer`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{def.description}</p>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((p, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-coral" />
              {p.text}
            </li>
          ))}
        </ul>
      )}

      <Config node={node} field={field} choice={choice} workflow={workflow} />

      {(node.type === "agent" || node.type === "tool" || (node.type === "if" && node.config.mode === "ai")) && (
        <StepModel workflow={workflow} node={node} catalog={catalog} />
      )}

      <AiHelp workflow={workflow} node={node} onSelect={onSelect} />

      <Connections workflow={workflow} node={node} onSelect={onSelect} />

      <Button
        variant="ghost"
        size="sm"
        className="w-fit text-muted-foreground hover:text-coral"
        onClick={() => {
          removeNodes(id, [node.id]);
          onSelect(null);
        }}
      >
        <Trash2Icon />
        Delete step
      </Button>
    </div>
  );
}

type FieldFn = (key: string, label: string, opts?: { multiline?: boolean; placeholder?: string; type?: string; hint?: ReactNode }) => ReactNode;
type ChoiceFn = (key: string, label: string, options: { value: string; label: string }[]) => ReactNode;

function Config({ node, field, choice, workflow }: { node: WfNode; field: FieldFn; choice: ChoiceFn; workflow: Workflow }) {
  const workspaces = useWorkspaces();
  const { settings } = useCrm();
  const c = node.config;
  const folders = [{ value: "", label: "No folder (a chat)" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))];
  switch (node.type) {
    case "manual":
      return (
        <>
          {field("input", "Test input", { multiline: true, placeholder: "Something to try it with, like a company name" })}
          <SampleButton workflowId={workflow.id} nodeId={node.id} />
        </>
      );
    case "chat":
      return (
        <>
          <p className="text-sm text-muted-foreground">
            In any chat, ask Sush to run “{workflow.name}” on something; it asks you before starting. Later steps get what you asked it to work on as
            “What it was given”.
          </p>
          {field("input", "Test input", { multiline: true })}
        </>
      );
    case "automation":
      return (
        <>
          <p className="text-sm text-muted-foreground">
            On the Automations page, make an automation and pick “Run “{workflow.name}”” as what it does. Later steps get its input as “What it was
            given”.
          </p>
          {field("input", "Test input", { multiline: true })}
        </>
      );
    case "email":
    case "calendar": {
      const readable = connectorTools().filter((t) => t.annotations?.readOnlyHint === true);
      return (
        <>
          {readable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect a {node.type === "email" ? "mail" : "calendar"} connector whose search or list tool is marked read-only. Triggers can
              only read through a connector, never act.
            </p>
          ) : (
            choice("tool", "Check with", [
              { value: "", label: "Pick a read-only tool" },
              ...readable.map((t) => ({ value: t.name, label: `${t.connector.name}: ${t.tool}` })),
            ])
          )}
          {field("args", "Arguments", {
            multiline: true,
            placeholder: node.type === "email" ? "is:unread from:billing" : "Optional",
            hint: "What to search for, in plain words (sent as the search), or the tool's own settings as JSON. Leave empty to check everything new.",
          })}
          {node.type === "calendar" &&
            choice("when", "Start", [
              { value: "starting", label: "Before an event starts" },
              { value: "ended", label: "After an event ends" },
            ])}
          {node.type === "calendar" && c.when !== "ended" && field("minutes", "Minutes before", { type: "number" })}
          {field("every", "Check every (minutes)", { type: "number", hint: "Only while Sush is open." })}
        </>
      );
    }
    case "file":
      return choice("workspaceId", "Folder", [{ value: "", label: "Pick a folder" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]);
    case "crm-event": {
      const kind = String(c.kind ?? "");
      const stages = kind === "company" ? settings.companyStages : kind === "deal" ? settings.dealStages : [];
      return (
        <>
          {choice("event", "When", [
            { value: "any", label: "Anything happens" },
            { value: "created", label: "A record is added" },
            { value: "updated", label: "A record changes" },
            { value: "stage-changed", label: "A record moves stage" },
            { value: "deleted", label: "A record is deleted" },
          ])}
          {choice("kind", "To", [
            { value: "any", label: "Any record" },
            { value: "company", label: "A company" },
            { value: "contact", label: "A contact" },
            { value: "deal", label: "A deal" },
          ])}
          {c.event === "stage-changed" &&
            stages.length > 0 &&
            choice("toStage", "Into stage", [{ value: "", label: "Any stage" }, ...stages.map((s) => ({ value: s.id, label: s.name }))])}
          {c.event === "updated" && field("field", "Only when this field changes", { placeholder: "e.g. owner, value (blank: any)" })}
        </>
      );
    }
    case "agent":
      return (
        <>
          {field("prompt", "Task", {
            multiline: true,
            placeholder: "Say what to do, in plain words. Press + Insert to add the company, a deal, or an earlier step’s answer.",
            hint: "Sush can use the web, your connectors and the CRM. It asks before risky tool calls; you answer from the run.",
          })}
          {choice("workspaceId", "Work in a folder", folders)}
          {choice("output", "Result", [
            { value: "text", label: "Text" },
            { value: "json", label: "Fields (JSON), for later steps to read" },
          ])}
        </>
      );
    case "tool": {
      const tools = connectorTools();
      return (
        <>
          {tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No connectors are connected. Connect one in Connectors, then pick its tool here.</p>
          ) : (
            choice("tool", "Tool", [{ value: "", label: "Pick a tool" }, ...tools.map((t) => ({ value: t.name, label: `${t.connector.name}: ${t.tool}` }))])
          )}
          {field("args", "With", { multiline: true, placeholder: "Describe what to look up or do; + Insert adds values from earlier", hint: "Sush fills in the tool’s settings from this." })}
        </>
      );
    }
    case "if":
      return (
        <>
          {choice("mode", "Decide by", [
            { value: "compare", label: "Comparing values" },
            { value: "ai", label: "Asking Sush (yes or no)" },
          ])}
          {c.mode === "ai" ? (
            field("question", "Question", { multiline: true, placeholder: "A yes or no question, like: is this a company with more than 500 people?" })
          ) : (
            <>
              {field("left", "Value", { placeholder: "Press + Insert to pick a value" })}
              {choice("op", "Is", [
                { value: "is", label: "equal to" },
                { value: "is-not", label: "not equal to" },
                { value: "contains", label: "containing" },
                { value: "gt", label: "more than" },
                { value: "lt", label: "less than" },
                { value: "empty", label: "empty" },
                { value: "not-empty", label: "not empty" },
              ])}
              {c.op !== "empty" && c.op !== "not-empty" && field("right", "This", { placeholder: "50000" })}
            </>
          )}
        </>
      );
    case "approval":
      return field("message", "Ask", { multiline: true, placeholder: "What to ask you, like: send the welcome email?" });
    case "parallel":
      return (
        <p className="text-sm text-muted-foreground">
          Connect this to the first step of each branch (drag from its dot, or use Connect to… below). The branches run at the same time; add a
          Wait for branches step where they should come back together.
        </p>
      );
    case "join":
      return (
        <>
          {choice("mode", "Go on when", [
            { value: "all", label: "Every branch has finished" },
            { value: "first", label: "The first branch finishes" },
          ])}
          <p className="text-xs text-muted-foreground">Steps after it get every branch's answer, under the branch's step name.</p>
        </>
      );
    case "end":
      return (
        <>
          {choice("outcome", "Finish as", [
            { value: "done", label: "Done" },
            { value: "failed", label: "Failed" },
          ])}
          {field("message", c.outcome === "failed" ? "Why" : "Message (optional)", {
            multiline: true,
            placeholder: c.outcome === "failed" ? "Like: the company is too small to qualify" : "Shown as a notification when it finishes",
          })}
        </>
      );
    case "delay":
      return field("minutes", "Minutes", { type: "number", hint: "Up to a day; Sush has to stay open." });
    case "crm-update":
      return (
        <>
          {field("record", "Record", { hint: "Which record to change. Press + Insert and pick the one that started it, or type an exact name." })}
          {field("stage", "Stage", { placeholder: "A stage name" })}
          {field("owner", "Owner")}
          {field("value", "Value", { placeholder: "A number, or + Insert a value" })}
          {field("field", "Another field", { placeholder: "Field name" })}
          {c.field ? field("fieldValue", "Set it to") : null}
        </>
      );
    case "crm-log":
      return (
        <>
          {field("record", "Record")}
          {choice("kind", "As", [
            { value: "ai", label: "Sush summary" },
            { value: "note", label: "Note" },
            { value: "call", label: "Call" },
            { value: "meeting", label: "Meeting" },
            { value: "email", label: "Email" },
          ])}
          {field("body", "Text", { multiline: true, placeholder: "What to log; + Insert adds an earlier step’s answer" })}
        </>
      );
    case "board-task":
      return (
        <>
          {field("title", "Title", { placeholder: "Like: kick off with the new customer" })}
          {field("description", "Details", { multiline: true })}
          {choice("priority", "Priority", [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ])}
        </>
      );
    case "notify":
      return (
        <>
          {field("title", "Title")}
          {field("body", "Text", { multiline: true })}
        </>
      );
    case "cowork":
      return (
        <>
          {choice("workspaceId", "Folder", folders)}
          {field("prompt", "Prompt", { multiline: true })}
        </>
      );
    default:
      return null;
  }
}

function SampleButton({ workflowId, nodeId }: { workflowId: string; nodeId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      className="w-fit"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const input = await sampleInput(workflowId);
          if (input) setNode(workflowId, nodeId, { config: { input } });
        } catch (e) {
          toast.error("Couldn’t make sample input", { description: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon className="text-brand" />}
      Make sample input
    </Button>
  );
}

/** Sush sets the step up, or suggests what could come next. */
function AiHelp({ workflow, node, onSelect }: { workflow: Workflow; node: WfNode; onSelect: (id: string | null) => void }) {
  const [busy, setBusy] = useState<"setup" | "next" | null>(null);
  const [hint, setHint] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const trigger = isTrigger(node);

  const run = async (what: "setup" | "next") => {
    setBusy(what);
    try {
      if (what === "setup") set(await setUpStep(workflow.id, node.id, hint));
      else setSuggestions(await suggestNext(workflow.id, node.id));
    } catch (e) {
      toast.error(what === "setup" ? "Couldn’t set it up" : "Couldn’t suggest steps", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const set = (config: NodeConfig) => setNode(workflow.id, node.id, { config });

  const add = (sug: Suggestion) => {
    const n = { ...newNode(sug.type, { x: node.x, y: node.y + 148 }, workflow.nodes), label: sug.label || defOf(sug.type).label };
    n.config = { ...n.config, ...sug.config };
    const port = defOf(node.type).ports[0];
    editGraph(workflow.id, (g) => ({
      nodes: [...g.nodes, n],
      edges: [...g.edges, { id: crypto.randomUUID().slice(0, 8), from: node.id, port, to: n.id }],
    }));
    setSuggestions(null);
    onSelect(n.id);
  };

  return (
    <section aria-label="Ask Sush" className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
      {!trigger && (
        <>
          <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Anything it should know (optional)" aria-label="Note for Sush" className="h-8" />
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void run("setup")}>
            {busy === "setup" ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon className="text-brand" />}
            Set up with AI
          </Button>
        </>
      )}
      {defOf(node.type).ports.length > 0 && (
      <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run("next")}>
        {busy === "next" ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
        Suggest what comes next
      </Button>
      )}
      {suggestions && suggestions.length === 0 && <p className="text-xs text-muted-foreground">No ideas this time.</p>}
      {suggestions?.map((sug, i) => (
        <button
          key={i}
          type="button"
          onClick={() => add(sug)}
          className="flex flex-col rounded-md border px-2 py-1 text-left text-sm transition-colors hover:border-brand hover:bg-brand/6"
        >
          <span className="font-medium">{sug.label}</span>
          <span className="text-xs text-muted-foreground">{sug.why}</span>
        </button>
      ))}
    </section>
  );
}

function Connections({ workflow, node, onSelect }: { workflow: Workflow; node: WfNode; onSelect: (id: string | null) => void }) {
  const ports = defOf(node.type).ports;
  const [adding, setAdding] = useState<Port | null>(null);
  const label = (p: Port) => (p === "out" ? "Then" : p === "yes" ? "If yes" : "If no");
  return (
    <section id="workflow-connections" tabIndex={-1} aria-label="Connections" className="flex flex-col gap-3 outline-none">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Connections</h3>
      {ports.map((p) => {
        const out = workflow.edges.filter((e) => e.from === node.id && e.port === p);
        const options = workflow.nodes.filter((n) => n.id !== node.id && !isTrigger(n) && !out.some((e) => e.to === n.id) && !makesCycle(workflow, node.id, n.id));
        return (
          <div key={p} className="flex flex-col gap-1">
            <span className="text-sm">{label(p)}</span>
            {out.length === 0 && <span className="text-xs text-muted-foreground">Nothing yet.</span>}
            {out.map((e) => {
              const to = workflow.nodes.find((n) => n.id === e.to);
              return (
                <div key={e.id} className="flex items-center gap-1">
                  <button type="button" onClick={() => onSelect(e.to)} className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-muted">
                    {to?.label ?? "A removed step"}
                  </button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Disconnect ${to?.label ?? "step"}`} onClick={() => removeEdge(workflow.id, e.id)}>
                    <XIcon />
                  </Button>
                </div>
              );
            })}
            {adding === p ? (
              <Select
                defaultOpen
                onOpenChange={(o) => !o && setAdding(null)}
                onValueChange={(to) => {
                  setAdding(null);
                  connect(workflow.id, node.id, p, to);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Connect to">
                  <SelectValue placeholder="Connect to…" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Button variant="ghost" size="xs" className="w-fit" disabled={options.length === 0} onClick={() => setAdding(p)}>
                Connect to…
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** A text setting: values from earlier steps show as chips and go in with "+ Insert". Numbers stay plain. */
function TextSetting({
  workflow,
  id,
  label,
  value,
  onChange,
  variables,
  multiline,
  placeholder,
  type,
  hint,
}: {
  workflow: Workflow;
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  variables: Variable[];
  multiline?: boolean;
  placeholder?: string;
  type?: string;
  hint?: ReactNode;
}) {
  const ref = useRef<TokenFieldHandle>(null);
  const labelFor = useCallback((key: string) => variableLabel(workflow, key), [workflow]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="flex-1">
          {label}
        </Label>
        {type !== "number" && <InsertMenu variables={variables} onPick={(k) => ref.current?.insert(k)} />}
      </div>
      {type === "number" ? (
        <Input id={id} type="number" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <TokenField ref={ref} id={id} value={value} onChange={onChange} labelFor={labelFor} multiline={multiline} placeholder={placeholder} aria-label={label} />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Three lines on how a workflow works, for people who've never built one. */
function HowItWorks() {
  const steps = [
    ["Start", "Something kicks it off: a deal moving stage, a new email, you pressing Run."],
    ["Steps", "Each step runs after the one it's connected from. Steps on separate branches run at the same time."],
    ["Answers flow down", "A step can use what earlier steps found: press + Insert in its text to add their answers."],
    ["End", "It finishes when every branch is done, or at an End step."],
  ];
  return (
    <section aria-label="How workflows work" className="rounded-lg bg-muted/50 p-3">
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">How it works</h3>
      <ol className="flex flex-col gap-2">
        {steps.map(([title, text], i) => (
          <li key={title} className="flex gap-2 text-sm">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/12 text-xs font-medium text-brand">{i + 1}</span>
            <span>
              <span className="font-medium">{title}.</span> <span className="text-muted-foreground">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A step's own model, or the workflow's (shown greyed) until it picks one. */
function StepModel({ workflow, node, catalog }: { workflow: Workflow; node: WfNode; catalog: ProviderModels[] }) {
  const fallback = useTarget();
  const own = stepModel(node);
  const inherited = workflow.model ?? fallback;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Label className="flex-1">Model</Label>
        {own && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setNode(workflow.id, node.id, { config: { modelProvider: "", modelName: "" } })}>
            Use the workflow's
          </Button>
        )}
      </div>
      <div className={own ? undefined : "opacity-70"}>
        <ModelPicker
          catalog={catalog}
          value={own ?? inherited}
          onChange={(t) => setNode(workflow.id, node.id, { config: { modelProvider: t.providerId, modelName: t.model } })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {own ? "This step uses its own model." : "Uses the workflow's model (set at the top). Pick one to use a different model for just this step."}
      </p>
    </div>
  );
}
