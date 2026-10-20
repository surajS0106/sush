// Sub-agents a reply started (`spawn_agent`, run by Rust on threads of their
// own: `sush_core::agent::subagents`). The calls one step made ran side by
// side, so they show as one graph: the lead (the mascot picked in Settings)
// on top, a line down to each sub-agent, each one a different sushi acting
// out what it's doing (thinking, at the laptop, writing its report). Work
// flows along a line while its agent runs. Clicking an agent opens its own
// work below the graph, where an approval it waits on can be answered; it
// opens by itself then. Clicking the lead opens its side: the thinking that
// led it to delegate, the brief and report of each agent, and what it's
// doing with them now.
//
// An agent can work in the background (the lead started it so, or you wrote
// while it worked): its call has already returned, so its state comes from
// its own thread, and its report reaches the lead later as a message, shown
// as a `SubagentReport` row.
//
// The dashed slot at the end of the row adds an agent right there: it starts
// in the background with what you typed (plus the request and what the
// others cover), and reports to the lead like any background agent.

import type { DynamicToolUIPart } from "ai";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, InboxIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ActivityGroup, groupParts } from "@/components/activity-group";
import { MessageResponse } from "@/components/ai-elements/message";
import { Mascot, MascotSprite, type MascotStage } from "@/components/mascot";
import { ToolPart } from "@/components/tool-parts";
import { SPAWN_AGENT, STOPPED, useRunningToolCalls } from "@/lib/agent";
import { AVATARS } from "@/lib/avatars";
import { DEFAULT_MASCOT, MASCOTS, useMascot } from "@/lib/mascot";
import { addAgent, respond, stop, threadMessages, toResponse, useAddedAgents, useThread, useThreadStatuses } from "@/lib/sessions";
import type { RunStatus } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";

type Part = SushUIMessage["parts"][number];

/** `groupParts`' items, with each run of `spawn_agent` calls as a team. */
export type PartItem = number | number[] | { team: number[] };

export function withTeams(items: (number | number[])[], parts: Part[]): PartItem[] {
  const out: PartItem[] = [];
  for (const item of items) {
    const p = typeof item === "number" ? parts[item] : undefined;
    if (typeof item === "number" && p?.type === "dynamic-tool" && p.toolName === SPAWN_AGENT) {
      const last = out.at(-1);
      if (typeof last === "object" && !Array.isArray(last)) last.team.push(item);
      else out.push({ team: [item] });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** The thread a call's sub-agent runs on (`sush_core::agent::subagents::child_thread_id`). */
const childThreadId = (threadId: string, callId: string) => `${threadId}:${callId}`;

type AgentState = "starting" | "working" | "needs-input" | "done" | "failed" | "stopped";

const isActive = (s: AgentState) => s === "starting" || s === "working" || s === "needs-input";
const isStop = (error: string) => error === STOPPED || error.startsWith("Interrupted") || error.startsWith("The user stopped");

/** A sub-agent's thread as `useThreadStatuses` gives it. */
type ChildStatus = RunStatus | "paused" | "";

/** What a background agent's call returned (`sush_core::agent::subagents::BACKGROUND`). */
const BACKGROUND = "Working in the background";
const inBackground = (part: DynamicToolUIPart) =>
  part.state === "output-available" && typeof part.output === "string" && part.output.startsWith(BACKGROUND);

function agentState(part: DynamicToolUIPart, child: ChildStatus, running: boolean): AgentState {
  if (inBackground(part)) {
    if (child === "awaiting") return "needs-input";
    if (child === "submitted" || child === "streaming") return "working";
    if (child === "error") return "failed";
    if (child === "paused") return "stopped";
    return child ? "done" : "starting";
  }
  if (part.state === "output-available") return "done";
  if (part.state === "output-error") return isStop(part.errorText) ? "stopped" : "failed";
  if (part.state === "input-streaming") return "starting";
  if (child === "awaiting") return "needs-input";
  if (child === "submitted" || child === "streaming") return "working";
  // Between the call starting and the sub-agent's first frame, or its last and the call's result.
  if (running) return child ? "working" : "starting";
  return "stopped";
}

/** Sushi to cast as sub-agents, in order, skipping whichever leads. */
const CREW = ["maguro", "kappa-maki", "tamago", "ebi", "onigiri", "ikura", "sake-maki", "wasabi", "inari", "temaki", "matcha", "salmon"];

function crewFor(lead: string, n: number): { kind: string; name: string }[] {
  const cast = CREW.filter((k) => k !== lead && AVATARS.some((a) => a.key === k));
  return Array.from({ length: n }, (_, i) => {
    const kind = cast[i % cast.length] ?? DEFAULT_MASCOT;
    return { kind, name: MASCOTS.find((m) => m.key === kind)?.label ?? "Sushi" };
  });
}

interface AgentInput {
  description?: string;
  prompt?: string;
}

const describe = (part: DynamicToolUIPart) => ((part.input ?? {}) as AgentInput).description || "Sub-agent";

/** Picks the lead in `AgentTeam`'s selection; agents are picked by call id. */
const LEAD = "lead";

interface AgentTeamProps {
  threadId: string;
  parts: DynamicToolUIPart[];
  /** The rest of the lead's reply: what it did before starting the agents, and after. */
  before: Part[];
  after: Part[];
  streaming: boolean;
}

/** An agent added from the graph, as if the lead had started it in the background. */
function addedPart(threadId: string, callId: string): DynamicToolUIPart {
  const first = threadMessages(childThreadId(threadId, callId)).find((m) => m.role === "user");
  const prompt = first?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") ?? "";
  const line = prompt.split("\n")[0].trim();
  const description = line.length > 60 ? `${line.slice(0, 57)}…` : line;
  return {
    type: "dynamic-tool",
    toolName: SPAWN_AGENT,
    toolCallId: callId,
    state: "output-available",
    input: { description, prompt },
    output: BACKGROUND,
  } as DynamicToolUIPart;
}

export function AgentTeam({ threadId, parts: called, before, after, streaming }: AgentTeamProps) {
  const anchor = called[0].toolCallId;
  const added = useAddedAgents(threadId, anchor);
  const parts = [...called, ...added.map((callId) => addedPart(threadId, callId))];
  const lead = useMascot();
  const running = useRunningToolCalls();
  const statuses = useThreadStatuses(parts.map((p) => childThreadId(threadId, p.toolCallId))).split(",") as ChildStatus[];
  const states = parts.map((p, i) => agentState(p, statuses[i] ?? "", running.has(p.toolCallId)));
  const crew = crewFor(lead, parts.length);
  // `undefined`: follow whichever agent needs the user; `null`: the user closed it.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const waiting = parts.find((_, i) => states[i] === "needs-input")?.toolCallId ?? null;
  const selected = picked === undefined ? waiting : picked;

  const count = (s: AgentState) => states.filter((x) => x === s).length;
  const active = states.filter(isActive).length;
  // Agents in the background don't hold the lead up.
  const waitedOn = states.filter((s, i) => isActive(s) && !inBackground(parts[i])).length;
  const behind = active - waitedOn;
  const n = parts.length;
  const agents = n === 1 ? "1 agent" : `${n} agents`;
  const title = active > 0 ? `Running ${agents}` : count("done") === n ? `${n === 1 ? "Agent" : agents} finished` : `${agents} ended`;
  const notes = [
    active > 0 && count("done") > 0 && `${count("done")} done`,
    behind > 0 && `${behind} in the background`,
    count("needs-input") > 0 && `${count("needs-input")} ${count("needs-input") === 1 ? "needs" : "need"} your input`,
    count("failed") > 0 && `${count("failed")} failed`,
    count("stopped") > 0 && `${count("stopped")} stopped`,
  ].filter((s): s is string => !!s);
  const leadNote =
    waitedOn > 0
      ? `Waiting on ${waitedOn} of ${n}`
      : streaming
        ? leadActivity(after)
        : behind > 0
          ? `${behind} working in the background`
          : "Answered";
  const leadStage: MascotStage = waitedOn > 0 ? "thinking" : currentStage({ parts: after } as SushUIMessage);
  const at = parts.findIndex((p) => p.toolCallId === selected);
  const pick = (id: string) => setPicked(selected === id ? null : id);

  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{title}</span>
        {notes.length > 0 && (
          <span className={cn("text-muted-foreground", count("needs-input") > 0 && "text-amber-600 dark:text-amber-400")}>
            · {notes.join(" · ")}
          </span>
        )}
      </div>

      <div className="overflow-x-auto pt-3 pb-1">
        <div className="mx-auto flex w-max min-w-full flex-col items-center">
          {/* The lead. */}
          <button
            type="button"
            onClick={() => pick(LEAD)}
            aria-expanded={selected === LEAD}
            className={cn(
              "flex w-44 flex-col items-center gap-1 rounded-xl border border-transparent px-2 pt-3 pb-2.5 text-center transition-colors hover:border-border hover:bg-muted/40",
              selected === LEAD && "border-foreground/30 bg-muted/40",
            )}
          >
            <div className="flex h-11 items-end">
              <Mascot kind={lead} busy={waitedOn > 0 || streaming} stage={leadStage} draft="" still />
            </div>
            <span className="text-[10px] tracking-wide text-muted-foreground uppercase">Lead</span>
            <span className="w-full truncate text-[11px] text-muted-foreground">{leadNote}</span>
          </button>
          <Line vertical tone={active > 0 ? "flow" : "rest"} className="h-4" />

          {/* A column per sub-agent, hanging off a rail. */}
          <div className="flex">
            {parts.map((p, i) => (
              <div key={p.toolCallId} className="relative flex w-44 flex-col items-center px-1.5">
                <Line tone={active > 0 ? "flow" : "rest"} className="absolute top-0" style={{ left: i === 0 ? "50%" : 0, right: 0 }} />
                <Line vertical tone={lineTone(states[i])} className="h-4" />
                <AgentNode
                  childId={childThreadId(threadId, p.toolCallId)}
                  part={p}
                  state={states[i]}
                  kind={crew[i].kind}
                  name={crew[i].name}
                  selected={selected === p.toolCallId}
                  onSelect={() => pick(p.toolCallId)}
                />
              </div>
            ))}
            <div className="relative flex w-44 flex-col items-center px-1.5">
              <Line tone="rest" className="absolute top-0" style={{ left: 0, right: "50%" }} />
              <Line vertical tone="rest" className="h-4" />
              <AddAgent threadId={threadId} anchor={anchor} others={parts.map(describe)} />
            </div>
          </div>
        </div>
      </div>

      {selected === LEAD && (
        <LeadDetail
          threadId={threadId}
          lead={lead}
          note={leadNote}
          parts={parts}
          states={states}
          crew={crew}
          before={before}
          onPick={pick}
          onClose={() => setPicked(null)}
        />
      )}
      {at >= 0 && (
        <AgentDetail
          key={parts[at].toolCallId}
          childId={childThreadId(threadId, parts[at].toolCallId)}
          part={parts[at]}
          state={states[at]}
          kind={crew[at].kind}
          name={crew[at].name}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}

/** The slot that adds an agent: asks what it should do, then starts it in the graph. */
function AddAgent({ threadId, anchor, others }: { threadId: string; anchor: string; others: string[] }) {
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState("");
  const cancel = () => {
    setEditing(false);
    setTask("");
  };
  const submit = () => {
    const text = task.trim();
    if (!text) return;
    addAgent(threadId, anchor, text, others);
    cancel();
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex w-full flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-2 py-3 text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
      >
        <PlusIcon className="size-5" />
        <span className="text-xs font-medium">Add an agent</span>
      </button>
    );
  }
  return (
    <div className="flex w-full flex-1 flex-col gap-2 rounded-xl border border-dashed border-foreground/30 bg-background p-2">
      <textarea
        autoFocus
        rows={3}
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="What should it work on?"
        className="w-full resize-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={cancel}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!task.trim()}
          className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background transition-opacity disabled:opacity-40"
        >
          Start
        </button>
      </div>
    </div>
  );
}

type Tone = "flow" | "rest" | "done" | "wait" | "fail";

function lineTone(s: AgentState): Tone {
  if (s === "working" || s === "starting") return "flow";
  if (s === "needs-input") return "wait";
  if (s === "done") return "done";
  if (s === "failed") return "fail";
  return "rest";
}

/** A connector; while work flows along it, dashes move away from the lead. */
function Line({ vertical, tone, className, style }: { vertical?: boolean; tone: Tone; className?: string; style?: React.CSSProperties }) {
  const flow = tone === "flow";
  return (
    <div
      aria-hidden
      data-flow={flow || undefined}
      className={cn(
        vertical ? "w-[1.5px] shrink-0" : "h-[1.5px]",
        tone === "rest" && "bg-border",
        tone === "done" && "bg-foreground/35",
        tone === "wait" && "bg-amber-500",
        tone === "fail" && "bg-destructive/60",
        className,
      )}
      style={{
        ...style,
        ...(flow && {
          backgroundImage: `repeating-linear-gradient(${vertical ? "to bottom" : "to right"}, var(--muted-foreground) 0 4px, transparent 4px 8px)`,
          animation: `${vertical ? "flow-down" : "flow-right"} 0.5s linear infinite`,
        }),
      }}
    />
  );
}

function AgentNode({
  childId,
  part,
  state,
  kind,
  name,
  selected,
  onSelect,
}: {
  childId: string;
  part: DynamicToolUIPart;
  state: AgentState;
  kind: string;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { messages } = useThread(childId);
  const work = messages.filter((m) => m.role === "assistant");
  const ended = state === "stopped" || state === "failed";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      className={cn(
        "flex w-full flex-1 flex-col items-center gap-1 rounded-xl border bg-background px-2 pt-3 pb-2.5 text-center transition-colors hover:bg-muted/40",
        selected && "border-foreground/30 bg-muted/40",
        state === "needs-input" && "border-amber-500/70 ring-2 ring-amber-500/20",
      )}
    >
      <div className="relative flex h-11 items-end">
        {ended ? (
          <MascotSprite kind={kind} closed className="opacity-45 grayscale" />
        ) : (
          <Mascot kind={kind} busy={isActive(state) && state !== "needs-input"} stage={currentStage(work.at(-1))} draft="" still />
        )}
        <Badge state={state} />
      </div>
      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{name}</span>
      <span className="line-clamp-2 text-xs leading-snug font-medium">{describe(part)}</span>
      <span
        className={cn(
          "w-full truncate text-[11px] text-muted-foreground",
          state === "failed" && "text-destructive",
          state === "needs-input" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {agentDetail(state, part, work)}
      </span>
    </button>
  );
}

function Badge({ state }: { state: AgentState }) {
  const base = "absolute -top-1 -right-3 flex size-4 items-center justify-center rounded-full ring-2 ring-background";
  switch (state) {
    case "done":
      return (
        <span className={cn(base, "bg-foreground text-background")}>
          <CheckIcon className="size-2.5" strokeWidth={3.5} />
        </span>
      );
    case "needs-input":
      return <span className={cn(base, "animate-bounce bg-amber-500 text-[10px] font-bold text-white")}>!</span>;
    case "failed":
      return (
        <span className={cn(base, "bg-destructive text-white")}>
          <CircleAlertIcon className="size-3" />
        </span>
      );
    default:
      return null;
  }
}

const steps = (work: SushUIMessage[]) => work.reduce((n, m) => n + m.parts.filter((p) => p.type === "dynamic-tool").length, 0);

function agentDetail(state: AgentState, part: DynamicToolUIPart, work: SushUIMessage[]): string {
  switch (state) {
    case "working":
      return currentActivity(work.at(-1));
    case "starting":
      return "Starting…";
    case "needs-input":
      return "Needs your answer";
    case "failed":
      return part.state === "output-error" ? part.errorText.split("\n")[0] : "Failed";
    case "stopped":
      return "Stopped";
    case "done": {
      const n = steps(work);
      return n > 0 ? `Done · ${n === 1 ? "1 step" : `${n} steps`}` : "Done";
    }
  }
}

/** Which act the mascot puts on, from the end of the sub-agent's reply. */
function currentStage(reply: SushUIMessage | undefined): MascotStage {
  const last = reply?.parts.findLast((p) => p.type !== "step-start");
  if (last?.type === "dynamic-tool") return "tools";
  if (last?.type === "text") return "writing";
  return "thinking";
}

const VERBS: Record<string, string> = {
  fs_list: "Listing",
  fs_glob: "Finding",
  fs_read: "Reading",
  fs_search: "Searching for",
  fs_write: "Writing",
  fs_edit: "Editing",
  fs_move: "Moving",
  fs_delete: "Deleting",
  shell_run: "Running",
  branch_status: "Checking the branch",
  git_commit: "Committing",
  browser_navigate: "Opening",
  browser_read: "Reading the page",
  browser_click: "Clicking",
  browser_type: "Typing",
  chats_search: "Searching past chats for",
  skill: "Loading skill",
};

/** What the sub-agent is doing now, from the end of its reply. */
function currentActivity(reply: SushUIMessage | undefined): string {
  const last = reply?.parts.findLast((p) => p.type !== "step-start");
  if (!last || last.type === "reasoning") return "Thinking…";
  if (last.type === "text") return "Writing its report…";
  if (last.type !== "dynamic-tool") return "Working…";
  const input = (last.input ?? {}) as Record<string, unknown>;
  const arg = ["path", "pattern", "query", "command", "url", "name", "from"].map((k) => input[k]).find((v) => typeof v === "string");
  const verb = VERBS[last.toolName] ?? `Using ${last.toolName.replace(/__/g, " · ").replace(/_/g, " ")}`;
  return arg ? `${verb} ${String(arg).split("\n")[0]}` : verb;
}

/** A finished sub-agent's report: the text of its last reply after its last tool call (`subagents::final_text`). */
function finalText(replies: SushUIMessage[]): string | null {
  const parts = replies.at(-1)?.parts ?? [];
  const tail = parts.slice(parts.findLastIndex((p) => p.type === "dynamic-tool") + 1);
  return tail.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : [])).join("\n\n") || null;
}

/** The message that brings a background agent's report to the lead: a line that opens to the report. */
export function SubagentReport({ message }: { message: SushUIMessage }) {
  const [open, setOpen] = useState(false);
  const meta = message.metadata?.subagentReport;
  if (!meta) return null;
  const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  const body = /<subagent_report[^>]*>\n?([\s\S]*?)\n?<\/subagent_report>/.exec(text)?.[1] ?? text;
  const failed = meta.status === "failed";
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground",
          failed && "text-destructive hover:text-destructive",
        )}
      >
        <InboxIcon className="size-4 shrink-0" />
        <span className="text-left">
          {failed ? "A background agent failed: " : "Report in from a background agent: "}
          <span className="font-medium text-foreground">{meta.description}</span>
        </span>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-2 ml-6 rounded-lg border bg-muted/30 p-3">
          <MessageResponse className="transcript-prose text-sm">{body}</MessageResponse>
        </div>
      )}
    </div>
  );
}

/** What the lead is doing now that its agents have reported. */
function leadActivity(after: Part[]): string {
  const last = after.findLast((p) => p.type !== "step-start");
  if (!last || last.type === "reasoning") return "Reading the reports";
  if (last.type === "text") return "Writing the answer";
  if (last.type === "dynamic-tool") return last.toolName === SPAWN_AGENT ? "Starting more agents" : currentActivity({ parts: after } as SushUIMessage);
  return "Working…";
}

/** The lead's side, under the graph: how it got here, what it handed out and got back, and what it's doing now. */
function LeadDetail({
  threadId,
  lead,
  note,
  parts,
  states,
  crew,
  before,
  onPick,
  onClose,
}: {
  threadId: string;
  lead: string;
  note: string;
  parts: DynamicToolUIPart[];
  states: AgentState[];
  crew: { kind: string; name: string }[];
  before: Part[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  // Its thinking and anything it said before handing the work out.
  const plan = before.flatMap((p) => ((p.type === "reasoning" || p.type === "text") && p.text.trim() ? [p] : []));
  return (
    <div className="mt-3 overflow-hidden rounded-xl border bg-muted/20">
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <MascotSprite kind={lead} scale={0.6} />
        <span className="font-medium">Lead</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{note}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex max-h-[32rem] flex-col gap-4 overflow-y-auto px-4 pt-3 pb-4">
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Plan</h4>
          {plan.length === 0 ? (
            <p className="text-xs text-muted-foreground">It went straight to handing out the work.</p>
          ) : (
            plan.map((p, i) =>
              p.type === "reasoning" ? (
                <p key={i} className="border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground">
                  {p.text.trim()}
                </p>
              ) : (
                <MessageResponse key={i} className="transcript-prose text-sm">
                  {p.text}
                </MessageResponse>
              ),
            )
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            Handed out to {parts.length === 1 ? "1 agent" : `${parts.length} agents`}
          </h4>
          <ul className="flex flex-col gap-2">
            {parts.map((p, i) => (
              <Delegation
                key={p.toolCallId}
                childId={childThreadId(threadId, p.toolCallId)}
                part={p}
                state={states[i]}
                kind={crew[i].kind}
                name={crew[i].name}
                onOpen={() => onPick(p.toolCallId)}
              />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/** One agent as the lead sees it: the brief it wrote, and the report it got back. */
function Delegation({
  childId,
  part,
  state,
  kind,
  name,
  onOpen,
}: {
  childId: string;
  part: DynamicToolUIPart;
  state: AgentState;
  kind: string;
  name: string;
  onOpen: () => void;
}) {
  const { messages } = useThread(childId);
  const work = messages.filter((m) => m.role === "assistant");
  const brief = ((part.input ?? {}) as AgentInput).prompt;
  const report = inBackground(part)
    ? state === "done"
      ? finalText(work)
      : null
    : part.state === "output-available"
      ? String(part.output ?? "")
      : part.state === "output-error"
        ? part.errorText
        : null;
  return (
    <li className="rounded-lg border bg-background">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <MascotSprite kind={kind} scale={0.5} closed={state === "stopped" || state === "failed"} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{describe(part)}</span>
          <span className={cn("truncate text-xs text-muted-foreground", state === "failed" && "text-destructive")}>
            {name} · {agentDetail(state, part, work)}
          </span>
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Open its work
        </button>
      </div>
      <div className="flex flex-col gap-1 border-t px-3 py-2">
        {brief && (
          <details className="group/brief text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-open/brief:rotate-90" />
              Brief
            </summary>
            <p className="mt-1.5 rounded-md bg-muted/60 p-2 whitespace-pre-wrap">{brief}</p>
          </details>
        )}
        {report ? (
          <details className="group/report text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-open/report:rotate-90" />
              {part.state === "output-error" ? "What came back" : "Report"}
            </summary>
            <div className="mt-1.5 rounded-md bg-muted/60 p-2">
              <MessageResponse className="transcript-prose text-sm">{report}</MessageResponse>
            </div>
          </details>
        ) : (
          <span className="text-xs text-muted-foreground">No report yet.</span>
        )}
      </div>
    </li>
  );
}

/** The picked agent's own work, under the graph: its task, then its replies, with any approval it waits on. */
function AgentDetail({
  childId,
  part,
  state,
  kind,
  name,
  onClose,
}: {
  childId: string;
  part: DynamicToolUIPart;
  state: AgentState;
  kind: string;
  name: string;
  onClose: () => void;
}) {
  const { messages, status } = useThread(childId);
  const replies = messages.filter((m) => m.role === "assistant");
  const last = messages.at(-1);
  const prompt = ((part.input ?? {}) as AgentInput).prompt;
  // The thread is gone (e.g. a forked session): show the report the call kept.
  const report = replies.length === 0 && part.state === "output-available" ? String(part.output ?? "") : null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border bg-muted/20">
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <MascotSprite kind={kind} scale={0.6} />
        <span className="min-w-0 truncate font-medium">{describe(part)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {name} · {agentDetail(state, part, replies)}
        </span>
        <span className="flex-1" />
        {(state === "working" || state === "needs-input") && (
          <button
            type="button"
            onClick={() => stop(childId)}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <SquareIcon className="size-3" /> Stop
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto px-4 pt-2 pb-4">
        {prompt && (
          <details className="group/task text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-open/task:rotate-90" />
              Task
            </summary>
            <p className="mt-1.5 rounded-md bg-muted/60 p-2 whitespace-pre-wrap">{prompt}</p>
          </details>
        )}
        {replies.map((m) => {
          const canAnswer = status === "awaiting" && m === last;
          const renderPart = (p: Part, i: number) => {
            const key = `${m.id}-${i}`;
            if (p.type === "text") {
              return p.text ? (
                <MessageResponse key={key} className="transcript-prose text-sm" isAnimating={status === "streaming" && m === last}>
                  {p.text}
                </MessageResponse>
              ) : null;
            }
            if (p.type !== "dynamic-tool") return null;
            return (
              <ToolPart
                key={key}
                part={p}
                canAnswer={canAnswer}
                onResult={(result) => respond(childId, p.toolCallId, toResponse(result))}
                onApprove={() => respond(childId, p.toolCallId, { type: "approve" })}
              />
            );
          };
          return groupParts(m.parts).map((item) =>
            Array.isArray(item) ? (
              <ActivityGroup key={`${m.id}-g${item[0]}`} parts={item.map((i) => m.parts[i])}>
                {item.map((i) => renderPart(m.parts[i], i))}
              </ActivityGroup>
            ) : (
              renderPart(m.parts[item], item)
            ),
          );
        })}
        {report && <MessageResponse className="transcript-prose text-sm">{report}</MessageResponse>}
        {replies.length === 0 && !report && <p className="text-xs text-muted-foreground">Nothing yet.</p>}
      </div>
    </div>
  );
}
