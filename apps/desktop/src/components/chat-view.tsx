import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CodeIcon,
  CopyIcon,
  FileTextIcon,
  LightbulbIcon,
  PencilIcon,
  PenLineIcon,
  RefreshCcwIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { usePromptInputController, type PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Composer } from "@/components/composer";
import { Logo } from "@/components/model-picker";
import { ModelPicker } from "@/components/model-picker";
import { FileChip, ToolPart, WebActivityPart } from "@/components/tool-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderModels } from "@/hooks/use-providers";
import { buildContext, runsWithoutApproval, runTool, toolKind, type ToolResult } from "@/lib/agent";
import { usePrefs } from "@/lib/library";
import { modelLogo, providerLogo } from "@/lib/logos";
import { parseSlash } from "@/lib/skills";
import { formatCost, isLocalUrl } from "@/lib/pricing";
import {
  saveMessages,
  setRunning,
  setTarget,
  useAskUser,
  useTarget,
  type Conversation as StoredConversation,
} from "@/lib/store";
import { TauriChatTransport, type ModelTarget, type SushUIMessage } from "@/lib/transport";

interface ChatViewProps {
  conversation: StoredConversation;
  catalog: ProviderModels[];
  /** Whether any provider is configured; `null` while that's still loading. */
  hasProviders: boolean | null;
  onOpenSettings: () => void;
}

export function ChatView({ conversation, catalog, hasProviders, onOpenSettings }: ChatViewProps) {
  const globalTarget = useTarget();
  // A conversation keeps the model it was last used with; new chats start
  // from the most recently picked one.
  const [target, setLocalTarget] = useState<ModelTarget | null>(conversation.target ?? globalTarget);
  // The transport reads the current target lazily, so switching models
  // mid-conversation applies to the next message without recreating the chat.
  const targetRef = useRef(target);
  targetRef.current = target;
  const pickModel = (t: ModelTarget) => {
    // Update the ref now so a retry fired in the same tick uses the new model.
    targetRef.current = t;
    setLocalTarget(t);
    setTarget(t);
  };
  const askUser = useAskUser();
  const prefs = usePrefs();
  // Research uses Anthropic's server-side web tools, so only Claude providers get it.
  const researchAvailable = catalog.find((c) => c.provider.id === target?.providerId)?.provider.format === "anthropic-messages";
  const contextRef = useRef({ askUser, research: prefs.research && researchAvailable });
  contextRef.current = { askUser, research: prefs.research && researchAvailable };
  const transport = useMemo(
    () => new TauriChatTransport(() => targetRef.current, () => buildContext(contextRef.current)),
    [],
  );

  const addToolOutputRef = useRef<(toolName: string, toolCallId: string, result: ToolResult) => void>(() => {});
  const { messages, sendMessage, status, stop, regenerate, error, clearError, addToolOutput } = useChat<SushUIMessage>({
    id: conversation.id,
    messages: conversation.messages,
    transport,
    // Once every tool call has a result, hand the turn straight back to the model.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    // Memory and pre-approved connector tools run right away; the rest wait in the chat.
    onToolCall: ({ toolCall }) => {
      const { toolName, toolCallId, input } = toolCall;
      if (toolKind(toolName) === "unknown") {
        addToolOutputRef.current(toolName, toolCallId, { errorText: `Unknown tool ${toolName}.` });
      } else if (runsWithoutApproval(toolName)) {
        void runTool(toolName, input).then((r) => addToolOutputRef.current(toolName, toolCallId, r));
      }
    },
  });
  addToolOutputRef.current = (tool, toolCallId, result) =>
    void addToolOutput(
      "output" in result
        ? { tool, toolCallId, output: result.output }
        : { tool, toolCallId, state: "output-error", errorText: result.errorText },
    );

  // Persist whenever a turn settles (not on every streamed token).
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!busy && messages !== conversation.messages && messages.length > 0) {
      saveMessages(conversation.id, messages, targetRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, messages]);

  useEffect(() => {
    setRunning(conversation.id, busy);
    return () => setRunning(conversation.id, false);
  }, [conversation.id, busy]);

  const submit = (msg: PromptInputMessage) => {
    if (!msg.text.trim() && msg.files.length === 0) return;
    clearError();
    void sendMessage({ text: msg.text, files: msg.files });
  };

  // Replacing a user message drops everything after it and asks the model again.
  // Attachments on the original message are kept.
  const edit = (message: SushUIMessage, text: string) => {
    const files = message.parts.filter((p) => p.type === "file");
    clearError();
    void sendMessage({ text, files, messageId: message.id });
  };

  // Providers served from this machine (Ollama, LM Studio) cost nothing per token.
  const localProviders = useMemo(
    () => new Set(catalog.filter((c) => isLocalUrl(c.provider.baseUrl)).map((c) => c.provider.id)),
    [catalog],
  );

  // Small local models (e.g. gemma3:1b on Ollama) reject any request that carries tools.
  const toolsUnsupported = !!error && isToolsUnsupported(error.message);
  const [dismissedError, setDismissedError] = useState<Error | undefined>();
  const retryWith = (t: ModelTarget) => {
    pickModel(t);
    clearError();
    void regenerate();
  };

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
      onStop={() => void stop()}
      onOpenSettings={onOpenSettings}
      researchAvailable={researchAvailable}
      messages={messages}
    />
  );

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-[10vh]">
        <div className="w-full max-w-2xl">
          {hasProviders === null ? null : hasProviders ? (
            <h1 className="mb-7 text-center text-[28px] font-medium tracking-tight">{greeting()}</h1>
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
          {hasProviders && <Suggestions />}
        </div>
      </div>
    );
  }

  return (
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
              onRegenerate={() => void regenerate({ messageId: message.id })}
              canEdit={!busy}
              onEdit={(text) => edit(message, text)}
              // Only the latest turn's questions can still be answered.
              canAnswer={!busy && message.id === last?.id}
              onToolOutput={(toolName, toolCallId, result) => addToolOutputRef.current(toolName, toolCallId, result)}
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
                  : error.message}
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
}

/** Matches the errors providers return when a model was sent tools it can't call. */
function isToolsUnsupported(message: string) {
  return /(does not|doesn['’]t) support tools|tools? (are |is )?not supported|does not support (function|tool) calling/i.test(
    message,
  );
}

function greeting(hour = new Date().getHours()) {
  if (hour < 5) return "Burning the midnight oil?";
  if (hour < 12) return "Good morning. What’s on your mind?";
  if (hour < 17) return "Good afternoon. What’s on your mind?";
  if (hour < 22) return "Good evening. What’s on your mind?";
  return "Late night? Let’s think it through.";
}

const SUGGESTIONS = [
  { icon: PenLineIcon, label: "Write or edit", prompt: "Help me write " },
  { icon: LightbulbIcon, label: "Explain a concept", prompt: "Explain " },
  { icon: FileTextIcon, label: "Summarize text", prompt: "Summarize this:\n\n" },
  { icon: CodeIcon, label: "Debug some code", prompt: "Help me debug this code:\n\n" },
];

/** Starter prompts under the empty-state composer; picking one prefills it. */
function Suggestions() {
  const { textInput } = usePromptInputController();
  return (
    <div className="mt-4 flex flex-col items-start px-2">
      {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
        <button
          key={label}
          type="button"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            textInput.setInput(prompt);
            document.querySelector<HTMLTextAreaElement>("textarea[name=message]")?.focus();
          }}
        >
          <Icon className="size-4" /> {label}
        </button>
      ))}
    </div>
  );
}

/** A user message; a leading `/skill` shows as a chip. */
function UserText({ text }: { text: string }) {
  const slash = parseSlash(text);
  if (!slash) return <p className="whitespace-pre-wrap">{text}</p>;
  return (
    <p className="whitespace-pre-wrap">
      <span className="mr-1.5 rounded-md bg-brand/10 px-1.5 py-0.5 font-medium text-brand">/{slash.command.name}</span>
      {slash.args}
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
  onToolOutput: (toolName: string, toolCallId: string, result: ToolResult) => void;
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
  onToolOutput,
}: ChatMessageProps) {
  const [editing, setEditing] = useState(false);
  // Failed or aborted turns can leave an assistant message with no content.
  if (!hasVisibleContent(message)) return null;
  const text = message.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n\n");

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

  return (
    <Message from={message.role}>
      {message.parts.map((part, i) => {
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
                  <MessageResponse isAnimating={streaming}>{part.text}</MessageResponse>
                ) : (
                  <UserText text={part.text} />
                )}
              </MessageContent>
            );
          case "dynamic-tool":
            return (
              <ToolPart
                key={key}
                part={part}
                canAnswer={canAnswer}
                onResult={(result) => onToolOutput(part.toolName, part.toolCallId, result)}
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
      })}
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
          </MessageActions>
          {(model || outputTokens !== undefined) && (
            <MessageStats model={model} logo={logo} inputTokens={inputTokens} outputTokens={outputTokens} cost={cost} />
          )}
        </div>
      )}
    </Message>
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
