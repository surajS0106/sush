// How tool calls, web activity and attachments appear inside a message.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { DynamicToolUIPart } from "ai";
import {
  ArrowRightIcon,
  BrainIcon,
  BookOpenIcon,
  CloudSunIcon,
  DownloadIcon,
  FileIcon,
  FilePenIcon,
  FolderIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ImageIcon,
  KeyboardIcon,
  LocateFixedIcon,
  MapIcon,
  MessagesSquareIcon,
  MousePointerClickIcon,
  PlaneIcon,
  PlugIcon,
  ScrollTextIcon,
  SearchIcon,
  TerminalIcon,
  TimerIcon,
  Trash2Icon,
  NotebookTextIcon,
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Image } from "@/components/ai-elements/image";

import { AskUserCard, AskUserSummary } from "@/components/ask-user-card";
import {
  AutomationSaveCard,
  CodeBlock,
  EditDiff,
  SkillSaveCard,
  ToolApprovalCard,
  ToolResultRow,
  WorkspaceApprovalCard,
} from "@/components/tool-approval-card";
import { FlightCard, FlightSearching } from "@/components/flight-card";
import { LocationCard } from "@/components/location-card";
import { MapCard } from "@/components/map-card";
import { CommitsCard } from "@/components/ui/CommitCard";
import { LoadingState } from "@/components/ui/loading-state";
import { InstamartAddresses, InstamartCard, InstamartPendingItems, InstamartWorking } from "@/components/instamart-card";
import { SwiggyCard, SwiggyOrderApproval } from "@/components/swiggy-card";
import { PullRequestCard } from "@/components/ui/PullRequestCard";
import { Skeleton } from "@/components/ui/skeleton";
import { TopicCard } from "@/components/topic-card";
import { WeatherCard } from "@/components/weather-card";
import { sourceTitle } from "@/lib/notebooks";
import {
  CHATS_SEARCH,
  findConnectorTool,
  MEMORY_DELETE,
  SOURCE_SEARCH,
  STOPPED,
  toolKind,
  useRunningToolCalls,
  type ToolResult,
} from "@/lib/agent";
import { parseAskUserInput, type AskUserOutput } from "@/lib/ask-user";
import { parseAutomationSave } from "@/lib/automation-save";
import { createAutomation, describeSchedule, formatWhen, nextRunOf } from "@/lib/automations";
import { WatchingHost } from "@/lib/share";
import { brandLogo, connectorIcon, placesOrder } from "@/lib/connector-catalog";
import { isSwiggyOrder, parseSwiggyCard, swiggyService } from "@/lib/swiggy";
import type { FlightsOutput } from "@/lib/flights";
import { parseCommits, parsePullRequest } from "@/lib/github";
import { saveImage, type ImageInput, type ImageOutput } from "@/lib/images";
import { allowTool } from "@/lib/library";
import type { LocationOutput } from "@/lib/location";
import type { MapOutput } from "@/lib/maps";
import { applySkillSave, parseSkillSave, skillToReplace, slugify } from "@/lib/skills";
import { getConversations } from "@/lib/store";
import { errorMessage, type SandboxStatus } from "@/lib/tauri";
import { FOLDER_MEDIA_TYPE, type SushMetadata, type WebActivity } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { TopicOutput } from "@/lib/topic";
import { webSources } from "@/lib/web";
import type { WeatherOutput } from "@/lib/weather";
import { CurrentWorkspace, openFile, updateWorkspace, useSandboxStatus } from "@/lib/workspaces";

interface ToolPartProps {
  part: DynamicToolUIPart;
  /** Only the latest turn's pending calls can still be answered or approved. */
  canAnswer: boolean;
  onResult: (result: ToolResult) => void;
  /** Let a waiting connector or Cowork call run; Rust runs it. */
  onApprove: () => void;
  /** In a shared session: who answered this call (`metadata.sushAnswers` on its message). */
  answer?: ToolAnswer;
}

export type ToolAnswer = NonNullable<SushMetadata["sushAnswers"]>[string];

/** Calls that wait for whoever runs the session (an approval, an answer). */
const ASKS = new Set(["ask-user", "skill-save", "automation-save", "location", "workspace", "browser", "connector"]);

const ANSWERED = { approve: "Approved", deny: "Denied", answer: "Answered" } as const;

export function ToolPart(props: ToolPartProps) {
  const card = <ToolCard {...props} />;
  if (!props.answer) return card;
  return (
    <div className="flex flex-col gap-1">
      {card}
      <p className="text-xs text-muted-foreground">
        {ANSWERED[props.answer.decision]} by {props.answer.by.name}
      </p>
    </div>
  );
}

function ToolCard(props: ToolPartProps) {
  // Watching someone's session: their approvals and questions are theirs to
  // answer, apart from what a driver was handed.
  const watching = useContext(WatchingHost);
  const running = useRunningToolCalls().has(props.part.toolCallId);
  const kind = toolKind(props.part.toolName);
  // A guest doesn't have the host's connectors; their tools are `<connector>__<tool>`.
  const asks = ASKS.has(kind) || (kind === "unknown" && props.part.toolName.includes("__"));
  if (watching && props.part.state === "input-available" && !running && asks && !watching.mayAnswer(props.part)) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Waiting for {watching.hostName} to {kind === "ask-user" ? "answer" : "approve"}
      </p>
    );
  }
  switch (kind) {
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
    case "automation-save":
      return <AutomationSavePart {...props} />;
    case "workspace":
      return <WorkspacePart {...props} />;
    case "browser":
      return <BrowserPart {...props} />;
    case "image":
      return <ImagePart part={props.part} />;
    case "map":
      return <MapPart part={props.part} />;
    case "flights":
      return <FlightsPart part={props.part} />;
    case "weather":
      return <WeatherPart part={props.part} />;
    case "topic":
      return <TopicPart part={props.part} />;
    case "web":
      return <WebToolPart part={props.part} />;
    case "location":
      return <LocationPart {...props} />;
    case "notebook":
      return <NotebookToolPart part={props.part} />;
    case "agent":
      // Shown with the rest of its step's sub-agents (`components/subagents.tsx`).
      return null;
    case "tools-load":
      // Plumbing: the model loading tools it's about to use.
      return null;
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
      onResult({ errorText: "Invalid ask_user input: expected { questions: [{ question, options[], multiSelect? } or { question, type: \"date\" | \"date-range\" }] }." });
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

// --- images ------------------------------------------------------------------------

const ASPECT_CLASS = { square: "aspect-square", landscape: "aspect-[3/2]", portrait: "aspect-[2/3] max-w-64" };

function ImagePart({ part }: { part: DynamicToolUIPart }) {
  const input = (part.input ?? {}) as ImageInput;
  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <div className="flex max-w-md flex-col gap-2">
        <Skeleton className={cn("w-full rounded-md", ASPECT_CLASS[input.aspect ?? "square"] ?? ASPECT_CLASS.square)} />
        <LoadingState label="Generating image" />
      </div>
    );
  }
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <ImageIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't generate the image</span>
          </>
        }
      />
    );
  }
  const output = part.output as ImageOutput;
  const save = () =>
    saveImage(output).then(
      (saved) => saved && toast.success("Image saved"),
      (e) => toast.error(`Couldn't save the image: ${errorMessage(e)}`),
    );
  return (
    <figure className="group/image relative max-w-md">
      <Image src={output.url} mediaType={output.mediaType} alt={output.prompt} className="border" />
      <button
        type="button"
        onClick={save}
        aria-label="Save image"
        title="Save image"
        className="absolute top-2 right-2 rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/image:opacity-100 hover:text-foreground focus-visible:opacity-100"
      >
        <DownloadIcon className="size-4" />
      </button>
      <figcaption className="mt-1.5 line-clamp-2 text-xs text-muted-foreground" title={output.revisedPrompt ?? output.prompt}>
        {output.revisedPrompt ?? output.prompt}
      </figcaption>
    </figure>
  );
}

// --- maps --------------------------------------------------------------------------

function MapPart({ part }: { part: DynamicToolUIPart }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-2">
        <Skeleton className="aspect-[16/10] w-full rounded-xl" />
        <LoadingState label="Finding the route" />
      </div>
    );
  }
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <MapIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't show the map</span>
          </>
        }
      />
    );
  }
  // A guest gets a placeholder: a map can show the host's address (`share/redact.rs`).
  if (typeof part.output !== "object" || part.output === null) {
    return (
      <ToolResultRow
        label={
          <>
            <MapIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Map hidden: private to the host</span>
          </>
        }
      />
    );
  }
  return <MapCard map={part.output as MapOutput} />;
}

// --- flights -----------------------------------------------------------------------

function FlightsPart({ part }: { part: DynamicToolUIPart }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    // The input arrives in pieces, so a code shows only once it's whole.
    const { origin, destination } = (part.input ?? {}) as { origin?: unknown; destination?: unknown };
    const known = (code: unknown) => (typeof code === "string" && code.trim().length === 3 ? code.trim().toUpperCase() : undefined);
    return <FlightSearching origin={known(origin)} destination={known(destination)} />;
  }
  const row = (text: string, detail?: string, error?: boolean) => (
    <ToolResultRow
      error={error}
      detail={detail}
      label={
        <>
          <PlaneIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );
  if (part.state === "output-error") return row("Couldn't look for flights", part.errorText, true);
  // A guest gets a placeholder: a search gives away the host's travel plans (`share/redact.rs`).
  if (typeof part.output !== "object" || part.output === null) return row("Flights hidden: private to the host");
  return <FlightCard trip={part.output as FlightsOutput} />;
}

// --- weather -----------------------------------------------------------------------

function WeatherPart({ part }: { part: DynamicToolUIPart }) {
  if (part.state === "input-streaming" || part.state === "input-available") return <LoadingState label="Checking the sky" />;
  const row = (text: string, detail?: string, error?: boolean) => (
    <ToolResultRow
      error={error}
      detail={detail}
      label={
        <>
          <CloudSunIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );
  if (part.state === "output-error") return row("Couldn't get the weather", part.errorText, true);
  // A guest gets a placeholder: the place is usually where the host is (`share/redact.rs`).
  if (typeof part.output !== "object" || part.output === null) return row("Weather hidden: private to the host");
  return <WeatherCard weather={part.output as WeatherOutput} />;
}

// --- topic -------------------------------------------------------------------------

function TopicPart({ part }: { part: DynamicToolUIPart }) {
  if (part.state === "input-streaming" || part.state === "input-available") return <LoadingState label="Finding photos and articles" />;
  if (part.state === "output-error" || typeof part.output !== "object" || part.output === null) {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <BookOpenIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't find photos and articles</span>
          </>
        }
      />
    );
  }
  return <TopicCard topic={part.output as TopicOutput} />;
}

// --- location ----------------------------------------------------------------------

const LOCATION_DECLINED = "The user didn't share their location. Ask them to name a place instead.";

function LocationPart({ part, canAnswer, onResult }: ToolPartProps) {
  const row = (text: string, detail?: string) => (
    <ToolResultRow
      detail={detail}
      label={
        <>
          <LocateFixedIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );
  switch (part.state) {
    case "input-streaming":
      return <LoadingState label="Asking for your location" />;
    case "output-available": {
      const shared = part.output as Partial<LocationOutput> & { removed?: boolean };
      if (shared.removed) return row("Location removed after its session");
      if (shared.temporary) return row("Shared location for this session", shared.place);
      return row(shared.source === "saved" ? "Shared saved address" : "Shared location", shared.place);
    }
    case "output-error":
      return row("Location not shared");
    default:
      if (!canAnswer) return row("Location not shared");
      return <LocationCard onShare={(output) => onResult({ output })} onDecline={() => onResult({ errorText: LOCATION_DECLINED })} />;
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

// --- notebook sources ------------------------------------------------------------

/** A notebook chat searching or reading its sources; the passages found list under it. */
function NotebookToolPart({ part }: { part: DynamicToolUIPart }) {
  const input = (part.input ?? {}) as { query?: string; source_id?: string; page?: number };
  const searching = part.toolName === SOURCE_SEARCH;
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <LoadingState label={searching ? "Searching the sources" : "Reading a source"} />;
  }
  const found = (part.state === "output-available" && (part.output as { searchResults?: { title: string }[] } | null)?.searchResults) || [];
  const where = input.source_id ? (sourceTitle(input.source_id) ?? "a source") : "a source";
  const label = searching
    ? `Searched the sources for “${input.query ?? ""}”${found.length ? ` · ${found.length} ${found.length === 1 ? "passage" : "passages"}` : ""}`
    : `Read ${where}${input.page ? `, page ${input.page}` : ""}`;
  const detail =
    part.state === "output-error"
      ? part.errorText
      : found.length
        ? found.map((r) => r.title).join("\n")
        : typeof part.output === "string"
          ? part.output
          : undefined;
  return (
    <ToolResultRow
      error={part.state === "output-error"}
      detail={detail}
      label={
        <>
          <NotebookTextIcon className="size-4 shrink-0" />
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

const DISCARDED_AUTOMATION = "The user discarded this automation. Ask what they'd like changed.";

function AutomationSavePart({ part, canAnswer, onResult }: ToolPartProps) {
  const parsed = part.state === "input-streaming" ? null : parseAutomationSave(part.input);
  const input = parsed?.ok ? parsed.value : null;
  const invalid = parsed && !parsed.ok ? parsed.error : null;
  // Made in a Cowork session, its runs work in the same folder.
  const workspace = useContext(CurrentWorkspace);

  const reported = useRef(false);
  useEffect(() => {
    if (part.state === "input-available" && invalid && canAnswer && !reported.current) {
      reported.current = true;
      onResult({ errorText: invalid });
    }
  }, [part.state, invalid, canAnswer, onResult]);

  const name = (part.input as { name?: string } | undefined)?.name ?? "automation";
  const label = (
    <>
      <TimerIcon className="size-4 shrink-0" />
      <span className="line-clamp-1 text-left">
        {part.state === "output-available" ? `Saved automation “${name}”` : `Automation “${name}” not saved`}
      </span>
    </>
  );

  switch (part.state) {
    case "input-streaming":
      return <LoadingState label="Drafting automation" />;
    case "output-available":
      return <ToolResultRow label={label} />;
    case "output-error":
      return <ToolResultRow label={label} error={part.errorText !== DISCARDED_AUTOMATION} />;
    default:
      if (!input) return null;
      if (!canAnswer) return <p className="text-sm text-muted-foreground italic">Automation wasn't saved</p>;
      return (
        <AutomationSaveCard
          name={input.name}
          schedule={describeSchedule(input.schedule)}
          prompt={input.prompt}
          folder={workspace?.name}
          onDiscard={() => onResult({ errorText: DISCARDED_AUTOMATION })}
          onSave={() => {
            const saved = createAutomation({ ...input, workspaceId: workspace?.id, enabled: true });
            const next = nextRunOf(saved);
            onResult({
              output:
                `Saved the automation "${saved.name}" (${describeSchedule(saved.schedule)}). ` +
                (next ? `It runs next ${formatWhen(next)}, while Sush is open.` : "The user runs it from Automations."),
            });
          }}
        />
      );
  }
}

// --- cowork ---------------------------------------------------------------------------

interface WorkspaceInput {
  path?: string;
  pattern?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  from?: string;
  to?: string;
  command?: string;
  cwd?: string;
  network?: boolean;
  unsandboxed?: boolean;
  justification?: string;
  message?: string;
  branch?: string;
  abort?: boolean;
  into?: boolean;
  base?: string;
  title?: string;
}

/** What a Cowork call does, as a short phrase and an icon. */
function describeWorkspaceCall(name: string, input: WorkspaceInput): { icon: typeof FileIcon; done: string; doing: string } {
  const path = input.path || "the folder";
  switch (name) {
    case "fs_list":
      return { icon: FolderIcon, done: `Listed ${path}`, doing: `Listing ${path}` };
    case "fs_glob":
      return { icon: SearchIcon, done: `Found files matching ${input.pattern ?? ""}`, doing: "Finding files" };
    case "fs_search":
      return { icon: SearchIcon, done: `Searched for “${input.pattern ?? ""}”`, doing: "Searching files" };
    case "fs_read":
      return { icon: FileIcon, done: `Read ${path}`, doing: `Reading ${path}` };
    case "fs_write":
      return { icon: FilePenIcon, done: `Wrote ${path}`, doing: `Writing ${path}` };
    case "fs_edit":
      return { icon: FilePenIcon, done: `Edited ${path}`, doing: `Editing ${path}` };
    case "fs_move":
      return { icon: ArrowRightIcon, done: `Moved ${input.from ?? ""} to ${input.to ?? ""}`, doing: "Moving a file" };
    case "fs_delete":
      return { icon: Trash2Icon, done: `Deleted ${path}`, doing: `Deleting ${path}` };
    case "git_commit":
      return { icon: GitCommitHorizontalIcon, done: `Committed “${input.message?.split("\n")[0] ?? ""}”`, doing: "Committing" };
    case "git_merge":
      if (input.abort) return { icon: GitMergeIcon, done: "Undid the merge", doing: "Undoing the merge" };
      if (input.into) return { icon: GitMergeIcon, done: `Merged into ${input.branch ?? ""}`, doing: `Merging into ${input.branch ?? ""}` };
      return { icon: GitMergeIcon, done: `Merged ${input.branch ?? ""} into the branch`, doing: `Merging ${input.branch ?? ""}` };
    case "branch_status":
      return { icon: GitPullRequestIcon, done: "Checked the branch", doing: "Checking the branch" };
    default:
      return { icon: TerminalIcon, done: `Ran ${input.command ?? "a command"}`, doing: "Running a command" };
  }
}

const EDIT_TOOLS = new Set(["fs_write", "fs_edit", "fs_move", "fs_delete", "git_commit", "git_merge"]);
/** Calls about one file, which "Open" shows in the viewer. */
const FILE_TOOLS = new Set(["fs_read", "fs_write", "fs_edit"]);

function WorkspacePart({ part, canAnswer, onResult, onApprove }: ToolPartProps) {
  const workspace = useContext(CurrentWorkspace);
  const sandbox = useSandboxStatus();
  const [approved, setApproved] = useState(false);
  const inFlight = useRunningToolCalls().has(part.toolCallId);
  const input = (part.input ?? {}) as WorkspaceInput;
  const { icon: Icon, done, doing } = describeWorkspaceCall(part.toolName, input);
  const label = (text: string, suffix?: string) => (
    <>
      <Icon className="size-4 shrink-0" />
      <span className={cn("line-clamp-1 text-left", part.toolName === "shell_run" && "font-mono text-xs")}>{text}</span>
      {suffix && <span className="shrink-0 opacity-70">· {suffix}</span>}
    </>
  );

  switch (part.state) {
    case "input-streaming":
      return <LoadingState label={doing} />;
    case "output-available": {
      const file = FILE_TOOLS.has(part.toolName) ? input.path : undefined;
      return (
        <ToolResultRow
          label={label(done)}
          detail={String(part.output ?? "")}
          action={
            workspace && file ? (
              <button
                type="button"
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => openFile(workspace.id, file)}
              >
                Open
              </button>
            ) : undefined
          }
        />
      );
    }
    case "output-error": {
      const quiet = part.errorText === DENIED || part.errorText === STOPPED;
      return (
        <ToolResultRow
          error={!quiet}
          label={label(done, part.errorText === DENIED ? "denied" : part.errorText === STOPPED ? "stopped" : "failed")}
          detail={quiet ? undefined : part.errorText}
        />
      );
    }
    default: {
      // The run starts calls that need no approval itself and reports them as running.
      if (approved || inFlight) return <LoadingState label={doing} />;
      if (!canAnswer) return <p className="text-sm text-muted-foreground italic">{done} didn’t happen</p>;
      const allow = () => {
        setApproved(true);
        onApprove();
      };
      const allowAll =
        workspace && EDIT_TOOLS.has(part.toolName)
          ? () => {
              setApproved(true);
              // Later edits in this folder run without asking; this one goes ahead now.
              void updateWorkspace(workspace, { approval: "auto-edits" }).finally(onApprove);
            }
          : undefined;
      return (
        <WorkspaceApprovalCard
          {...workspaceRequest(part.toolName, input, workspace?.commands === "desktop" ? null : sandbox)}
          onAllow={allow}
          onAllowAll={allowAll}
          onDeny={() => onResult({ errorText: DENIED })}
        />
      );
    }
  }
}

/** The approval card's question and preview for a Cowork call. */
/** How a command will run, for its approval card. `sandbox` is null when it won't be used. */
function commandNote(input: WorkspaceInput, sandbox: SandboxStatus | null): string {
  const where = `In ${input.cwd || "the workspace folder"}. `;
  const why = input.justification ? ` Why: ${input.justification}` : "";
  if (input.unsandboxed || !sandbox?.available) {
    return `${where}Runs outside the sandbox, on your computer with your permissions.${why}`;
  }
  if (input.network) return `${where}Runs in the sandbox (changes only this folder) but with network access.${why}`;
  return sandbox.networkBlocked
    ? `${where}Runs in the sandbox: it can change files only in this folder and has no network.`
    : `${where}Runs in the sandbox: it can change files only in this folder. Network isn’t blocked on this system.`;
}

function workspaceRequest(
  name: string,
  input: WorkspaceInput,
  sandbox: SandboxStatus | null,
): { title: string; note?: string; children?: React.ReactNode } {
  const path = input.path ?? "";
  switch (name) {
    case "shell_run":
      return {
        title: input.unsandboxed ? "Run this command outside the sandbox?" : "Run this command?",
        note: commandNote(input, sandbox),
        children: <CodeBlock text={input.command ?? ""} lines={20} />,
      };
    case "fs_edit":
      return { title: `Edit ${path}?`, children: <EditDiff before={input.old_string ?? ""} after={input.new_string ?? ""} /> };
    case "fs_write":
      return { title: `Write ${path}?`, note: "Creates the file, or replaces everything in it.", children: <CodeBlock text={input.content ?? ""} /> };
    case "fs_move":
      return { title: `Move ${input.from ?? ""} to ${input.to ?? ""}?` };
    case "fs_delete":
      return { title: `Delete ${path}?`, note: "It goes to the trash." };
    case "fs_read":
      return { title: `Read ${path}?`, note: "This file may hold passwords or keys, which would be sent to the model." };
    case "git_commit":
      return { title: "Commit every change?", note: "Stages all changes in the folder (not ignored files) and commits them.", children: <CodeBlock text={input.message ?? ""} lines={8} /> };
    case "git_merge":
      if (input.abort) return { title: "Undo the merge in progress?", note: "Puts the branch and its files back as they were before the merge." };
      if (input.into) {
        return {
          title: `Merge this branch into ${input.branch ?? ""}?`,
          note: `Fast-forwards ${input.branch ?? "that branch"} to this branch’s commits. Where it’s checked out, that folder’s files update too.`,
        };
      }
      return { title: `Merge ${input.branch ?? ""} into this branch?`, note: "Any conflicts are left in the files for the model to resolve." };
    default:
      return { title: `Allow ${name}?` };
  }
}

// --- browser -----------------------------------------------------------------------

interface BrowserInput {
  url?: string;
  ref?: number;
  text?: string;
  submit?: boolean;
}

/** The page a browser tool's output starts with ("Page: …"). */
function pageTitle(output: unknown) {
  const title = /^Page: (.*)$/m.exec(String(output ?? ""))?.[1]?.trim();
  return title || undefined;
}

function describeBrowserCall(name: string, input: BrowserInput, output?: unknown) {
  const page = pageTitle(output);
  switch (name) {
    case "browser_navigate": {
      const to = input.url ?? "";
      if (to === "back" || to === "forward") return { icon: GlobeIcon, done: `Went ${to}`, doing: `Going ${to}` };
      if (to === "reload") return { icon: GlobeIcon, done: "Reloaded the page", doing: "Reloading" };
      return { icon: GlobeIcon, done: `Opened ${page ?? to}`, doing: `Opening ${to}` };
    }
    case "browser_click":
      return { icon: MousePointerClickIcon, done: `Clicked [${input.ref ?? "?"}]${page ? ` on ${page}` : ""}`, doing: "Clicking" };
    case "browser_type":
      return { icon: KeyboardIcon, done: `Typed into [${input.ref ?? "?"}]${page ? ` on ${page}` : ""}`, doing: "Typing" };
    default:
      return { icon: GlobeIcon, done: `Read ${page ?? "the page"}`, doing: "Reading the page" };
  }
}

function BrowserPart({ part, canAnswer, onResult, onApprove }: ToolPartProps) {
  const [approved, setApproved] = useState(false);
  const inFlight = useRunningToolCalls().has(part.toolCallId);
  const input = (part.input ?? {}) as BrowserInput;
  const { icon: Icon, done, doing } = describeBrowserCall(
    part.toolName,
    input,
    part.state === "output-available" ? part.output : undefined,
  );
  const label = (text: string, suffix?: string) => (
    <>
      <Icon className="size-4 shrink-0" />
      <span className="line-clamp-1 text-left">{text}</span>
      {suffix && <span className="shrink-0 opacity-70">· {suffix}</span>}
    </>
  );
  switch (part.state) {
    case "input-streaming":
      return <LoadingState label={doing} />;
    case "output-available":
      return <ToolResultRow label={label(done)} detail={String(part.output ?? "")} />;
    case "output-error": {
      const quiet = part.errorText === DENIED || part.errorText === STOPPED;
      return (
        <ToolResultRow
          error={!quiet}
          label={label(done, part.errorText === DENIED ? "denied" : part.errorText === STOPPED ? "stopped" : "failed")}
          detail={quiet ? undefined : part.errorText}
        />
      );
    }
    default: {
      if (approved || inFlight) return <LoadingState label={doing} />;
      if (!canAnswer) return <p className="text-sm text-muted-foreground italic">{done} didn’t happen</p>;
      // Only opening a site the user hasn't allowed in this session asks.
      return (
        <WorkspaceApprovalCard
          icon={GlobeIcon}
          title={`Open ${input.url ?? "this page"}?`}
          note="Sush can then read this site and click and type on it during this session."
          onAllow={() => {
            setApproved(true);
            onApprove();
          }}
          onDeny={() => onResult({ errorText: DENIED })}
        />
      );
    }
  }
}

// --- connectors --------------------------------------------------------------------

export const DENIED = "The user denied this tool call.";

function ConnectorPart({ part, canAnswer, onResult, onApprove }: ToolPartProps) {
  // A guest answering for the host: they don't have the connector, and "Always allow" stays the host's.
  const watching = useContext(WatchingHost);
  const [running, setRunning] = useState(false);
  const inFlight = useRunningToolCalls().has(part.toolCallId);
  // Only a card that just finished plays its entrance, not every one in a reopened chat.
  const sawItRun = useRef(false);
  if (part.state !== "output-available" && part.state !== "output-error") sawItRun.current = true;
  const found = findConnectorTool(part.toolName);
  const instamart = swiggyService(part.toolName) === "instamart";
  // Saved chats can reference connectors that are gone; fall back to the raw name.
  const [connectorName, toolName] = found
    ? [found.connector.name, found.tool]
    : [part.toolName.split("__")[0], part.toolName.split("__").slice(1).join("__") || part.toolName];
  const icon = found ? connectorIcon(found.connector) : connectorIcon({ id: part.toolName.split("__")[0] });
  const brand = brandLogo(found ? found.connector : { id: part.toolName.split("__")[0] });
  const label = (
    <>
      {/* 24px and 8px from the text: the least Swiggy's brand guidelines allow. */}
      {brand ? <img src={brand} alt="" className="mr-0.5 size-6 shrink-0 rounded-[20%] object-cover" /> : <ConnectorIcon src={icon} />}
      <span>
        {connectorName} · {toolName}
      </span>
    </>
  );

  switch (part.state) {
    case "input-streaming":
      return instamart ? <InstamartWorking tool={toolName} input={part.input} /> : <LoadingState label={`Preparing ${toolName}`} />;
    case "output-available": {
      const swiggy = parseSwiggyCard(part.toolName, part.output);
      if (swiggy?.service === "instamart" && swiggy.card.kind === "addresses") {
        return <InstamartAddresses card={swiggy.card} callId={part.toolCallId} connected={!!found} readOnly={!found || !!watching} row={<ToolResultRow label={label} />} />;
      }
      if (swiggy?.service === "instamart" && (swiggy.card.kind === "products" || swiggy.card.kind === "cart")) {
        return (
          <InstamartCard
            card={swiggy.card}
            callId={part.toolCallId}
            input={part.input}
            output={part.output}
            connectorId={found?.connector.id}
            widget={found?.widget}
            readOnly={!found || !!watching}
            fresh={sawItRun.current}
            row={<ToolResultRow label={label} />}
          />
        );
      }
      const pr = swiggy ? null : parsePullRequest(part.output, part.input);
      const commits = pr || swiggy ? null : parseCommits(part.output, part.input);
      return (
        <div className="space-y-3">
          <ToolResultRow label={label} detail={String(part.output ?? "")} />
          {swiggy && <SwiggyCard {...swiggy} />}
          {pr && <PullRequestCard pr={pr} />}
          {commits && <CommitsCard set={commits} />}
        </div>
      );
    }
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
      // The run starts calls that need no approval itself and reports them as running.
      if (running || inFlight) {
        return instamart ? <InstamartWorking tool={toolName} input={part.input} /> : <LoadingState label={`Running ${toolName}`} />;
      }
      if (!canAnswer || (!found && !watching)) return <p className="text-sm text-muted-foreground italic">{toolName} didn't run</p>;
      if (found && !watching && isSwiggyOrder(part.toolName)) {
        return (
          <SwiggyOrderApproval
            connectorId={found.connector.id}
            service={swiggyService(part.toolName)!}
            input={part.input}
            onDeny={() => onResult({ errorText: DENIED })}
            onConfirm={() => {
              setRunning(true);
              onApprove();
            }}
          />
        );
      }
      return (
        <>
          {instamart && <InstamartPendingItems tool={toolName} input={part.input} />}
          <ToolApprovalCard
            connector={connectorName}
            tool={toolName}
            description={found?.spec.description.replace(/^\[[^\]]*\] /, "")}
            input={part.input}
            allowAlways={!watching && !!found && !placesOrder(found.tool)}
            onDeny={() => onResult({ errorText: DENIED })}
            onAllow={(always) => {
              if (always && found) allowTool(found.connector.id, found.tool);
              setRunning(true);
              onApprove();
            }}
          />
        </>
      );
  }
}

/** The connector's logo in the surrounding text colour, or a plug when it has none. */
function ConnectorIcon({ src }: { src?: string }) {
  if (!src) return <PlugIcon className="size-4 shrink-0" />;
  const mask = `url("${src}") center / contain no-repeat`;
  return <span aria-hidden className="size-4 shrink-0 bg-current" style={{ mask, WebkitMask: mask }} />;
}

// --- web research --------------------------------------------------------------------

/** Sush's own `web_search` / `web_fetch` call, drawn like the provider's own search. */
function WebToolPart({ part }: { part: DynamicToolUIPart }) {
  const activity: WebActivity = { name: part.toolName, input: part.input, sources: webSources(part.toolName, part.output) };
  if (part.state === "output-error") {
    return (
      <div className="space-y-1 text-sm">
        <WebActivityPart activity={activity} />
        <p className="pl-5.5 text-xs text-muted-foreground">{part.errorText}</p>
      </div>
    );
  }
  return <WebActivityPart activity={activity} pending={part.state !== "output-available"} />;
}

export function WebActivityPart({ activity, pending = false }: { activity: WebActivity; pending?: boolean }) {
  const input = (activity.input ?? {}) as { query?: string; url?: string };
  const what =
    activity.name === "web_search"
      ? `${pending ? "Searching" : "Searched"} the web${input.query ? ` for “${input.query}”` : ""}`
      : activity.name === "web_fetch"
        ? `${pending ? "Reading" : "Read"} ${input.url ? hostname(input.url) : "a page"}`
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
