// The phone's own layout (Android): a glass dock of tabs floating over the page in place of
// the sidebar, a bento Home, and a full-screen list of chats. A chat itself fills the screen
// with a back arrow; the dock is for the pages you move between. Modelled on Yammer's.

import {
  ArrowUpIcon,
  ContactIcon,
  FileTextIcon,
  GhostIcon,
  HomeIcon,
  KanbanIcon,
  LoaderCircleIcon,
  LogInIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  NotebookTextIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TimerIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Page } from "@/components/app-sidebar";
import { Mascot } from "@/components/mascot";
import { SessionMenuItems } from "@/components/session-actions";
import { openJoin } from "@/components/shared-sessions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAutomations } from "@/lib/automations";
import { useTasks } from "@/lib/board";
import { useCrmThreads } from "@/lib/crm";
import { useDocs } from "@/lib/docs";
import { availableConnectors, openSettings, useConnectors } from "@/lib/library";
import { useNotebooks, useNotebookThreads } from "@/lib/notebooks";
import { useProjects } from "@/lib/projects";
import { useReportThreads } from "@/lib/reports";
import { useSessionStatus } from "@/lib/sessions";
import type { Conversation } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useStepThreadIds } from "@/lib/workflows";

/** The dock's tabs. Other pages open from Home's tiles, with a back arrow. */
export const DOCK_TABS = ["home", "chats", "board", "docs"] as const satisfies readonly Page[];
export const isDockTab = (page: Page) => (DOCK_TABS as readonly Page[]).includes(page);

const TABS: { id: (typeof DOCK_TABS)[number]; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "chats", label: "Chats", icon: MessagesSquareIcon },
  { id: "board", label: "Board", icon: KanbanIcon },
  { id: "docs", label: "Docs", icon: FileTextIcon },
];

const spring = { type: "spring", stiffness: 520, damping: 34 } as const;

export const glass =
  "border border-white/50 bg-background/60 shadow-[0_10px_30px_-8px_rgb(0_0_0/0.3),inset_0_1px_0_rgb(255_255_255/0.6)] backdrop-blur-2xl backdrop-saturate-[1.8] dark:border-white/12 dark:bg-card/60 dark:shadow-[0_10px_30px_-8px_rgb(0_0_0/0.7),inset_0_1px_0_rgb(255_255_255/0.12)]";

/** The page shrinks to make room for the keyboard, so a much shorter window than the tallest seen at this width means it's up. */
function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let width = window.innerWidth;
    let tallest = window.innerHeight;
    const onResize = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = 0;
      }
      tallest = Math.max(tallest, window.innerHeight);
      setOpen(window.innerHeight < tallest - 150);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return open;
}

/** The glass pill of tabs, and beside it the round button that starts a chat. Hidden while the keyboard is up. */
export function PhoneDock({ page, onTab, onNew }: { page: Page; onTab: (page: Page) => void; onNew: () => void }) {
  if (useKeyboardOpen()) return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex items-center justify-center gap-2">
      <nav aria-label="Main" className={cn("pointer-events-auto flex max-w-[calc(18rem+10px)] min-w-0 flex-1 rounded-full p-1", glass)}>
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = page === id;
          return (
            <motion.button
              key={id}
              type="button"
              onClick={() => onTab(id)}
              aria-current={active ? "page" : undefined}
              whileTap={{ scale: 0.94 }}
              transition={spring}
              className={cn(
                "relative flex h-12 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10.5px] leading-3.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                active ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
              )}
            >
              {active && <motion.span layoutId="dock-active" transition={spring} className="absolute inset-0 rounded-full bg-foreground/10" />}
              <Icon className={cn("relative size-5", active && "text-brand")} strokeWidth={active ? 2.25 : 1.75} />
              <span className="relative max-w-full truncate px-0.5">{label}</span>
            </motion.button>
          );
        })}
      </nav>
      <motion.button
        type="button"
        onClick={onNew}
        aria-label="New chat"
        whileTap={{ scale: 1.08 }}
        transition={spring}
        className="pointer-events-auto flex size-14 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-[0_10px_24px_-8px_color-mix(in_oklch,var(--brand)_70%,transparent)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <PlusIcon className="size-6.5" />
      </motion.button>
    </div>
  );
}

/** Sessions listed for the user: started, not incognito, and not one of the threads a page keeps for itself. */
function useListedSessions(conversations: Conversation[]) {
  const reports = useReportThreads();
  const notebooks = useNotebookThreads();
  const crm = useCrmThreads();
  const steps = useStepThreadIds();
  return useMemo(
    () =>
      conversations
        .filter((c) => c.messages.length > 0 && !c.incognito && !reports.has(c.id) && !notebooks.has(c.id) && !crm.has(c.id) && !steps.has(c.id))
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt),
    [conversations, reports, notebooks, crm, steps],
  );
}

function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A chat in a list: its title, how long ago, and whether it's working or waiting for you. */
function ChatRow({
  conversation: c,
  onOpen,
  onDelete,
  menu = true,
}: {
  conversation: Conversation;
  onOpen: (id: string) => void;
  onDelete?: (id: string) => void;
  menu?: boolean;
}) {
  const status = useSessionStatus(c.id);
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => onOpen(c.id)} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left active:bg-foreground/5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{c.title}</span>
        </span>
        {status === "working" ? (
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Working" />
        ) : status === "needs-input" ? (
          <span className="size-2.5 shrink-0 rounded-full bg-brand" aria-label="Waiting for you" />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(c.updatedAt)}</span>
        )}
      </button>
      {menu && onDelete && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`${c.title}: more`} className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-foreground/5">
              <MoreHorizontalIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <SessionMenuItems conversation={c} onOpen={onOpen} onDelete={onDelete} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** A bento tile: an icon on its colour, a label, and a line of what's there. */
function Tile({
  icon: Icon,
  label,
  value,
  tint,
  onClick,
  dot,
  tall,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  /** The icon's colour: a CSS colour or variable. */
  tint: string;
  onClick: () => void;
  dot?: boolean;
  /** A tall tile, with its icon large in the middle. */
  tall?: boolean;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      transition={spring}
      className={cn("relative flex min-h-28 min-w-0 flex-col items-start rounded-3xl border bg-card p-4 text-left shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}
    >
      <span className="flex size-10 items-center justify-center rounded-2xl" style={{ backgroundColor: `color-mix(in oklch, ${tint} 16%, transparent)`, color: tint }}>
        <Icon className="size-5" />
      </span>
      {tall && <Icon aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 size-20 -translate-x-1/2 -translate-y-1/3 opacity-15" style={{ color: tint }} strokeWidth={1.25} />}
      {dot && <span className="absolute top-4 right-4 size-2.5 rounded-full bg-brand" aria-label="New" />}
      <span className="mt-auto pt-3 text-[15px] font-semibold">{label}</span>
      <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{value}</span>
    </motion.button>
  );
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function partOfDay() {
  const hour = new Date().getHours();
  return hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** Home on a phone: a bento of everything, with what you'd most likely do first at the top. */
export function PhoneHome({
  conversations,
  hasProviders,
  name,
  onOpenPage,
  onOpenSession,
  onAsk,
  onIncognito,
}: {
  conversations: Conversation[];
  hasProviders: boolean | null;
  name?: string;
  onOpenPage: (page: Page) => void;
  onOpenSession: (id: string) => void;
  /** Start a chat with the composer focused. */
  onAsk: () => void;
  onIncognito: () => void;
}) {
  const recent = useListedSessions(conversations).slice(0, 4);
  const tasks = useTasks();
  const docs = useDocs();
  const notebooks = useNotebooks();
  const automations = useAutomations();
  useConnectors();
  const connected = availableConnectors().filter((c) => c.enabled).length;
  const open = tasks.filter((t) => t.status !== "done").length;
  const first = name?.trim().split(/\s+/)[0];

  return (
    <div className="grid grid-cols-2 gap-3 px-4 pt-3 pb-28">
      <header className="col-span-2 flex items-end justify-between gap-3 px-1 pb-1">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1 className="mt-0.5 text-3xl font-semibold tracking-tight text-balance">
            {partOfDay()}
            {first ? `, ${first}` : ""}
          </h1>
        </div>
        <button
          type="button"
          aria-label="Settings"
          onClick={() => openSettings({ section: "general" })}
          className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground active:bg-muted"
        >
          <SettingsIcon className="size-5" />
        </button>
      </header>

      {hasProviders === false && (
        <button
          type="button"
          onClick={() => openSettings({ section: "providers" })}
          className="col-span-2 rounded-3xl border border-coral/40 bg-coral/10 px-4 py-3 text-left text-sm"
        >
          <span className="font-semibold">Connect a model to start.</span> <span className="text-muted-foreground">Add OpenAI, Anthropic, xAI, or any compatible endpoint.</span>
        </button>
      )}

      {/* The ask box: Sushi stands on it, as on the composer. */}
      <div className="relative col-span-2 mt-8">
        <Mascot busy={false} draft="" className="absolute right-8 bottom-full -mb-px" />
        <button
          type="button"
          onClick={onAsk}
          className="flex w-full items-center gap-3 rounded-3xl border bg-card py-3 pr-3 pl-5 text-left shadow-[0_8px_24px_-12px_rgb(0_0_0/0.15),0_24px_56px_-28px_color-mix(in_oklch,var(--brand)_35%,transparent)]"
        >
          <span className="flex-1 text-[15px] text-muted-foreground">Ask Sush anything…</span>
          <span className="flex size-10 items-center justify-center rounded-full bg-brand text-brand-foreground">
            <ArrowUpIcon className="size-5" />
          </span>
        </button>
      </div>

      <section className="col-span-2 overflow-hidden rounded-3xl border bg-card shadow-xs">
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <h2 className="text-sm font-semibold">Recent chats</h2>
          {recent.length > 0 && (
            <button type="button" className="-mr-1 rounded-full px-2 py-1 text-sm text-brand active:bg-muted" onClick={() => onOpenPage("chats")}>
              See all
            </button>
          )}
        </div>
        {recent.length > 0 ? (
          <div className="px-1 pb-1">
            {recent.map((c) => (
              <ChatRow key={c.id} conversation={c} onOpen={onOpenSession} menu={false} />
            ))}
          </div>
        ) : (
          <p className="px-4 pt-1 pb-4 text-xs leading-relaxed text-muted-foreground">Your chats land here, so you can pick one up again.</p>
        )}
      </section>

      <Tile icon={KanbanIcon} label="Board" value={open ? `${count(open, "open task")}` : "Plan your tasks"} tint="var(--brand)" onClick={() => onOpenPage("board")} />
      <Tile icon={FileTextIcon} label="Docs" value={docs.length ? count(docs.length, "doc") : "Write with Sush"} tint="oklch(0.6 0.18 255)" onClick={() => onOpenPage("docs")} />
      <Tile
        icon={NotebookTextIcon}
        label="Binders"
        value={notebooks.length ? count(notebooks.length, "binder") : "Chat with your sources"}
        tint="oklch(0.6 0.2 293)"
        onClick={() => onOpenPage("notebooks")}
        tall
        className="row-span-2 min-h-full"
      />
      <Tile
        icon={TimerIcon}
        label="Automations"
        value={automations.length ? count(automations.length, "automation") : "Run on a schedule"}
        tint="oklch(0.72 0.14 50)"
        dot={automations.some((a) => a.unseen)}
        onClick={() => onOpenPage("automations")}
      />
      <Tile icon={PlugIcon} label="Connectors" value={connected ? `${connected} connected` : "Connect your apps"} tint="oklch(0.63 0.15 150)" onClick={() => onOpenPage("connectors")} />
      <Tile icon={ContactIcon} label="CRM" value="Companies and deals" tint="oklch(0.66 0.2 355)" onClick={() => onOpenPage("crm")} />
      <Tile icon={WorkflowIcon} label="Workflows" value="Steps that run themselves" tint="oklch(0.48 0.08 195)" onClick={() => onOpenPage("workflows")} />
      <Tile icon={GhostIcon} label="Incognito" value="A chat that isn't kept" tint="var(--muted-foreground)" onClick={onIncognito} />
      <Tile icon={LogInIcon} label="Join a session" value="Someone shared with you" tint="var(--coral)" onClick={openJoin} />
    </div>
  );
}

/** Every chat, searchable, with projects as filters. */
export function PhoneChats({
  conversations,
  onOpenSession,
  onDelete,
}: {
  conversations: Conversation[];
  onOpenSession: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const listed = useListedSessions(conversations);
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = listed.filter((c) => (!project || c.projectId === project) && (!q || c.title.toLowerCase().includes(q)));

  return (
    <div className="flex flex-col gap-3 px-4 pt-3 pb-28">
      <h1 className="px-1 text-3xl font-semibold tracking-tight">Chats</h1>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="h-11 w-full rounded-full border bg-card pr-4 pl-10 text-[15px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>
      {projects.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 scrollbar-hide">
          {[{ id: null, name: "All" }, ...projects].map((p) => (
            <button
              key={p.id ?? "all"}
              type="button"
              onClick={() => setProject(p.id)}
              className={cn(
                "h-8 shrink-0 rounded-full border px-3 text-sm",
                project === p.id ? "border-transparent bg-foreground text-background" : "bg-card text-muted-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <section className="overflow-hidden rounded-3xl border bg-card p-1 shadow-xs">
        {shown.map((c) => (
          <ChatRow key={c.id} conversation={c} onOpen={onOpenSession} onDelete={onDelete} />
        ))}
        {shown.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{q || project ? "No chats match." : "No chats yet. Tap + to start one."}</p>
        )}
      </section>
    </div>
  );
}
