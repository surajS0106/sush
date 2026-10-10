// How tool calls, web activity and attachments appear inside a message.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { DynamicToolUIPart } from "ai";
import { BrainIcon, FileIcon, FolderIcon, GlobeIcon, MessagesSquareIcon, PlugIcon, ScrollTextIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AskUserCard, AskUserSummary } from "@/components/ask-user-card";
import { SkillSaveCard, ToolApprovalCard, ToolResultRow } from "@/components/tool-approval-card";
import { LoadingState } from "@/components/ui/loading-state";
import {
  CHATS_SEARCH,
  findConnectorTool,
  MEMORY_DELETE,
  runTool,
  STOPPED,
  toolKind,
  useRunningToolCalls,
  type ToolResult,
} from "@/lib/agent";
import { parseAskUserInput, type AskUserOutput } from "@/lib/ask-user";
import { allowTool } from "@/lib/library";
import { applySkillSave, parseSkillSave, skillToReplace, slugify } from "@/lib/skills";
import { getConversations } from "@/lib/store";
import { FOLDER_MEDIA_TYPE, type WebActivity } from "@/lib/transport";

interface ToolPartProps {
  part: DynamicToolUIPart;
  /** Only the latest turn's pending calls can still be answered or approved. */
  canAnswer: boolean;
  onResult: (result: ToolResult) => void;
}

export function ToolPart(props: ToolPartProps) {
  switch (toolKind(props.part.toolName)) {
    case "ask-user":
      return <AskUserPart {...props} />;
    case "memory":
      return <MemoryPart part={props.part} />;
    case "chats":
      return <ChatsPart part={props.part} />;
    case "skill":
      return <SkillPart part={props.part} />;
    case "skill-save":
      return <SkillSavePart {...props} />;
    default:
      return <ConnectorPart {...props} />;
  }
}

// --- ask_user -------------------------------------------------------------------

const DISMISSED = "The user dismissed the questions without answering. Continue with your best judgement.";

function AskUserPart({ part, canAnswer, onResult }: ToolPartProps) {
  const questions = part.state === "input-streaming" ? null : parseAskUserInput(part.input);

  // Malformed input: tell the model rather than leaving the turn hanging.
  const reported = useRef(false);
  useEffect(() => {
    if (part.state === "input-available" && !questions && canAnswer && !reported.current) {
      reported.current = true;
      onResult({ errorText: "Invalid ask_user input: expected { questions: [{ question, options[], multiSelect? }] }." });
    }
  }, [part.state, questions, canAnswer, onResult]);

  switch (part.state) {
    case "input-streaming":
      return <LoadingState label="Preparing questions" />;
    case "output-available":
      return <AskUserSummary output={part.output as AskUserOutput} />;
    case "output-error":
      return part.errorText === DISMISSED ? <AskUserSummary output={null} /> : null;
    default:
      if (!questions) return null;
      if (!canAnswer) return <p className="text-sm text-muted-foreground italic">Questions left unanswered</p>;
      return (
        <AskUserCard
          questions={questions}
          onSubmit={(output) => onResult({ output })}
          onDismiss={() => onResult({ errorText: DISMISSED })}
        />
      );
  }
}

// --- memory -----------------------------------------------------------------------

function MemoryPart({ part }: { part: DynamicToolUIPart }) {
  // `text` is the pre-files memory_save; old chats still have it.
  const input = (part.input ?? {}) as { path?: string; title?: string; text?: string };
  const removing = part.toolName === MEMORY_DELETE;
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <LoadingState label="Updating memory" />;
  }
  const what = input.title || input.path || input.text || "";
  const label = removing ? `Removed from memory: ${what}` : `Updated memory: ${what}`;
  return (
    <ToolResultRow
      error={part.state === "output-error"}
      label={
        <>
          <BrainIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{part.state === "output-error" ? `Memory: ${part.errorText}` : label}</span>
        </>
      }
    />
  );
}

// --- past chats --------------------------------------------------------------------

function ChatsPart({ part }: { part: DynamicToolUIPart }) {
  const input = (part.input ?? {}) as { query?: string; id?: string };
  const searching = part.toolName === CHATS_SEARCH;
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <LoadingState label={searching ? "Searching past chats" : "Reading a past chat"} />;
  }
  const title = getConversations().find((c) => c.id === input.id)?.title ?? "a past chat";
  const label = searching ? `Searched past chats for “${input.query ?? ""}”` : `Read ${title}`;
  return (
    <ToolResultRow
      error={part.state === "output-error"}
      detail={part.state === "output-error" ? part.errorText : searching ? String(part.output ?? "") : undefined}
      label={
        <>
          <MessagesSquareIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{label}</span>
        </>
      }
    />
  );
}

// --- skills -------------------------------------------------------------------------

function SkillPart({ part }: { part: DynamicToolUIPart }) {
  const name = String((part.input as { name?: unknown } | undefined)?.name ?? "");
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <LoadingState label="Loading skill" />;
  }
  return (
    <ToolResultRow
      error={part.state === "output-error"}
      detail={part.state === "output-error" ? part.errorText : undefined}
      label={
        <>
          <ScrollTextIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">Using skill /{slugify(name)}</span>
        </>
      }
    />
  );
}

const DISCARDED = "The user discarded this skill. Ask what they'd like changed.";

function SkillSavePart({ part, canAnswer, onResult }: ToolPartProps) {
  const input = part.state === "input-streaming" ? null : parseSkillSave(part.input);

  // Malformed input: tell the model rather than leaving the turn hanging.
  const reported = useRef(false);
  useEffect(() => {
    if (part.state === "input-available" && !input && canAnswer && !reported.current) {
      reported.current = true;
      onResult({ errorText: "Invalid skill_save input: name and instructions are required." });
    }
  }, [part.state, input, canAnswer, onResult]);

  const name = (part.input as { name?: string } | undefined)?.name ?? "skill";
  const label = (
    <>
      <ScrollTextIcon className="size-4 shrink-0" />
      <span className="line-clamp-1 text-left">
        {part.state === "output-available" ? `Saved skill /${slugify(name)}` : `Skill /${slugify(name)} not saved`}
      </span>
    </>
  );

  switch (part.state) {
    case "input-streaming":
      return <LoadingState label="Drafting skill" />;
    case "output-available":
      return <ToolResultRow label={label} />;
    case "output-error":
      return <ToolResultRow label={label} error={part.errorText !== DISCARDED} />;
    default:
      if (!input) return null;
      if (!canAnswer) return <p className="text-sm text-muted-foreground italic">Skill wasn't saved</p>;
      return (
        <SkillSaveCard
          name={input.name}
          command={slugify(input.name)}
          description={input.description}
          instructions={input.instructions}
          replaces={skillToReplace(input)?.name}
          onDiscard={() => onResult({ errorText: DISCARDED })}
          onSave={() => {
            const saved = applySkillSave(input);
            const command = slugify(saved.name);
            onResult({ output: `Saved the skill "${saved.name}". The user can run it with /${command}.` });
          }}
        />
      );
  }
}

// --- connectors --------------------------------------------------------------------

export const DENIED = "The user denied this tool call.";

function ConnectorPart({ part, canAnswer, onResult }: ToolPartProps) {
  const [running, setRunning] = useState(false);
  const inFlight = useRunningToolCalls().has(part.toolCallId);
  const found = findConnectorTool(part.toolName);
  // Saved chats can reference connectors that are gone; fall back to the raw name.
  const [connectorName, toolName] = found
    ? [found.connector.name, found.tool]
    : [part.toolName.split("__")[0], part.toolName.split("__").slice(1).join("__") || part.toolName];
  const label = (
    <>
      <PlugIcon className="size-4 shrink-0" />
      <span>
        {connectorName} · {toolName}
      </span>
    </>
  );

  switch (part.state) {
    case "input-streaming":
      return <LoadingState label={`Preparing ${toolName}`} />;
    case "output-available":
      return <ToolResultRow label={label} detail={String(part.output ?? "")} />;
    case "output-error":
      return (
        <ToolResultRow
          error={part.errorText !== DENIED && part.errorText !== STOPPED}
          label={
            <>
              {label}
              <span className="opacity-70">
                · {part.errorText === DENIED ? "denied" : part.errorText === STOPPED ? "stopped" : "failed"}
              </span>
            </>
          }
          detail={part.errorText === DENIED || part.errorText === STOPPED ? undefined : part.errorText}
        />
      );
    default:
      // Calls that need no approval are started from useChat's onToolCall.
      if (running || inFlight) {
        return <LoadingState label={`Running ${toolName}`} />;
      }
      if (!canAnswer || !found) return <p className="text-sm text-muted-foreground italic">{toolName} didn't run</p>;
      return (
        <ToolApprovalCard
          connector={connectorName}
          tool={toolName}
          description={found.spec.description.replace(/^\[[^\]]*\] /, "")}
          input={part.input}
          onDeny={() => onResult({ errorText: DENIED })}
          onAllow={(always) => {
            if (always) allowTool(found.connector.id, found.tool);
            setRunning(true);
            void runTool(part.toolName, part.input, part.toolCallId).then(onResult);
          }}
        />
      );
  }
}

// --- web research --------------------------------------------------------------------

export function WebActivityPart({ activity }: { activity: WebActivity }) {
  const input = (activity.input ?? {}) as { query?: string; url?: string };
  const what =
    activity.name === "web_search"
      ? `Searched the web${input.query ? ` for “${input.query}”` : ""}`
      : activity.name === "web_fetch"
        ? `Read ${input.url ? hostname(input.url) : "a page"}`
        : `Ran ${activity.name}`;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <GlobeIcon className="size-4 shrink-0" />
        <span className="line-clamp-1">{what}</span>
      </div>
      {activity.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-5.5">
          {activity.sources.slice(0, 8).map((s) => (
            <button
              key={s.url}
              type="button"
              title={s.url}
              onClick={() => void openUrl(s.url)}
              className="max-w-56 truncate rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {s.title || hostname(s.url)}
            </button>
          ))}
          {activity.sources.length > 8 && (
            <span className="px-1 py-0.5 text-xs text-muted-foreground">+{activity.sources.length - 8} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// --- attachments -----------------------------------------------------------------------

/** A non-image attachment: file or folder name with an icon. */
export function FileChip({ name, mediaType }: { name: string; mediaType: string }) {
  const Icon = mediaType === FOLDER_MEDIA_TYPE ? FolderIcon : FileIcon;
  return (
    <span className="inline-flex max-w-64 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </span>
  );
}
