// The row above a new session's composer: where it runs, which folder it
// works in (none makes it a plain chat), the folder's git branch and whether
// the session gets its own worktree, and adding a folder. Only an untouched
// session can switch; once it has messages, its folder is fixed.

import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LaptopIcon,
  MessageSquareIcon,
  PlayIcon,
  Undo2Icon,
} from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setConversationWorkspace } from "@/lib/store";
import { errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  addWorkspace,
  finishRebase,
  setPendingWorktree,
  switchBranch,
  useGitInfo,
  usePendingWorktree,
  useSandboxStatus,
  useWorkspaces,
} from "@/lib/workspaces";

const CHIP =
  "flex h-7 items-center gap-1.5 rounded-lg border border-foreground/10 bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:border-white/10 dark:bg-card";

export function SessionOptions({ conversationId, workspaceId }: { conversationId: string; workspaceId?: string }) {
  const workspaces = useWorkspaces();
  const sandbox = useSandboxStatus();
  const current = workspaces.find((w) => w.id === workspaceId);
  const pick = (id: string | undefined) => setConversationWorkspace(conversationId, id);
  const add = async () => {
    try {
      const w = await addWorkspace();
      if (w) pick(w.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-1 pb-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(CHIP, "cursor-default hover:bg-background dark:hover:bg-card")}>
            <LaptopIcon className="size-3.5" />
            Local
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {!current
            ? "Runs on this computer; chats are saved here."
            : sandbox === null
              ? "Runs on this computer. Checking the sandbox…"
              : sandbox.available
                ? `Runs on this computer. Commands are sandboxed (${sandbox.mechanism}).`
                : "Runs on this computer. No sandbox here, so every command asks first."}
        </TooltipContent>
      </Tooltip>

      <FolderMenu conversationId={conversationId} workspaceId={workspaceId}>
        <button type="button" className={cn(CHIP, "max-w-56")} title={current?.root}>
          {current ? <FolderIcon className="size-3.5 shrink-0" /> : <MessageSquareIcon className="size-3.5 shrink-0" />}
          <span className="truncate">{current ? current.name : "No folder"}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
        </button>
      </FolderMenu>

      {current && <GitOptions conversationId={conversationId} workspaceId={current.id} />}

      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="Add a folder" className={cn(CHIP, "px-2")} onClick={() => void add()}>
            <FolderPlusIcon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Add a folder</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The folder switcher: chat only, a known folder, or a new one. `children` is the trigger button. */
export function FolderMenu({
  conversationId,
  workspaceId,
  children,
}: {
  conversationId: string;
  workspaceId?: string;
  children: React.ReactElement;
}) {
  const workspaces = useWorkspaces();
  const current = workspaces.find((w) => w.id === workspaceId);
  const pick = (id: string | undefined) => setConversationWorkspace(conversationId, id);
  const add = async () => {
    try {
      const w = await addWorkspace();
      if (w) pick(w.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => pick(undefined)}>
          <MessageSquareIcon />
          <span className="flex-1">Chat only</span>
          {!current && <CheckIcon className="text-muted-foreground" />}
        </DropdownMenuItem>
        {workspaces.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Work in a folder</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onSelect={() => pick(w.id)} title={w.root}>
                <FolderIcon />
                <span className="flex-1 truncate">{w.name}</span>
                {w.id === current?.id && <CheckIcon className="text-muted-foreground" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void add()}>
          <FolderPlusIcon /> <span>Add a folder…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The folder's branch and the worktree switch. Without a worktree, picking a
 * branch checks it out in the folder; with one, it's the branch the new
 * worktree starts from, and the folder is left alone.
 */
function GitOptions({ conversationId, workspaceId }: { conversationId: string; workspaceId: string }) {
  const git = useGitInfo(workspaceId);
  const pendingBase = usePendingWorktree(conversationId);
  if (!git) return null;

  const branch = pendingBase ?? git.branch;
  // HEAD is detached mid-rebase, so git won't switch until it's finished or abandoned.
  const rebasing = !pendingBase && !git.branch ? git.rebasing : null;
  const rebase = (abort: boolean) =>
    finishRebase(workspaceId, abort).then(
      (msg) => toast.success(msg),
      (e) => toast.error(abort ? "Couldn’t abort the rebase" : "Couldn’t continue the rebase", { description: errorMessage(e) }),
    );
  const pick = (b: string) => {
    if (pendingBase) return setPendingWorktree(conversationId, b);
    if (b === git.branch) return;
    switchBranch(workspaceId, b).catch((e) => toast.error(`Couldn’t switch to ${b}`, { description: errorMessage(e) }));
  };
  const toggleWorktree = () =>
    setPendingWorktree(conversationId, pendingBase ? undefined : (git.branch ?? git.branches[0]));

  return (
    <div className={cn(CHIP, "gap-0 px-0 hover:bg-background hover:text-muted-foreground dark:hover:bg-card")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-full max-w-44 items-center gap-1.5 rounded-l-lg px-2.5 hover:text-foreground"
            title={
              pendingBase
                ? `The new worktree starts from ${pendingBase}`
                : !branch && git.rebasing
                  ? `A rebase of ${git.rebasing} stopped partway. Continue or abort it from this menu.`
                  : "The branch checked out in this folder"
            }
          >
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="truncate">{branch ?? (git.rebasing ? `rebasing ${git.rebasing}` : "detached")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
          {rebasing && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                A rebase of {rebasing} stopped partway
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void rebase(false)}>
                <PlayIcon /> <span>Continue the rebase</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void rebase(true)}>
                <Undo2Icon /> <span>Abort the rebase</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {pendingBase ? "Start the worktree from" : rebasing ? "Finish the rebase to switch branch" : "Switch branch"}
          </DropdownMenuLabel>
          {git.branches.map((b) => (
            <DropdownMenuItem key={b} disabled={!!rebasing} onSelect={() => pick(b)}>
              <GitBranchIcon />
              <span className="flex-1 truncate">{b}</span>
              {b === branch && <CheckIcon className="text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="h-3.5 w-px bg-foreground/10 dark:bg-white/10" />
      {git.worktree ? (
        <span className="px-2.5" title="This folder is already a git worktree">
          worktree
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex h-full cursor-pointer items-center gap-1.5 rounded-r-lg px-2.5 hover:text-foreground">
              <input
                type="checkbox"
                checked={!!pendingBase}
                disabled={git.branches.length === 0}
                onChange={toggleWorktree}
                className="size-3 accent-brand"
              />
              worktree
            </label>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            Work in a new git worktree on its own branch, so this session’s changes stay out of your checkout. It’s
            created when you send the first message.
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
