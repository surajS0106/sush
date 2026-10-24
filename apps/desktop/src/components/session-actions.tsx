// What can be done to a session (open in a new window or another app, rename,
// fork, file under a project, pin, delete), shared by the sidebar's row menu and the title bar's menu; the
// dialogs those open; and the incognito toggle.

import { CheckIcon, ChevronDownIcon, GhostIcon, UsersIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { toolbarButtonClass } from "@/components/nav-controls";
import { ShareDialog } from "@/components/share-dialog";
import { IS_MAC } from "@/components/window-controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createProject, deleteProject, getProject, updateProject, useProjects } from "@/lib/projects";
import { isReportThread } from "@/lib/reports";
import {
  createStore,
  forkConversation,
  getConversations,
  renameConversation,
  saveForAnotherWindow,
  setConversationProject,
  togglePinned,
  type Conversation,
} from "@/lib/store";
import { api, errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- dialogs ------------------------------------------------------------------------

/** Menus close as an item is picked, so the dialogs they open live here, mounted once (`SessionDialogs`). */
type DialogRequest =
  | { kind: "rename"; conversationId: string }
  /** A new project (`projectId` unset) or an existing one; `fileChat` is moved into a new project once it's made. */
  | { kind: "project"; projectId?: string; fileChat?: string }
  | { kind: "delete-project"; projectId: string }
  | { kind: "share"; conversationId: string };

const dialog = createStore<DialogRequest | null>("sush.sessionDialog", null, false);

export const openRename = (conversationId: string) => dialog.set({ kind: "rename", conversationId });
/** Share a session live (`components/share-dialog.tsx`). */
export const openShare = (conversationId: string) => dialog.set({ kind: "share", conversationId });
export const openProjectEditor = (projectId?: string, fileChat?: string) => dialog.set({ kind: "project", projectId, fileChat });
export const confirmDeleteProject = (projectId: string) => dialog.set({ kind: "delete-project", projectId });

/** The tab being renamed in place (double-click, or Rename in the tab's menu); per window. */
const tabRename = createStore<string | null>("sush.tabRename", null, false);
export const useTabRename = () => useSyncExternalStore(tabRename.subscribe, tabRename.get);
export const renameTab = (id: string | null) => tabRename.set(id);

/** The session whose tab menu was asked for by a right-click (two-finger click) on its tab. */
const menuRequest = createStore<string | null>("sush.sessionMenuRequest", null, false);
export const openTabMenu = (id: string) => menuRequest.set(id);

export function SessionDialogs() {
  useMenuShortcuts();
  const request = useSyncExternalStore(dialog.subscribe, dialog.get);
  const close = () => dialog.set(null);
  return (
    <>
      <RenameDialog conversationId={request?.kind === "rename" ? request.conversationId : null} onClose={close} />
      <ProjectDialog request={request?.kind === "project" ? request : null} onClose={close} />
      <DeleteProjectDialog projectId={request?.kind === "delete-project" ? request.projectId : null} onClose={close} />
      <ShareDialog threadId={request?.kind === "share" ? request.conversationId : null} onClose={close} />
    </>
  );
}

function RenameDialog({ conversationId, onClose }: { conversationId: string | null; onClose: () => void }) {
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (conversationId) setTitle(getConversations().find((c) => c.id === conversationId)?.title ?? "");
  }, [conversationId]);
  const save = () => {
    if (conversationId) renameConversation(conversationId, title);
    onClose();
  };
  return (
    <Dialog open={!!conversationId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Name" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectDialog({ request, onClose }: { request: Extract<DialogRequest, { kind: "project" }> | null; onClose: () => void }) {
  const existing = getProject(request?.projectId);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  useEffect(() => {
    if (!request) return;
    setName(existing?.name ?? "");
    setInstructions(existing?.instructions ?? "");
  }, [request]);
  const save = () => {
    if (existing) updateProject(existing.id, { name, instructions });
    else {
      const project = createProject(name, instructions);
      if (request?.fileChat) setConversationProject(request.fileChat, project.id);
    }
    onClose();
  };
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>Keep related chats together. Every chat in the project follows its instructions.</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Job search" />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Instructions (optional)</span>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="How should Sush work in this project? Tone, context, things to always or never do."
              className="max-h-64 min-h-28"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {existing ? "Save" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const project = getProject(projectId ?? undefined);
  return (
    <Dialog open={!!projectId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{project?.name}”?</DialogTitle>
          <DialogDescription>Its chats are kept and go back to your sessions. Its instructions are deleted.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (projectId) deleteProject(projectId);
              onClose();
            }}
          >
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- menus --------------------------------------------------------------------------

/** The system file manager's name, for "Open in". */
const FILE_MANAGER = IS_MAC ? "Finder" : navigator.userAgent.includes("Windows") ? "File Explorer" : "Files";

const openIn = (run: () => Promise<void>) =>
  run().catch((e) => toast.error("Couldn’t open it", { description: errorMessage(e) }));

/** Open a session in a window of its own; incognito chats can't, their messages are in no other window's copy. */
const openInNewWindow = (id: string) =>
  openIn(async () => {
    await saveForAnotherWindow(id);
    await api.sessionWindow(id);
  });

/**
 * Pressing an item's shortcut key (`data-shortcut`) while a session menu is open
 * picks it, as clicking it would. Listens on the window in the capture phase, so
 * it works wherever focus is and runs before Radix's type-ahead. The focused menu
 * (a submenu, say) is searched first, then the other open menus.
 */
function useMenuShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      const open = [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"]')];
      if (open.length === 0) return;
      const focused = document.activeElement?.closest<HTMLElement>('[role="menu"]');
      const menus = focused ? [focused, ...open.filter((m) => m !== focused)] : open.reverse();
      const selector = `[data-shortcut="${CSS.escape(e.key.toLowerCase())}"]:not([data-disabled])`;
      for (const menu of menus) {
        const item = menu.querySelector<HTMLElement>(selector);
        if (!item) continue;
        e.preventDefault();
        e.stopPropagation();
        item.click();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** A session's actions, as items for a `DropdownMenuContent`. */
export function SessionMenuItems({
  conversation: c,
  onOpen,
  onDelete,
  onRename = openRename,
}: {
  conversation: Conversation;
  /** Open a session (the fork). */
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Rename it: the dialog, unless the menu belongs to something that can be renamed in place. */
  onRename?: (id: string) => void;
}) {
  const projects = useProjects();
  const started = c.messages.length > 0;
  const workspaceId = c.workspaceId;
  return (
    <>
      {(!c.incognito || workspaceId) && (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Open in</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {!c.incognito && (
                <DropdownMenuItem data-shortcut="1" onSelect={() => void openInNewWindow(c.id)}>
                  New window <DropdownMenuShortcut>1</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {workspaceId && (
                <>
                  {!c.incognito && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>Open in</DropdownMenuLabel>
                  <DropdownMenuItem data-shortcut="2" onSelect={() => void openIn(() => api.workspaceOpenIn(workspaceId, "vscode"))}>
                    VS Code <DropdownMenuShortcut>2</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem data-shortcut="3" onSelect={() => void openIn(() => api.workspaceOpenIn(workspaceId, "files"))}>
                    {FILE_MANAGER} <DropdownMenuShortcut>3</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
        </>
      )}
      {/* Incognito chats are never shared; nor are reports (kept out of the session list anyway). */}
      {!c.incognito && !isReportThread(c.id) && (
        <>
          <DropdownMenuItem data-shortcut="s" onSelect={() => openShare(c.id)}>
            <UsersIcon /> Share live… <DropdownMenuShortcut>S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem data-shortcut="r" onSelect={() => onRename(c.id)}>
        Rename <DropdownMenuShortcut>R</DropdownMenuShortcut>
      </DropdownMenuItem>
      {/* Incognito chats can't fork: their messages are only in the run's memory. */}
      {!c.incognito && (
        <>
          <DropdownMenuItem
            data-shortcut="f"
            disabled={!started}
            onSelect={() => {
              const fork = forkConversation(c.id);
              if (fork) onOpen(fork.id);
            }}
          >
            Fork <DropdownMenuShortcut>F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{c.projectId ? "Move to project" : "Add to project"}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} disabled={p.id === c.projectId} onSelect={() => setConversationProject(c.id, p.id)}>
                  <span className="truncate">{p.name}</span>
                  {p.id === c.projectId && <CheckIcon className="ml-auto text-muted-foreground" />}
                </DropdownMenuItem>
              ))}
              {projects.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => openProjectEditor(undefined, c.id)}>New project…</DropdownMenuItem>
              {c.projectId && (
                <DropdownMenuItem onSelect={() => setConversationProject(c.id, undefined)}>Remove from project</DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem data-shortcut="p" onSelect={() => togglePinned(c.id)}>
            {c.pinned ? "Unpin" : "Pin"} <DropdownMenuShortcut>P</DropdownMenuShortcut>
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem data-shortcut="d" variant="destructive" onSelect={() => onDelete(c.id)}>
        Delete <DropdownMenuShortcut>D</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  );
}

/**
 * The chevron inside the active tab, next to its title: the open session's actions.
 * A right-click (two-finger click) on the tab opens it too (`openTabMenu`), and its
 * Rename renames the tab in place.
 */
export function SessionMenu({
  conversation,
  onOpen,
  onDelete,
}: {
  conversation: Conversation;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const requested = useSyncExternalStore(menuRequest.subscribe, menuRequest.get);
  useEffect(() => {
    if (requested !== conversation.id) return;
    menuRequest.set(null);
    setOpen(true);
  }, [requested, conversation.id]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Session actions"
              // Keep a press here from selecting or dragging the tab; the menu still opens.
              onPointerDown={(e) => e.stopPropagation()}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Session actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        className="w-52"
        align="start"
        // Renaming in place: don't hand focus back to the chevron, or the title's input loses it.
        onCloseAutoFocus={(e) => {
          if (tabRename.get()) e.preventDefault();
        }}
      >
        <SessionMenuItems conversation={conversation} onOpen={onOpen} onDelete={onDelete} onRename={renameTab} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ghost in the title bar: start an incognito chat, or leave the one that's open. */
export function IncognitoToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const label = active ? "Leave incognito" : "Incognito chat";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onToggle}
          className={cn(toolbarButtonClass, active && "bg-foreground text-background hover:bg-foreground/90 hover:text-background")}
        >
          <GhostIcon />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
