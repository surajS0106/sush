import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  CodeXmlIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LogOutIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SunIcon,
  TimerIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { toast } from "sonner";

import { CoworkStatusBadge, StatusDot } from "@/components/cowork-status-dot";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { NavControls, toolbarButtonClass, type Nav } from "@/components/nav-controls";
import { HoverHighlight } from "@/components/ui/motion-highlight";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { IS_MAC, useTrafficLights } from "@/components/window-controls";
import { transitionTheme } from "@/lib/appearance";
import { signOut, useSession } from "@/lib/auth";
import { SIDEBAR, setLayout, useLayout } from "@/lib/layout";
import { openSettings } from "@/lib/library";
import { errorMessage } from "@/lib/tauri";
import { useCoworkStatus, useSessionStatus } from "@/lib/sessions";
import { addWorkspace, useWorkspaces } from "@/lib/workspaces";
import { togglePinned, type Conversation } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Sessions listed before the "More" toggle. */
const RECENT_LIMIT = 8;

/** Destinations that don't exist yet; they're in the nav so the layout is final. */
const PLANNED = [
  { label: "Automations", icon: TimerIcon },
  { label: "Security", icon: ShieldIcon },
  { label: "Review", icon: GitPullRequestIcon },
  { label: "Wiki", icon: BookOpenIcon },
];

const comingSoon = (what: string) => toast(`${what} is coming soon`);

/** Shown beside "New"; App binds the same key. */
export const NEW_SHORTCUT_LABEL = IS_MAC ? "⌘N" : "Ctrl+N";

/** A plain chat, or a Cowork session working in a folder. */
export type SessionMode = "chat" | "cowork";

interface AppSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Start a Cowork session in a workspace. */
  onNewCowork: (workspaceId: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  nav: Nav;
  /** Whether the open session is a chat or Cowork; the toggle switches. */
  mode: SessionMode;
  onSwitchMode: (mode: SessionMode) => void;
}

/** The sidebar's right edge: drag it to set the width, or on past the minimum to close; double-click puts the default back. */
function SidebarResizer() {
  const { sidebar } = useLayout();
  const { setOpen } = useSidebar();
  return (
    <ResizeHandle
      label="Resize sidebar"
      edge="right"
      min={SIDEBAR.min}
      max={SIDEBAR.max}
      measure={() => sidebar}
      preview={(width) =>
        document.querySelector<HTMLElement>("[data-slot=sidebar-wrapper]")?.style.setProperty("--sidebar-width", `${width}px`)
      }
      onResize={(width) => setLayout({ sidebar: width })}
      onReset={() => setLayout({ sidebar: SIDEBAR.default })}
      onCollapse={(collapsed) => setOpen(!collapsed)}
    />
  );
}

export function AppSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onNewCowork,
  onDelete,
  onOpenSettings,
  nav,
  mode,
  onSwitchMode,
}: AppSidebarProps) {
  const { data: session } = useSession();
  const trafficLights = useTrafficLights();
  // Empty means no filter; the field is always shown.
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const [showAll, setShowAll] = useState(false);
  // The blank chat behind "New session" isn't listed until something is sent.
  const started = conversations.filter((c) => c.messages.length > 0);
  const matches = searching ? started.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())) : started;
  const pinned = matches.filter((c) => c.pinned);
  const rest = matches.filter((c) => !c.pinned);
  const visible = showAll || searching ? rest : rest.slice(0, RECENT_LIMIT);

  const row = (c: Conversation) => (
    <SessionRow key={c.id} conversation={c} active={c.id === activeId} onSelect={onSelect} onDelete={onDelete} />
  );

  return (
    <Sidebar collapsible="offcanvas">
      {/* Title bar: drag to move the window; on macOS the traffic lights sit at its left. */}
      <div data-tauri-drag-region className={cn("flex h-12 shrink-0 items-center gap-0.5 px-2 select-none", trafficLights && "pl-20")}>
        <NavControls nav={nav} />
        <span data-tauri-drag-region className="flex-1 self-stretch" />
        <ModeToggle mode={mode} onChange={onSwitchMode} />
      </div>

      <div className="flex flex-col gap-1 px-2 pb-1">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label="Search sessions"
            className="h-9 rounded-lg pl-8"
          />
          {query && (
            <SidebarMenuAction aria-label="Clear search" className="top-1/2 -translate-y-1/2" onClick={() => setQuery("")}>
              <XIcon />
            </SidebarMenuAction>
          )}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNew} className="h-9 rounded-lg">
              <PlusIcon /> <span>New</span>
              <kbd className="ml-auto font-sans text-xs text-muted-foreground">{NEW_SHORTCUT_LABEL}</kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>

      <SidebarContent>
        {/* One background glides between rows on hover; the buttons' own hover fill is turned off. */}
        <HoverHighlight
          itemSelector='[data-sidebar="menu-item"]'
          className="flex flex-col [&_[data-sidebar=menu-button]:hover]:bg-transparent"
          highlightClassName="rounded-md bg-sidebar-accent"
        >
          <SidebarGroup>
            <SidebarMenu>
              <CoworkMenu onNewCowork={onNewCowork} />
              {PLANNED.map(({ label, icon: Icon }) => (
                <SidebarMenuItem key={label}>
                  <SidebarMenuButton tooltip={label} onClick={() => comingSoon(label)}>
                    <Icon /> <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup>
            <div className="flex items-center pr-1">
              <SidebarGroupLabel className="flex-1 text-sm text-sidebar-foreground">Sessions</SidebarGroupLabel>
              <SessionsMenu showAll={showAll} onToggleShowAll={() => setShowAll(!showAll)} onNew={onNew} />
            </div>

            {pinned.length > 0 && (
              <Collapsible defaultOpen className="group/pinned">
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger className="w-full gap-1.5 hover:bg-sidebar-accent">
                    <PinIcon /> Pinned <span className="tabular-nums">{pinned.length}</span>
                    <ChevronRightIcon className="ml-auto transition-transform group-data-[state=open]/pinned:rotate-90" />
                  </CollapsibleTrigger>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarMenu>{pinned.map(row)}</SidebarMenu>
                </CollapsibleContent>
              </Collapsible>
            )}

            <SidebarMenu>
              {visible.map(row)}
              {!searching && rest.length > RECENT_LIMIT && (
                <SidebarMenuItem>
                  <SidebarMenuButton className="text-muted-foreground" onClick={() => setShowAll(!showAll)}>
                    <MoreHorizontalIcon /> <span>{showAll ? "Show less" : "More"}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {searching && matches.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">No sessions found</p>
              )}
              {!searching && started.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">No sessions yet</p>
              )}
            </SidebarMenu>
          </SidebarGroup>
        </HoverHighlight>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ProfileMenu
              name={session?.user.name || "Sush"}
              email={session?.user.email ?? "Local workspace"}
              image={session?.user.image}
              onOpenSettings={onOpenSettings}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarResizer />
    </Sidebar>
  );
}

const MODES: { value: SessionMode; label: string; icon: typeof MessageSquareIcon }[] = [
  { value: "chat", label: "Chat", icon: MessagesSquareIcon },
  { value: "cowork", label: "Cowork: work in a folder", icon: CodeXmlIcon },
];

/** The Chat / Cowork switch in the sidebar's title bar. */
function ModeToggle({ mode, onChange }: { mode: SessionMode; onChange: (mode: SessionMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Session type" className="flex items-center gap-0.5 rounded-lg bg-sidebar-accent/70 p-0.5">
      {MODES.map(({ value, label, icon: Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={mode === value}
              aria-label={label}
              onClick={() => onChange(value)}
              className={cn(
                "relative flex h-6 w-7 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-3.5",
                mode === value && "bg-background text-sidebar-foreground shadow-xs dark:bg-sidebar",
              )}
            >
              <Icon />
              {value === "cowork" && <CoworkStatusBadge className="size-1.5 ring-0" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** "Cowork": start a session in a folder Sush may work in, or add one. */
function CoworkMenu({ onNewCowork }: { onNewCowork: (workspaceId: string) => void }) {
  const { isMobile } = useSidebar();
  const workspaces = useWorkspaces();
  const status = useCoworkStatus();
  const add = async () => {
    try {
      const w = await addWorkspace();
      if (w) onNewCowork(w.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  if (workspaces.length === 0) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Cowork: work in a folder" onClick={() => void add()}>
          <FolderOpenIcon /> <span>Cowork</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton tooltip="Cowork: work in a folder">
            <FolderOpenIcon /> <span>Cowork</span>
            {status && <StatusDot status={status} className="ml-auto" />}
            <ChevronDownIcon className={cn("size-3.5 text-muted-foreground", !status && "ml-auto")} />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60" side={isMobile ? "bottom" : "right"} align="start">
          <DropdownMenuLabel className="text-xs text-muted-foreground">New session in</DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem key={w.id} onSelect={() => onNewCowork(w.id)} title={w.root}>
              <FolderIcon /> <span className="truncate">{w.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void add()}>
            <FolderPlusIcon /> <span>Add a folder…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function SessionRow({
  conversation: c,
  active,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { isMobile } = useSidebar();
  const status = useSessionStatus(c.id);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={() => onSelect(c.id)}>
        {status === "working" ? (
          <LoaderCircleIcon className="animate-spin text-muted-foreground" />
        ) : (
          c.workspaceId && <FolderIcon className="text-muted-foreground" aria-label="Cowork session" />
        )}
        <span>{c.title}</span>
        {status === "needs-input" && (
          <span className="ml-auto size-2 shrink-0 rounded-full bg-brand" aria-label="Waiting for you" title="Waiting for you" />
        )}
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover className="aria-expanded:bg-muted">
            <MoreHorizontalIcon />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-fit" side={isMobile ? "bottom" : "right"} align={isMobile ? "end" : "start"}>
          <DropdownMenuItem onSelect={() => togglePinned(c.id)}>
            {c.pinned ? <PinOffIcon /> : <PinIcon />} <span>{c.pinned ? "Unpin" : "Pin"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(c.id)}>
            <Trash2Icon /> <span>Delete session</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function SessionsMenu({
  showAll,
  onToggleShowAll,
  onNew,
}: {
  showAll: boolean;
  onToggleShowAll: () => void;
  onNew: () => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Session options" className={toolbarButtonClass}>
              <MoreHorizontalIcon />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Session options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-44" align="end">
        <DropdownMenuItem onSelect={onNew}>
          <PlusIcon /> <span>New session</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleShowAll}>
          <MoreHorizontalIcon /> <span>{showAll ? "Show recent only" : "Show all sessions"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Footer account button; opens upward with theme, settings, help and sign-out. */
function ProfileMenu({
  name,
  email,
  image,
  onOpenSettings,
}: {
  name: string;
  email: string;
  image?: string | null;
  onOpenSettings: () => void;
}) {
  const { isMobile } = useSidebar();
  const { theme = "system", setTheme } = useTheme();
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? MonitorIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          {image ? (
            // `!` beats the menu button's [&_svg]:size-4, which would shrink a sprite avatar.
            <UserAvatar image={image} className="size-8!" />
          ) : (
            <img src="/sush-mark.png" alt="" className="aspect-square size-6" />
          )}
          <span className="flex-1 truncate text-left text-sm font-medium">{name}</span>
          <ChevronDownIcon className="ml-auto text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        side={isMobile ? "bottom" : "top"}
        align="start"
        sideOffset={4}
      >
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ThemeIcon /> <span>Theme</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-36">
            <DropdownMenuRadioGroup value={theme} onValueChange={(t) => transitionTheme(() => setTheme(t))}>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon /> {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => openSettings({ section: "skills" })}>
          <SlidersHorizontalIcon /> <span>Customize</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenSettings}>
          <SettingsIcon /> <span>Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => comingSoon("Help")}>
          <CircleHelpIcon /> <span>Get help</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => comingSoon("Feedback")}>
          <MessageSquareIcon /> <span>Give feedback</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon /> <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const THEMES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];
