import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  PencilIcon,
  RefreshCcwIcon,
  SettingsIcon,
  Undo2Icon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { ActivityGroup, groupParts } from "@/components/activity-group";
import { ArtifactPart, citationComponents, CitedSourceList } from "@/components/artifact-sources";
import { Composer } from "@/components/composer";
import { Logo } from "@/components/model-picker";
import { ModelPicker } from "@/components/model-picker";
import { FileChip, ToolPart, WebActivityPart } from "@/components/tool-parts";
import { CoworkPanel } from "@/components/workspace-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { SourcesProvider } from "@/components/ui/Sources";
import { Suggestion } from "@/components/ui/Suggestion";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderModels } from "@/hooks/use-providers";
import type { ToolResult } from "@/lib/agent";
import { ARTIFACT_WRITE, artifactViews, type ArtifactView } from "@/lib/artifacts";
import { useSession } from "@/lib/auth";
import { citedSources, stripCitations } from "@/lib/citations";
import { usePrefs } from "@/lib/library";
import { modelLogo, providerLogo } from "@/lib/logos";
import { mentionSegments } from "@/lib/mentions";
import { parseSlash } from "@/lib/skills";
import { formatCost, isLocalUrl } from "@/lib/pricing";
import {
  clearError,
  editMessage,
  regenerate,
  respond,
  sendMessage,
  sessionTarget,
  setSessionResearch,
  setSessionTarget,
  stop,
  toResponse,
  useThread,
} from "@/lib/sessions";
import { setTarget, type Conversation as StoredConversation } from "@/lib/store";
import { errorMessage, type Workspace } from "@/lib/tauri";
import { storeAttachments, type ModelTarget, type SushUIMessage } from "@/lib/transport";
import { CurrentWorkspace, undoTurn, useTurnChanges, useWorkspace } from "@/lib/workspaces";

interface ChatViewProps {
  conversation: StoredConversation;
  catalog: ProviderModels[];
  /** Whether any provider is configured; `null` while that's still loading. */
  hasProviders: boolean | null;
  onOpenSettings: () => void;
}

export function ChatView({ conversation, catalog, hasProviders, onOpenSettings }: ChatViewProps) {
  const id = conversation.id;
  // The run lives in Rust, so it keeps going when another chat is opened.
  const { messages, status: runStatus, error } = useThread(id);

  const [target, setLocalTarget] = useState<ModelTarget | null>(() => sessionTarget(id));
  const pickModel = (t: ModelTarget) => {
    setSessionTarget(id, t);
    setLocalTarget(t);
    setTarget(t);
  };
  const prefs = usePrefs();
  const { data: session } = useSession();
  const firstName = session?.user.name?.trim().split(/\s+/)[0];
  // Research uses Anthropic's server-side web tools, so only Claude providers get it.
  const researchAvailable = catalog.find((c) => c.provider.id === target?.providerId)?.provider.format === "anthropic-messages";
  setSessionResearch(id, prefs.research && researchAvailable);

  // `streaming` also covers tools running between model steps.
  const busy = runStatus === "submitted" || runStatus === "streaming";
  const status = runStatus === "awaiting" ? "ready" : runStatus;

  // Cowork: the folder this session works in, and the files each turn changed.
  const workspaceId = conversation.workspaceId;
  const workspace = useWorkspace(workspaceId);
  const turnChanges = useTurnChanges(id, !!workspaceId && !busy);
  const changedPaths = useMemo(() => new Set([...turnChanges.values()].flat()), [turnChanges]);
  // Each assistant message belongs to the turn its preceding user message started.
  const turnOf = useMemo(() => {
    const turns = new Map<string, string>();
    let user: string | undefined;
    for (const m of messages) {
      if (m.role === "user") user = m.id;
      else if (user) turns.set(m.id, user);
    }
    return turns;
  }, [messages]);
  const undo = (turnId: string, files: string[]) => {
    if (!workspaceId) return;
    const many = files.length === 1 ? "1 file" : `${files.length} files`;
    if (!window.confirm(`Put back ${many} as they were before this turn? Changes from later turns to the same files are undone too.`)) return;
    undoTurn(id, workspaceId, turnId)
      .then((r) => {
        if (r.failed.length > 0) toast.error(`Couldn’t restore ${r.failed.length} file(s)`, { description: r.failed.join("\n") });
        else toast.success(`Restored ${r.restored.length === 1 ? "1 file" : `${r.restored.length} files`}`);
      })
      .catch((e) => toast.error(errorMessage(e)));
  };
  const panel = workspace ? <CoworkPanel workspace={workspace} changed={changedPaths} /> : null;

  const submit = (msg: PromptInputMessage) => {
    if (!msg.text.trim() && msg.files.length === 0) return;
    void storeAttachments(msg.files).then((files) => sendMessage(id, msg.text, files));
  };

  // Replacing a user message drops everything after it and asks the model again.
  // Attachments on the original message are kept.
  const edit = (message: SushUIMessage, text: string) => {
    const files = message.parts.filter((p) => p.type === "file");
    editMessage(id, message.id, text, files);
  };

  // Providers served from this machine (Ollama, LM Studio) cost nothing per token.
  const localProviders = useMemo(
    () => new Set(catalog.filter((c) => isLocalUrl(c.provider.baseUrl)).map((c) => c.provider.id)),
    [catalog],
  );

  // Small local models (e.g. gemma3:1b on Ollama) reject any request that carries tools.
  const toolsUnsupported = !!error && isToolsUnsupported(error);
  const [dismissedError, setDismissedError] = useState<string | undefined>();
  const retryWith = (t: ModelTarget) => {
    pickModel(t);
    clearError(id);
    regenerate(id);
  };

  // Each artifact card shows its versions up to that call, so the history is built from the whole chat.
  const artifacts = useMemo(() => artifactViews(messages), [messages]);

  const lastAssistantId = messages.findLast((m) => m.role === "assistant")?.id;
  // Waiting for the first token: nothing visible has arrived yet.
  const last = messages.at(-1);
  const waiting = busy && (last?.role !== "assistant" || !hasVisibleContent(last) || endsWithToolResult(last));

  const composer = (
    <Composer
      catalog={catalog}
      target={target}
      onPickModel={pickModel}
      status={status}
      onSubmit={submit}
      onStop={() => stop(id)}
      onOpenSettings={onOpenSettings}
      researchAvailable={researchAvailable}
      messages={messages}
    />
  );

  if (messages.length === 0) {
    const start = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-[10vh]">
        <div className="w-full max-w-2xl">
          {hasProviders === null ? null : hasProviders ? (
            <h1 className="mb-7 text-center text-[28px] font-medium tracking-tight">
              {workspaceId ? `What should we work on${workspace ? ` in ${workspace.name}` : ""}?` : greeting(firstName)}
            </h1>
          ) : (
            <div className="mb-7 flex flex-col items-center gap-3 text-center">
              <h1 className="text-[28px] font-medium tracking-tight">Connect a model to get started</h1>
              <p className="max-w-md text-sm text-muted-foreground">
                Add OpenAI, Anthropic, Azure Foundry, a local Ollama server, or any compatible endpoint.
              </p>
              <Button variant="outline" className="rounded-full" onClick={onOpenSettings}>
                <SettingsIcon /> Open settings
              </Button>
            </div>
          )}
          {composer}
          {hasProviders && (
            <Suggestion
              label="Try asking"
              className="mt-5 w-full px-2"
              suggestionSets={workspaceId ? COWORK_SUGGESTIONS : SUGGESTIONS}
              onSelect={(text) => submit({ text, files: [] })}
            />
          )}
        </div>
      </div>
    );
    return (
      <WorkspaceFrame workspace={workspace} panel={panel}>
        {start}
      </WorkspaceFrame>
    );
  }

  const chat = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-(--transcript-width) px-6 py-8">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              streaming={busy && message.id === messages.at(-1)?.id}
              local={localProviders.has(message.metadata?.providerId ?? "")}
              logo={messageLogo(message, catalog)}
              canRegenerate={!busy && message.id === lastAssistantId}
              onRegenerate={() => regenerate(id, message.id)}
              canEdit={!busy}
              onEdit={(text) => edit(message, text)}
              // Only the latest turn's questions can still be answered.
              canAnswer={!busy && message.id === last?.id}
              onToolResult={(callId, result) => respond(id, callId, toResponse(result))}
              onApprove={(callId) => respond(id, callId, { type: "approve" })}
              artifacts={artifacts}
              changedFiles={busy ? undefined : turnChanges.get(turnOf.get(message.id) ?? "")}
              onUndo={() => {
                const turnId = turnOf.get(message.id);
                const files = turnId ? turnChanges.get(turnId) : undefined;
                if (turnId && files) undo(turnId, files);
              }}
            />
          ))}
          {waiting && (
            <Message from="assistant">
              <LoadingState label="Thinking" />
            </Message>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{toolsUnsupported ? "This model can’t use tools" : "Request failed"}</AlertTitle>
              <AlertDescription className="break-words">
                {toolsUnsupported
                  ? `${target?.model ?? "The selected model"} doesn’t support tool calling, which Sush needs for skills, memory and connectors. Switch to a different model and try again.`
                  : error}
              </AlertDescription>
            </Alert>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-(--transcript-width) px-6 pb-6">{composer}</div>

      <Dialog
        open={toolsUnsupported && dismissedError !== error}
        onOpenChange={(open) => !open && setDismissedError(error)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <WrenchIcon className="size-4 text-destructive" /> Switch to a model that supports tools
            </DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{target?.model ?? "This model"}</span> doesn’t support
              tool calling, so it can’t run skills, memory or connectors. Pick another model and your message will be
              sent again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border p-1">
            <ModelPicker catalog={catalog} value={target} onChange={retryWith} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissedError(error)}>
              Not now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
  return (
    <WorkspaceFrame workspace={workspace} panel={panel}>
      {chat}
    </WorkspaceFrame>
  );
}

interface WorkspaceFrameProps {
  workspace: Workspace | null;
  /** The Cowork side panel (files, terminal), or nothing for a plain chat. */
  panel: React.ReactNode;
  children: React.ReactNode;
}

/** Puts a Cowork session's side panel beside the chat; tool cards read the workspace from here. */
function WorkspaceFrame({ workspace, panel, children }: WorkspaceFrameProps) {
  return (
    <CurrentWorkspace.Provider value={workspace}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {panel}
      </div>
    </CurrentWorkspace.Provider>
  );
}

/** Matches the errors providers return when a model was sent tools it can't call. */
function isToolsUnsupported(message: string) {
  return /(does not|doesn['’]t) support tools|tools? (are |is )?not supported|does not support (function|tool) calling/i.test(
    message,
  );
}

function greeting(name?: string, hour = new Date().getHours()) {
  const to = name ? `, ${name}` : "";
  if (hour < 5) return `Burning the midnight oil${to}?`;
  if (hour < 12) return `Good morning${to}. What’s on your mind?`;
  if (hour < 17) return `Good afternoon${to}. What’s on your mind?`;
  if (hour < 22) return `Good evening${to}. What’s on your mind?`;
  return `Late night${to}? Let’s think it through.`;
}

// Starter prompts under the empty-state composer. Each is complete, so picking
// one sends it; the shuffle button cycles between sets.
/** Starters for a Cowork session, about the folder it works in. */
const COWORK_SUGGESTIONS = [
  [
    "Explain how this folder is organised",
    "Find the TODOs and summarise them",
    "Write a README for this project",
    "Run the tests and fix what fails",
  ],
  [
    "What does this project do?",
    "Look for bugs in the most recently changed files",
    "Tidy up the formatting of the docs",
    "List the dependencies and what each is for",
  ],
];

const SUGGESTIONS = [
  [
    "Plan a relaxed 3-day trip to Kyoto",
    "Explain how vaccines train the immune system",
    "Write a polite follow-up email after an interview",
    "Give me a 20-minute bodyweight workout",
  ],
  [
    "Draft a README for a small command-line tool",
    "Teach me SQL joins with a simple example",
    "Help me name a cozy coffee shop",
    "Summarise the trade-offs of remote work",
  ],
  [
    "Write a cover letter template I can reuse",
    "What's the difference between TCP and UDP?",
    "Make a weekly vegetarian meal plan",
    "Write a regex that matches ISO dates",
  ],
];

/** A user message; a leading `/skill` and `@connector` mentions show as chips. */
function UserText({ text }: { text: string }) {
  const slash = parseSlash(text);
  const rest = slash ? slash.args : text;
  return (
    <p className="whitespace-pre-wrap">
      {slash && (
        <span className="mr-1.5 rounded-md bg-brand/10 px-1.5 py-0.5 font-medium text-brand">/{slash.command.name}</span>
      )}
      {mentionSegments(rest).map((s, i) =>
        s.connector ? (
          <span key={i} className="rounded-md bg-brand/10 px-1 py-0.5 font-medium text-brand">
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </p>
  );
}

interface ChatMessageProps {
  message: SushUIMessage;
  streaming: boolean;
  /** Whether the message came from a provider running on this machine. */
  local: boolean;
  logo?: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
  canEdit: boolean;
  onEdit: (text: string) => void;
  canAnswer: boolean;
  /** A waiting tool call answered in its card (ask_user, skill_save, a denial). */
  onToolResult: (toolCallId: string, result: ToolResult) => void;
  /** A waiting connector call the user allowed; Rust runs it. */
  onApprove: (toolCallId: string) => void;
  artifacts: Map<string, ArtifactView>;
  /** Cowork: files this turn changed, which "Undo" puts back. */
  changedFiles?: string[];
  onUndo: () => void;
}

/** True once a tool call has its result and the model hasn't replied to it yet. */
function endsWithToolResult(message: SushUIMessage) {
  const lastPart = message.parts.findLast((p) => p.type !== "step-start");
  return lastPart?.type === "dynamic-tool" && (lastPart.state === "output-available" || lastPart.state === "output-error");
}

function hasVisibleContent(message: SushUIMessage) {
  return message.parts.some(
    (p) =>
      (p.type === "text" && p.text) ||
      (p.type === "reasoning" && p.text) ||
      p.type === "file" ||
      p.type === "dynamic-tool" ||
      p.type === "data-web",
  );
}

/** Inline editor that replaces a user message's bubble. */
function UserTextEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const save = () => {
    if (draft.trim()) onSave(draft);
  };
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg bg-secondary p-3">
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
        className="max-h-80 min-h-12 resize-none border-none bg-transparent p-1 font-(family-name:--transcript-font) text-(length:--transcript-text) shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={!draft.trim() || draft === initial}>
          Send
        </Button>
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  streaming,
  local,
  logo,
  canRegenerate,
  onRegenerate,
  canEdit,
  onEdit,
  canAnswer,
  onToolResult,
  onApprove,
  artifacts,
  changedFiles,
  onUndo,
}: ChatMessageProps) {
  const [editing, setEditing] = useState(false);
  // Web pages the reply cites inline, numbered by first citation.
  const sources = useMemo(() => (message.role === "assistant" ? citedSources(message) : []), [message]);
  const sourceKey = sources.map((s) => s.url).join("\n");
  // Stable while the cited pages stay the same, so streamed text doesn't re-create the renderers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const markdownComponents = useMemo(() => citationComponents(sources), [sourceKey]);
  // Failed or aborted turns can leave an assistant message with no content.
  if (!hasVisibleContent(message)) return null;
  const text = stripCitations(message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n"));

  if (message.role === "user" && editing) {
    return (
      <Message from="user" className="max-w-full">
        <UserTextEditor
          initial={text}
          onCancel={() => setEditing(false)}
          onSave={(next) => {
            setEditing(false);
            onEdit(next);
          }}
        />
      </Message>
    );
  }
  const { inputTokens, outputTokens, model } = message.metadata ?? {};
  const cost = formatCost(model, inputTokens, outputTokens, local);

  const renderPart = (part: SushUIMessage["parts"][number], i: number) => {
    const key = `${message.id}-${i}`;
    switch (part.type) {
      case "reasoning":
        // Chats saved before thinking summaries were requested can hold empty ones.
        if (!part.text) return null;
        return (
          <Reasoning key={key} isStreaming={streaming && part.state === "streaming"}>
            <ReasoningTrigger />
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>
        );
      case "text":
        return (
          <MessageContent key={key}>
            {message.role === "assistant" ? (
              <MessageResponse isAnimating={streaming} components={markdownComponents}>
                {part.text}
              </MessageResponse>
            ) : (
              <UserText text={part.text} />
            )}
          </MessageContent>
        );
      case "dynamic-tool":
        if (part.toolName === ARTIFACT_WRITE) {
          return <ArtifactPart key={key} part={part} view={artifacts.get(part.toolCallId)} />;
        }
        return (
          <ToolPart
            key={key}
            part={part}
            canAnswer={canAnswer}
            onResult={(result) => onToolResult(part.toolCallId, result)}
            onApprove={() => onApprove(part.toolCallId)}
          />
        );
      case "data-web":
        return <WebActivityPart key={key} activity={part.data} />;
      case "file":
        return part.mediaType.startsWith("image/") ? (
          <img
            key={key}
            src={part.url}
            alt={part.filename ?? "attachment"}
            className="max-h-64 w-fit rounded-lg border object-contain"
          />
        ) : (
          <div key={key} className="flex justify-end">
            <FileChip name={part.filename ?? "attachment"} mediaType={part.mediaType} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <SourcesProvider defaultExpanded={false}>
      <Message from={message.role}>
        {groupParts(message.parts).map((item) =>
          Array.isArray(item) ? (
            <ActivityGroup key={`${message.id}-g${item[0]}`} parts={item.map((i) => message.parts[i])}>
              {item.map((i) => renderPart(message.parts[i], i))}
            </ActivityGroup>
          ) : (
            renderPart(message.parts[item], item)
          ),
        )}
        {sources.length > 0 && <CitedSourceList sources={sources} />}
        {message.role === "user" && text && (
          <MessageActions className="justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <MessageAction tooltip="Copy" onClick={() => void navigator.clipboard.writeText(text)}>
              <CopyIcon className="size-3.5" />
            </MessageAction>
            {canEdit && (
              <MessageAction tooltip="Edit" onClick={() => setEditing(true)}>
                <PencilIcon className="size-3.5" />
              </MessageAction>
            )}
          </MessageActions>
        )}
        {message.role === "assistant" && !streaming && text && (
          <div className="flex items-center gap-2">
            <MessageActions>
              <MessageAction tooltip="Copy" onClick={() => void navigator.clipboard.writeText(text)}>
                <CopyIcon className="size-3.5" />
              </MessageAction>
              {canRegenerate && (
                <MessageAction tooltip="Regenerate" onClick={onRegenerate}>
                  <RefreshCcwIcon className="size-3.5" />
                </MessageAction>
              )}
              {changedFiles && changedFiles.length > 0 && (
                <MessageAction
                  tooltip={`Undo file changes (${changedFiles.length === 1 ? changedFiles[0] : `${changedFiles.length} files`})`}
                  onClick={onUndo}
                >
                  <Undo2Icon className="size-3.5" />
                </MessageAction>
              )}
            </MessageActions>
            {(model || outputTokens !== undefined) && (
              <MessageStats model={model} logo={logo} inputTokens={inputTokens} outputTokens={outputTokens} cost={cost} />
            )}
          </div>
        )}
      </Message>
    </SourcesProvider>
  );
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat();

/** The model family's logo, falling back to the provider's. */
function messageLogo(message: SushUIMessage, catalog: ProviderModels[]) {
  const { model, providerId } = message.metadata ?? {};
  const provider = catalog.find((c) => c.provider.id === providerId)?.provider;
  return (model && modelLogo(model)) || (provider && providerLogo(provider)) || undefined;
}

interface MessageStatsProps {
  model?: string;
  logo?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: string;
}

/** Model, token usage and cost under an assistant reply; fades in on hover. */
function MessageStats({ model, logo, inputTokens, outputTokens, cost }: MessageStatsProps) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
      {model && (
        <span className="flex items-center gap-1.5">
          {logo && <Logo src={logo} className="size-3.5" />}
          <span className="font-mono text-[11px] tracking-tight">{model}</span>
        </span>
      )}
      {outputTokens !== undefined && (
        <>
          {model && <span className="size-0.5 rounded-full bg-muted-foreground/50" />}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex cursor-default items-center gap-1.5 tabular-nums">
                  <span className="flex items-center gap-0.5">
                    <ArrowUpIcon className="size-3 opacity-60" />
                    {inputTokens === undefined ? "?" : compact.format(inputTokens)}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <ArrowDownIcon className="size-3 opacity-60" />
                    {compact.format(outputTokens)}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="tabular-nums">
                  {inputTokens === undefined ? "?" : exact.format(inputTokens)} input · {exact.format(outputTokens)} output tokens
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>
      )}
      {cost && (
        <span className="rounded-full border px-1.5 py-px text-[11px] font-medium tabular-nums text-foreground/70">
          {cost}
        </span>
      )}
    </div>
  );
}
