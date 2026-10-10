import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  LogOutIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
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
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut, useSession } from "@/lib/auth";
import { openSettings } from "@/lib/library";
import { togglePinned, useRunningId, type Conversation } from "@/lib/store";

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

interface AppSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

export function AppSidebar({ conversations, activeId, onSelect, onNew, onDelete, onOpenSettings }: AppSidebarProps) {
  const { data: session } = useSession();
  const [query, setQuery] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The blank chat behind "New session" isn't listed until something is sent.
  const started = conversations.filter((c) => c.messages.length > 0);
  const matches = query === null ? started : started.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));
  const pinned = matches.filter((c) => c.pinned);
  const rest = matches.filter((c) => !c.pinned);
  const visible = showAll || query !== null ? rest : rest.slice(0, RECENT_LIMIT);

  const row = (c: Conversation) => (
    <SessionRow key={c.id} conversation={c} active={c.id === activeId} onSelect={onSelect} onDelete={onDelete} />
  );

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="New session" onClick={onNew}>
                <PlusIcon /> <span>New session</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {PLANNED.map(({ label, icon: Icon }) => (
              <SidebarMenuItem key={label}>
                <SidebarMenuButton tooltip={label} onClick={() => comingSoon(label)}>
                  <Icon /> <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            <SidebarMenuItem>
              <MoreMenu onOpenSettings={onOpenSettings} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <div className="flex items-center pr-1">
            <SidebarGroupLabel className="flex-1 text-sm text-sidebar-foreground">Sessions</SidebarGroupLabel>
            <HeaderAction label="New session" onClick={onNew}>
              <PlusIcon />
            </HeaderAction>
            <HeaderAction label="Search sessions" onClick={() => setQuery(query === null ? "" : null)}>
              <SearchIcon />
            </HeaderAction>
            <SessionsMenu showAll={showAll} onToggleShowAll={() => setShowAll(!showAll)} onNew={onNew} />
          </div>

          {query !== null && (
            <div className="relative mb-1">
              <SidebarInput
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
                placeholder="Search sessions"
                className="pr-8"
              />
              <SidebarMenuAction aria-label="Close search" onClick={() => setQuery(null)}>
                <XIcon />
              </SidebarMenuAction>
            </div>
          )}

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
            {query === null && rest.length > RECENT_LIMIT && (
              <SidebarMenuItem>
                <SidebarMenuButton className="text-muted-foreground" onClick={() => setShowAll(!showAll)}>
                  <MoreHorizontalIcon /> <span>{showAll ? "Show less" : "More"}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {query !== null && matches.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No sessions found</p>
            )}
            {query === null && started.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No sessions yet</p>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ProfileMenu
              name={session?.user.name || "Sush"}
              email={session?.user.email ?? "Local workspace"}
              onOpenSettings={onOpenSettings}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
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
  const running = useRunningId() === c.id;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={() => onSelect(c.id)}>
        {running && <LoaderCircleIcon className="animate-spin text-muted-foreground" />}
        <span>{c.title}</span>
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

/** Small icon button for group headers and the footer. */
function HeaderAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
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
            <button
              type="button"
              aria-label="Session options"
              className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent [&>svg]:size-4"
            >
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

/** Footer account button; opens upward with settings, help and sign-out. */
function ProfileMenu({ name, email, onOpenSettings }: { name: string; email: string; onOpenSettings: () => void }) {
  const { isMobile } = useSidebar();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <img src="/sush-mark.png" alt="" className="aspect-square size-8 rounded-lg" />
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
        <DropdownMenuItem onSelect={onOpenSettings}>
          <SettingsIcon /> <span>Settings</span>
        </DropdownMenuItem>
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

/** The nav's "More": theme and settings, which used to sit in the footer. */
function MoreMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { isMobile } = useSidebar();
  const { theme = "system", setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          tooltip="More"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <MoreHorizontalIcon /> <span>More</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44" side={isMobile ? "bottom" : "right"} align="start" sideOffset={4}>
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon /> {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings({ section: "skills" })}>
          <SlidersHorizontalIcon /> <span>Customize</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenSettings}>
          <SettingsIcon /> <span>Settings</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
