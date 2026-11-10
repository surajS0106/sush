// The Workflows page: the list of workflows (with templates to start from),
// and one open in the editor: its name and switches on top, the canvas
// (`workflow-canvas.tsx`) in the middle, and the run panel below, where a
// run's steps show live, approvals are answered, and an agent step's work
// opens in a drawer.

import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { ChatView } from "@/components/chat-view";
import { ModelPicker } from "@/components/model-picker";
import { inOrder, NodeIcon, WorkflowEditor, type CanvasHandle } from "@/components/workflow-canvas";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import { openSettings } from "@/lib/library";
import { addSampleData, getCrm, loadCrm, newRecord, saveRecord, stagesFor } from "@/lib/crm";
import { errorMessage, type CrmKind } from "@/lib/tauri";
import { describeWorkflow, fixStep } from "@/lib/workflow-ai";
import type { ProviderModels } from "@/hooks/use-providers";
import { onAnnounce, sampleTrigger, startWorkflow } from "@/lib/workflow-engine";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow-templates";
import { useConversations, useTarget } from "@/lib/store";
import {
  createWorkflow,
  decide,
  defOf,
  deleteWorkflow,
  duplicateWorkflow,
  durationText,
  hasDraftChanges,
  providerTrouble,
  howItStarts,
  humanize,
  isTrigger,
  problems,
  publish,
  requestStop,
  restoreWorkflow,
  setNode,
  updateWorkflow,
  useWorkflowRuns,
  useWorkflows,
  whenText,
  type NodeConfig,
  type StepRun,
  type WfRun,
  type Workflow,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";

interface Props {
  catalog: ProviderModels[];
  hasProviders: boolean | null;
  onOpenSettings: () => void;
  onOpenSession: (id: string) => void;
}

export function WorkflowsPage(props: Props) {
  const all = useWorkflows();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = all.find((w) => w.id === openId);
  if (open) return <Editor key={open.id} workflow={open} onBack={() => setOpenId(null)} {...props} />;
  return <List workflows={all} onOpen={setOpenId} />;
}

// --- list ----------------------------------------------------------------------------------

function List({ workflows, onOpen }: { workflows: Workflow[]; onOpen: (id: string) => void }) {
  const runs = useWorkflowRuns();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-2 px-6 pt-6 pb-3">
        <WorkflowIcon className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
        <span className="flex-1" />
        <Button size="sm" onClick={() => onOpen(createWorkflow().id)}>
          <PlusIcon />
          New workflow
        </Button>
      </header>
      <p className="px-6 pb-4 text-sm text-muted-foreground">
        Steps that run on their own when something happens, like a deal moving stage. They run while Sush is open. For things on a schedule, use
        Automations.
      </p>

      {workflows.length > 0 && (
        <ul className="mx-6 mb-6 flex flex-col divide-y rounded-xl border bg-card">
          {workflows.map((w) => {
            const last = runs.find((r) => r.workflowId === w.id);
            const trigger = (w.live ?? w).nodes.find(isTrigger);
            return (
              <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                {trigger ? <NodeIcon def={defOf(trigger.type)} /> : <WorkflowIcon className="size-8 p-2 text-muted-foreground" />}
                <button type="button" onClick={() => onOpen(w.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-medium hover:underline">{w.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {trigger ? defOf(trigger.type).label : "No trigger"} · {w.nodes.length - 1} {w.nodes.length === 2 ? "step" : "steps"}
                    {!w.live && " · not published"}
                  </span>
                </button>
                {last && <RunBadge run={last} />}
                <AutoSwitch workflow={w} compact />
                <WorkflowMenu workflow={w} onOpen={onOpen} />
              </li>
            );
          })}
        </ul>
      )}

      <section className="px-6 pb-6" aria-label="Start from a template">
        <h2 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">{workflows.length ? "Start from a template" : "Start from one of these"}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {WORKFLOW_TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => {
                const w = createWorkflow(t.name, t.graph());
                updateWorkflow(w.id, (x) => ({ ...x, description: t.description }));
                onOpen(w.id);
              }}
              className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-brand/50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="flex items-center gap-1">
                {t.steps.map((type, i) => (
                  <NodeIcon key={i} def={defOf(type)} small />
                ))}
              </span>
              <span className="font-medium">{t.name}</span>
              <span className="text-sm text-muted-foreground">{t.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function WorkflowMenu({ workflow, onOpen }: { workflow: Workflow; onOpen: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${workflow.name} options`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onSelect={() => {
            const copy = duplicateWorkflow(workflow.id);
            if (copy) onOpen(copy.id);
          }}
        >
          <CopyIcon />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            const saved = structuredClone(workflow);
            deleteWorkflow(workflow.id);
            toast(`Deleted “${workflow.name}”`, { action: { label: "Undo", onClick: () => restoreWorkflow(saved) } });
          }}
        >
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunBadge({ run }: { run: WfRun }) {
  const text =
    run.status === "running" ? "Running" : run.status === "waiting" ? "Waiting for you" : run.status === "failed" ? "Failed" : run.status === "stopped" ? "Stopped" : "Ran";
  return (
    <span
      className={cn(
        "hidden items-center gap-1 text-xs sm:flex",
        run.status === "failed" ? "text-coral" : run.status === "running" || run.status === "waiting" ? "text-brand" : "text-muted-foreground",
      )}
    >
      {run.status === "running" && <LoaderCircleIcon className="size-3 animate-spin" />}
      {text} {whenText(run.startedAt)}
    </span>
  );
}

// --- editor --------------------------------------------------------------------------------

function Editor({ workflow, onBack, ...chat }: Props & { workflow: Workflow; onBack: () => void }) {
  const runs = useWorkflowRuns().filter((r) => r.workflowId === workflow.id);
  const [runId, setRunId] = useState<string | null>(null);
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const [stepThread, setStepThread] = useState<{ threadId: string; label: string } | null>(null);
  const [fixing, setFixing] = useState<{ nodeId: string; step: StepRun } | null>(null);
  const [said, setSaid] = useState("");
  const canvas = useRef<CanvasHandle>(null);
  const issues = problems(workflow);
  const draft = hasDraftChanges(workflow);
  const busy = run && (run.status === "running" || run.status === "waiting");
  // A new workflow opens on the describe bar.
  const [describing, setDescribing] = useState(workflow.nodes.length <= 1 && workflow.edges.length === 0);

  useEffect(() => onAnnounce(setSaid), []);

  const testRun = async () => {
    if (issues.length) {
      toast.error("Not ready to run", { description: issues[0].text });
      const first = issues.find((i) => i.nodeId);
      if (first?.nodeId) canvas.current?.select(first.nodeId);
      return;
    }
    const trigger = workflow.nodes.find(isTrigger)!;
    // An empty CRM: offer the sample data right here, then run.
    if (trigger.type === "crm-event") {
      await loadCrm();
      if (getCrm().records.length === 0) {
        toast("Your CRM is empty", {
          description: "A CRM test run needs a company, contact or deal. Add made-up sample data to try it, or add your own on the CRM page (in the sidebar).",
          duration: 15_000,
          action: {
            label: "Add sample data and run",
            onClick: () => {
              void addSampleData().then(async () => {
                await loadCrm();
                if (getCrm().records.length > 0) void testRun();
              });
            },
          },
        });
        return;
      }
      // Records, but none of the kind it listens to: offer one made for the test.
      const kind = String(trigger.config.kind ?? "");
      if (kind && kind !== "any" && !getCrm().records.some((r) => r.kind === kind)) {
        toast(`No ${kind} to test with`, {
          description: `This workflow starts on a ${kind}, and your CRM has none yet. Add a test ${kind} (you can delete it after), or add a real one on the CRM page.`,
          duration: 15_000,
          action: {
            label: `Add a test ${kind} and run`,
            onClick: () => {
              void addTestRecord(kind as CrmKind, trigger.config).then((made) => made && void testRun());
            },
          },
        });
        return;
      }
    }
    let sample: Awaited<ReturnType<typeof sampleTrigger>>;
    try {
      sample = await sampleTrigger(trigger);
    } catch (e) {
      toast.error("Nothing to test with", { description: errorMessage(e) });
      return;
    }
    const id = startWorkflow(workflow, { test: true, trigger: sample.data, reason: sample.reason });
    if (id) setRunId(id);
  };

  const doPublish = () => {
    if (issues.length) {
      toast.error("Fix these first", { description: issues.map((i) => i.text).join(" ") });
      return;
    }
    publish(workflow.id);
    toast.success(workflow.enabled ? "Published: new runs use this version" : "Published", {
      description: workflow.enabled ? undefined : "Turn it on to have it run by itself.",
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" aria-label="All workflows" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <nav aria-label="Path" className="flex min-w-0 items-center gap-1 text-sm">
          <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
            Workflows
          </button>
          <span className="text-muted-foreground">/</span>
          <input
            value={workflow.name}
            aria-label="Workflow name"
            onChange={(e) => updateWorkflow(workflow.id, (w) => ({ ...w, name: e.target.value }))}
            className="min-w-0 rounded bg-transparent px-1 font-medium outline-none hover:bg-muted focus:bg-muted"
          />
          <span
            className={cn("rounded-full px-2 py-0.5 text-xs", workflow.live && !draft ? "bg-brand/12 text-brand" : "bg-muted text-muted-foreground")}
            title={workflow.live ? `Published ${whenText(workflow.live.at)}` : undefined}
          >
            {!workflow.live ? "Draft" : draft ? "Unpublished changes" : "Published"}
          </span>
        </nav>
        <span className="flex-1" />
        <AutoSwitch workflow={workflow} />
        <WorkflowModel workflow={workflow} catalog={chat.catalog} />
        {!describing && (
          <Button variant="ghost" size="sm" onClick={() => setDescribing(true)}>
            <SparklesIcon className="text-brand" />
            Build with AI
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void testRun()} disabled={!!busy && run?.test}>
          <PlayIcon />
          Test run
        </Button>
        <Button size="sm" onClick={doPublish} disabled={!draft}>
          <UploadIcon />
          Publish
        </Button>
      </header>

      {describing && <DescribeBar workflow={workflow} onClose={() => setDescribing(false)} onDone={() => requestAnimationFrame(() => canvas.current?.fit())} />}

      <WorkflowEditor
        ref={canvas}
        workflow={workflow}
        catalog={chat.catalog}
        run={run}
        onOpenStep={(nodeId) => {
          const step = run?.steps[nodeId];
          const node = workflow.nodes.find((n) => n.id === nodeId);
          if (step?.threadId && node) setStepThread({ threadId: step.threadId, label: node.label });
        }}
      />

      <RunPanel
        workflow={workflow}
        runs={runs}
        run={run}
        onPickRun={setRunId}
        onOpenThread={(threadId, label) => setStepThread({ threadId, label })}
        onFocusStep={(id) => canvas.current?.select(id)}
        onFix={(nodeId, step) => setFixing({ nodeId, step })}
      />

      <FixDialog workflow={workflow} fixing={fixing} onClose={() => setFixing(null)} />

      <p aria-live="polite" className="sr-only">
        {said}
      </p>

      <StepSheet thread={stepThread} onClose={() => setStepThread(null)} {...chat} />
    </div>
  );
}

// --- run panel -------------------------------------------------------------------------------

function RunPanel({
  workflow,
  runs,
  run,
  onPickRun,
  onOpenThread,
  onFocusStep,
  onFix,
}: {
  workflow: Workflow;
  runs: WfRun[];
  run?: WfRun;
  onPickRun: (id: string) => void;
  onOpenThread: (threadId: string, label: string) => void;
  onFocusStep: (nodeId: string) => void;
  onFix: (nodeId: string, step: StepRun) => void;
}) {
  const [height, setHeight] = useState(220);
  const [tab, setTab] = useState<"steps" | "history">("steps");
  const [openStep, setOpenStep] = useState<string | null>(null);

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = height;
    const move = (ev: PointerEvent) => setHeight(Math.min(window.innerHeight * 0.7, Math.max(44, start - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const nodes = inOrder(workflow.nodes);
  const total = run?.endedAt ? run.endedAt - run.startedAt : null;

  return (
    <section aria-label="Runs" className="relative flex shrink-0 flex-col border-t bg-background" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the run panel"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setHeight((h) => Math.min(window.innerHeight * 0.7, h + 24));
          if (e.key === "ArrowDown") setHeight((h) => Math.max(44, h - 24));
        }}
        className="absolute -top-1 right-0 left-0 h-2 cursor-row-resize focus-visible:bg-brand/30"
      />
      <div className="flex items-center gap-1 border-b px-3" role="tablist">
        {(["steps", "history"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("relative px-3 py-2 text-sm text-muted-foreground hover:text-foreground", tab === t && "text-foreground")}
          >
            {t === "steps" ? "Run" : `History${runs.length ? ` (${runs.length})` : ""}`}
            {tab === t && <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
          </button>
        ))}
        <span className="flex-1" />
        {run && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="hidden truncate sm:inline">{run.reason}</span>
            {run.test && <span className="rounded bg-muted px-1">Test</span>}
            <RunBadge run={run} />
            {total != null && <span className="tabular-nums">{durationText(total)}</span>}
            {(run.status === "running" || run.status === "waiting") && (
              <Button variant="ghost" size="xs" onClick={() => requestStop(run.id)}>
                <SquareIcon />
                Stop
              </Button>
            )}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "history" ? (
          runs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="divide-y">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPickRun(r.id);
                      setTab("steps");
                    }}
                    className={cn("flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/50", r.id === run?.id && "bg-muted/50")}
                  >
                    <span className="min-w-0 flex-1 truncate">{r.reason}</span>
                    {r.test && <span className="rounded bg-muted px-1 text-xs text-muted-foreground">Test</span>}
                    <RunBadge run={r} />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : !run ? (
          <p className="p-4 text-sm text-muted-foreground">Press Test run to try it with a sample. Each step’s result shows here.</p>
        ) : (
          <ol className="flex flex-col">
            {run.error && <li className="px-4 py-2 text-sm text-coral">{run.error}</li>}
            {nodes.map((n) => {
              const step = run.steps[n.id];
              if (!step) return null;
              const expanded = openStep === n.id;
              return (
                <li key={n.id} className="border-b last:border-b-0">
                  <div className="flex items-center gap-3 px-4 py-2 text-sm">
                    <StepIcon step={step} />
                    <button
                      type="button"
                      onClick={() => {
                        setOpenStep(expanded ? null : n.id);
                        onFocusStep(n.id);
                      }}
                      className={cn("min-w-0 flex-1 truncate text-left", step.status === "skipped" && "text-muted-foreground")}
                    >
                      {n.label}
                      {step.waitingFor && <span className="ml-2 text-xs text-brand">{step.waitingFor}</span>}
                      {step.status === "failed" && step.error && <span className="ml-2 text-xs text-coral">{step.error}</span>}
                    </button>
                    {step.status === "waiting" && n.type === "approval" && (
                      <>
                        <Button size="xs" variant="outline" onClick={() => decide(run.id, n.id, false)}>
                          No
                        </Button>
                        <Button size="xs" onClick={() => decide(run.id, n.id, true)}>
                          Approve
                        </Button>
                      </>
                    )}
                    {step.status === "failed" && (
                      <Button size="xs" variant="outline" onClick={() => onFix(n.id, step)}>
                        <SparklesIcon className="text-brand" />
                        Fix
                      </Button>
                    )}
                    {step.threadId && (
                      <Button size="xs" variant={step.status === "waiting" ? "default" : "ghost"} onClick={() => onOpenThread(step.threadId!, n.label)}>
                        {step.status === "waiting" ? "Review" : "Open"}
                      </Button>
                    )}
                    {step.endedAt && step.startedAt && <span className="text-xs text-muted-foreground tabular-nums">{durationText(step.endedAt - step.startedAt)}</span>}
                  </div>
                  {expanded && (step.input || step.output) && (
                    <div className="grid gap-2 px-4 pb-3 sm:grid-cols-2">
                      {step.input && <Detail title="Given">{step.input}</Detail>}
                      {step.output && <Detail title="Result">{step.output}</Detail>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

function Detail({ title, children }: { title: string; children: string }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs text-muted-foreground">{title}</h4>
      <pre className="max-h-48 overflow-auto rounded-lg bg-muted/60 p-2 text-xs whitespace-pre-wrap">{children}</pre>
    </div>
  );
}

function StepIcon({ step }: { step: StepRun }) {
  switch (step.status) {
    case "running":
      return <LoaderCircleIcon aria-label="Running" className="size-4 shrink-0 animate-spin text-brand" />;
    case "waiting":
      return <span aria-label="Waiting" className="size-4 shrink-0 rounded-full border-2 border-dashed border-brand" />;
    case "done":
      return <CheckIcon aria-label="Done" className="size-4 shrink-0 text-brand" />;
    case "failed":
      return <CircleAlertIcon aria-label="Failed" className="size-4 shrink-0 text-coral" />;
    default:
      return <span aria-label={step.status} className="size-4 shrink-0 rounded-full border-2 border-muted" />;
  }
}

/** An agent or tool step's work, in a drawer, where its tool approvals are answered. */
function StepSheet({ thread, onClose, catalog, hasProviders, onOpenSettings, onOpenSession }: Props & { thread: { threadId: string; label: string } | null; onClose: () => void }) {
  const conversations = useConversations();
  const conversation = thread ? conversations.find((c) => c.id === thread.threadId) : undefined;
  return (
    <Sheet open={!!thread} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{thread?.label}</SheetTitle>
          <SheetDescription>This step’s work. Answer its approvals here; the run carries on.</SheetDescription>
        </SheetHeader>
        {conversation ? (
          <PromptInputProvider key={conversation.id}>
            <ChatView conversation={conversation} catalog={catalog} hasProviders={hasProviders} onOpenSettings={onOpenSettings} onOpenSession={onOpenSession} />
          </PromptInputProvider>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">This step’s chat is gone.</p>
        )}
      </SheetContent>
    </Sheet>
  );
}

// --- AI --------------------------------------------------------------------------------------

/** "Describe what it should do": builds the workflow, or changes the one there. */
function DescribeBar({ workflow, onClose, onDone }: { workflow: Workflow; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const blank = workflow.nodes.length <= 1 && workflow.edges.length === 0;
  const go = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const { name, summary } = await describeWorkflow(workflow.id, text.trim());
      if (name && workflow.name === "Untitled workflow") updateWorkflow(workflow.id, (w) => ({ ...w, name, description: w.description || text.trim() }));
      toast.success(blank ? "Built it" : "Changed it", { description: `${summary} ⌘Z undoes it.` });
      setText("");
      onDone();
      onClose();
    } catch (e) {
      toast.error("Couldn’t build that", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-start gap-2 border-b bg-brand/4 px-4 py-2">
      <SparklesIcon className="mt-2 size-4 shrink-0 text-brand" />
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void go();
          }
          if (e.key === "Escape") onClose();
        }}
        rows={1}
        placeholder={
          blank
            ? "Describe it: “When a deal is won, research the company, log notes on the deal and add a kickoff task”"
            : "Change it: “add an approval before the task”"
        }
        aria-label="Describe the workflow"
        className="min-h-9 flex-1 resize-none bg-background"
      />
      <Button size="sm" className="mt-0.5" disabled={!text.trim() || busy} onClick={() => void go()}>
        {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
        {busy ? "Building" : blank ? "Build" : "Change"}
      </Button>
      <Button variant="ghost" size="sm" className="mt-0.5" onClick={onClose} disabled={busy}>
        {blank ? "I’ll build it myself" : "Cancel"}
      </Button>
    </div>
  );
}

/** A failed step: Sush works out why and proposes its settings, to apply or not. */
function FixDialog({ workflow, fixing, onClose }: { workflow: Workflow; fixing: { nodeId: string; step: StepRun } | null; onClose: () => void }) {
  const [result, setResult] = useState<{ config: NodeConfig; why: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const node = fixing ? workflow.nodes.find((n) => n.id === fixing.nodeId) : undefined;
  // The provider's account or connection: nothing in the step to fix, and asking the model would fail the same way.
  const trouble = fixing ? providerTrouble(fixing.step.errorDetail ?? fixing.step.error) : null;

  useEffect(() => {
    setResult(null);
    setError(null);
    if (!fixing || trouble) return;
    let live = true;
    fixStep(workflow.id, fixing.nodeId, fixing.step)
      .then((r) => live && setResult(r))
      .catch((e) => live && setError(providerTrouble(errorMessage(e))?.text ?? errorMessage(e)));
    return () => {
      live = false;
    };
  }, [fixing, workflow.id, trouble]);

  if (!fixing || !node) return null;
  const changed = result ? Object.keys({ ...node.config, ...result.config }).filter((k) => String(node.config[k] ?? "") !== String(result.config[k] ?? "")) : [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix “{node.label}”</DialogTitle>
          <DialogDescription className={trouble ? undefined : "text-coral"}>{trouble ? "This isn't a problem with the step." : fixing.step.error}</DialogDescription>
        </DialogHeader>
        {trouble && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{trouble.text}</p>
            <p className="text-sm text-muted-foreground">
              Pick another model at the top of the editor (next to Build with AI), then Test run again.
            </p>
            {fixing.step.errorDetail && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">What the provider said</summary>
                <p className="mt-1 break-words">{fixing.step.errorDetail}</p>
              </details>
            )}
          </div>
        )}
        {!trouble && !result && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Working out what went wrong
          </p>
        )}
        {error && <p className="text-sm text-coral">{error}</p>}
        {result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{result.why}</p>
            {changed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Its settings look right; the fix is outside the step.</p>
            ) : (
              <dl className="flex flex-col gap-2 text-xs">
                {changed.map((k) => (
                  <div key={k} className="rounded-lg border p-2">
                    <dt className="mb-1 font-medium">{k}</dt>
                    <dd className="text-muted-foreground line-through">{humanize(workflow, String(node.config[k] ?? "")) || "empty"}</dd>
                    <dd className="whitespace-pre-wrap">{humanize(workflow, String(result.config[k] ?? "")) || "empty"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {trouble && (
            <Button
              onClick={() => {
                onClose();
                openSettings({ section: "providers" });
              }}
            >
              Open model settings
            </Button>
          )}
          {result && changed.length > 0 && (
            <Button
              onClick={() => {
                setNode(workflow.id, node.id, { config: result.config });
                toast.success("Applied", { description: "Test run again to check it. ⌘Z undoes it." });
                onClose();
              }}
            >
              Apply fix
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Runs by itself": whether the workflow starts on its own when its trigger
 * happens (a CRM change, an email, a meeting, a folder). Only those triggers
 * get it; workflows started by hand, from a chat or from an automation start
 * whenever they're asked, so they say that instead.
 */
function AutoSwitch({ workflow, compact }: { workflow: Workflow; compact?: boolean }) {
  const how = howItStarts(workflow);
  if (!how.self) return compact ? null : <span className="text-sm text-muted-foreground">{how.text}</span>;
  const published = !!workflow.live;
  const explain = !published
    ? "Publish it first. After that, turn this on and it starts by itself whenever its trigger happens."
    : workflow.enabled
      ? `On: it starts by itself on “${how.text}”, while Sush is open. Turn off to pause it; Test run still works.`
      : `Off: it won't start by itself. Turn on to have it run on “${how.text}”, while Sush is open.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={workflow.enabled}
            disabled={!published}
            aria-label={`${workflow.name}: runs by itself`}
            onCheckedChange={(enabled) => {
              updateWorkflow(workflow.id, (w) => ({ ...w, enabled }));
              toast(enabled ? `“${workflow.name}” is on` : `“${workflow.name}” is paused`, {
                description: enabled ? `It starts by itself on “${how.text}”, while Sush is open.` : "It won't start by itself until you turn it back on.",
              });
            }}
          />
          {!compact && (published ? (workflow.enabled ? "Runs by itself" : "Paused") : "Publish to turn on")}
        </label>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{explain}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A record of `kind` made for a test run, linked to the CRM's first company and
 * contact, in the stage the trigger waits for. It's real (a test run's CRM
 * steps need a real record), so its notes say what it's for.
 */
async function addTestRecord(kind: CrmKind, config: NodeConfig) {
  const { records, settings } = getCrm();
  const company = records.find((r) => r.kind === "company");
  const contact = records.find((r) => r.kind === "contact" && (!company || r.companyId === company.id));
  const stages = stagesFor(settings, kind);
  const stage = String(config.toStage ?? "") || stages[0]?.id;
  const notes = "Made for a workflow test run. Delete it whenever you like.";
  const made =
    kind === "deal"
      ? newRecord("deal", { name: `Test deal${company ? ` with ${company.name}` : ""}`, companyId: company?.id, contactId: contact?.id, stage, value: 10000, notes })
      : kind === "contact"
        ? newRecord("contact", { name: "Test contact", companyId: company?.id, email: "test@example.com", notes })
        : newRecord("company", { name: "Test company", domain: "example.com", stage, notes });
  const saved = await saveRecord(made);
  if (saved) toast.success(`Added “${saved.name}”`, { description: "It's on the CRM page; delete it after testing if you like." });
  return saved;
}

/**
 * The model the workflow's AI steps (and Fix, Build with AI…) use. Until one is
 * picked it follows the default model, the one picked last in a chat.
 */
function WorkflowModel({ workflow, catalog }: { workflow: Workflow; catalog: ProviderModels[] }) {
  const fallback = useTarget();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1">
          <ModelPicker
            catalog={catalog}
            value={workflow.model ?? fallback}
            onChange={(model) => updateWorkflow(workflow.id, (w) => ({ ...w, model }))}
          />
          {workflow.model && (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => updateWorkflow(workflow.id, (w) => ({ ...w, model: undefined }))}>
              Use default
            </Button>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {workflow.model
          ? "This workflow's AI steps use this model, whatever you pick in chats. A step can still pick its own."
          : "AI steps use your default model (the one picked last in a chat). Pick one here to keep this workflow on it."}
      </TooltipContent>
    </Tooltip>
  );
}
