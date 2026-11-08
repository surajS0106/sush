// More options for an assistant reply, behind the "…" in its action row: when
// it was written, regenerate it (as is, with a change the user types, shorter,
// longer, or searching the web), the pages it drew on, and a new chat that
// branches from it. Also the row's read-aloud button.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUpIcon,
  BookOpenIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GlobeIcon,
  ListCollapseIcon,
  ListPlusIcon,
  MoreHorizontalIcon,
  RefreshCcwIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { MessageAction } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { hostname, type CitedSource } from "@/lib/citations";
import { sessionTarget, type RegenerateOptions } from "@/lib/sessions";
import type { SushUIMessage } from "@/lib/transport";
import { partWebSources } from "@/lib/web";

// --- the menu ---------------------------------------------------------------------------

interface ResponseMenuProps {
  message: SushUIMessage;
  /** Pages the reply cites inline, numbered as in its text. */
  cited: CitedSource[];
  /** The session, whose current model "Try again" asks. */
  threadId: string;
  /** Only the latest reply, when no run is going, can be regenerated. */
  canRegenerate: boolean;
  onRegenerate: (options?: RegenerateOptions) => void;
  /** Whether "Search the web" can work for this session's model. */
  researchAvailable: boolean;
  /** Absent where a session can't branch (incognito, someone else's shared session). */
  onBranch?: () => void;
}

export function ResponseMenu({ message, cited, threadId, canRegenerate, onRegenerate, researchAvailable, onBranch }: ResponseMenuProps) {
  const [open, setOpen] = useState(false);
  // Read on each render (opening the menu is one), so a model picked since shows.
  const model = sessionTarget(threadId)?.model;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [change, setChange] = useState("");
  const more = useMemo(() => otherPages(message, cited), [message, cited]);
  const hasSources = cited.length > 0 || more.length > 0;
  const createdAt = message.metadata?.createdAt;

  const regenerateWith = (options?: RegenerateOptions) => {
    setOpen(false);
    setChange("");
    onRegenerate(options);
  };
  const askChange = () => {
    if (change.trim()) regenerateWith({ instruction: change.trim() });
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" type="button" variant="ghost" aria-label="More options">
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>
              <p>More</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align="start" className="w-56">
          {createdAt !== undefined && <DropdownMenuLabel className="font-normal">{formatWhen(createdAt)}</DropdownMenuLabel>}
          {canRegenerate && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <RefreshCcwIcon /> Regenerate response
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72" sideOffset={6}>
                <form
                  className="flex items-center gap-1 px-1.5 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    askChange();
                  }}
                >
                  <input
                    value={change}
                    onChange={(e) => setChange(e.target.value)}
                    // The menu would otherwise take typed letters as its own keyboard navigation.
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") e.stopPropagation();
                    }}
                    placeholder="Ask to change response"
                    aria-label="Ask to change response"
                    className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <Button
                    type="submit"
                    size="icon-xs"
                    variant={change.trim() ? "default" : "ghost"}
                    disabled={!change.trim()}
                    aria-label="Regenerate with this change"
                    className="rounded-full"
                  >
                    <ArrowUpIcon />
                  </Button>
                </form>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => regenerateWith()}>
                  <RefreshCcwIcon /> Try again
                  {model && <span className="ml-auto max-w-32 truncate font-mono text-[11px] text-muted-foreground">{model}</span>}
                </DropdownMenuItem>
                {researchAvailable && (
                  <DropdownMenuItem onSelect={() => regenerateWith({ research: true, instruction: SEARCH })}>
                    <GlobeIcon /> Search the web
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => regenerateWith({ instruction: LONGER })}>
                  <ListPlusIcon /> Add details
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => regenerateWith({ instruction: SHORTER })}>
                  <ListCollapseIcon /> More concise
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {hasSources && (
            <DropdownMenuItem onSelect={() => setSourcesOpen(true)}>
              <BookOpenIcon /> View sources
            </DropdownMenuItem>
          )}
          {onBranch && (
            <DropdownMenuItem onSelect={onBranch}>
              <GitBranchIcon /> Branch in new chat
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {hasSources && <SourcesSheet open={sourcesOpen} onOpenChange={setSourcesOpen} cited={cited} more={more} />}
    </>
  );
}

const SEARCH = "Search the web for up-to-date sources first, and cite them.";
const LONGER = "Go into more detail: explain more, with examples where they help.";
const SHORTER = "Make it more concise: keep what matters and cut the rest.";

/** "Today, 12:23 AM", "Yesterday, 9:05 PM", "Nov 3, 4:10 PM", or with the year when it isn't this one. */
function formatWhen(ms: number, now = new Date()) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}

// --- sources ----------------------------------------------------------------------------

interface Page {
  url: string;
  title: string;
  domain: string;
}

/** Pages the reply's web searches and fetches turned up that it didn't cite. */
function otherPages(message: SushUIMessage, cited: CitedSource[]): Page[] {
  const seen = new Set(cited.map((s) => s.url));
  const pages: Page[] = [];
  for (const p of message.parts) {
    for (const s of partWebSources(p)) {
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      const domain = hostname(s.url);
      pages.push({ url: s.url, title: s.title || domain, domain });
    }
  }
  return pages;
}

/** How many uncited pages show before "N more". */
const MORE_SHOWN = 6;

function SourcesSheet({
  open,
  onOpenChange,
  cited,
  more,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cited: CitedSource[];
  more: Page[];
}) {
  const [all, setAll] = useState(false);
  const shown = all ? more : more.slice(0, MORE_SHOWN);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 sm:max-w-sm">
        <SheetHeader className="border-b">
          <SheetTitle>Sources</SheetTitle>
          <SheetDescription className="sr-only">The pages this reply drew on</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {cited.length > 0 && (
            <ul className="flex flex-col">
              {cited.map((s) => (
                <SourceRow key={s.url} page={s} n={s.n} />
              ))}
            </ul>
          )}
          {more.length > 0 && (
            <>
              {cited.length > 0 && <h3 className="px-3 pt-4 pb-1 text-sm font-medium">More</h3>}
              <ul className="flex flex-col">
                {shown.map((p) => (
                  <SourceRow key={p.url} page={p} />
                ))}
              </ul>
              {more.length > MORE_SHOWN && !all && (
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="mx-3 mt-1 flex items-center gap-1 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  {more.length - MORE_SHOWN} more <ChevronDownIcon className="size-3.5" />
                </button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SourceRow({ page, n }: { page: Page; n?: number }) {
  return (
    <li>
      <button
        type="button"
        title={page.url}
        onClick={() => void openUrl(page.url).catch(() => toast.error("Couldn’t open that page"))}
        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold uppercase">
            {page.domain[0] ?? "?"}
          </span>
          <span className="truncate">{page.domain}</span>
          {n !== undefined && <span className="ml-auto shrink-0 tabular-nums">{n}</span>}
        </span>
        <span className="line-clamp-2 text-sm font-medium">{page.title}</span>
      </button>
    </li>
  );
}

// --- read aloud -------------------------------------------------------------------------

/** Reads the reply with the system's voice; pressed again, or on another reply, it stops. */
export function ReadAloudAction({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(
    () => () => {
      // Leaving the chat stops what this reply was reading.
      if (utterance.current && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    [],
  );
  if (typeof speechSynthesis === "undefined") return null;
  const toggle = () => {
    if (speaking) {
      speechSynthesis.cancel();
      return;
    }
    // Only one reply reads at a time.
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plainText(text));
    u.onend = u.onerror = () => {
      if (utterance.current === u) {
        utterance.current = null;
        setSpeaking(false);
      }
    };
    utterance.current = u;
    setSpeaking(true);
    speechSynthesis.speak(u);
  };
  return (
    <MessageAction tooltip={speaking ? "Stop reading" : "Read aloud"} onClick={toggle}>
      {speaking ? <SquareIcon className="size-3 fill-current" /> : <Volume2Icon className="size-3.5" />}
    </MessageAction>
  );
}

/** Markdown as it would be said: no code blocks, link targets, or formatting marks. */
function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, "$2")
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
