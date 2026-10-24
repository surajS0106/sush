// Shared sessions in the app's chrome: the sidebar's "Shared with you" group
// and its join dialog, who's watching in the header, and the bar a guest sees
// in place of the composer. The share dialog itself is `share-dialog.tsx`.

import { EyeIcon, LogInIcon, PlusIcon, RadioIcon, XIcon } from "lucide-react";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { toast } from "sonner";

import { toolbarButtonClass } from "@/components/nav-controls";
import { openShare } from "@/components/session-actions";
import { ShareAccountSetup } from "@/components/share-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { isLive, joinShare, leaveShare, safeImage, useJoinedShares, useShare, useShareAccount, watchers } from "@/lib/share";
import { createStore } from "@/lib/store";
import { errorMessage, type ShareView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const joining = createStore<boolean>("sush.joinDialog", false, false);
export const openJoin = () => joining.set(true);

/** Paste an invite link, set up the relay account first if needed, and open the share. */
export function JoinSessionDialog({ onJoined }: { onJoined: (threadId: string) => void }) {
  const open = useSyncExternalStore(joining.subscribe, joining.get);
  const account = useShareAccount();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    joining.set(false);
    setLink("");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const threadId = await joinShare(link);
      close();
      onJoined(threadId);
    } catch (err) {
      toast.error("Couldn’t join", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Join a shared session</DialogTitle>
          <DialogDescription>Watch someone’s session live. They let you in once you ask.</DialogDescription>
        </DialogHeader>
        {account?.user ? (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Input
              autoFocus
              aria-label="Invite link"
              placeholder="Paste the invite link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              spellCheck={false}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !link.trim()}>
                <LogInIcon /> Join
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <ShareAccountSetup />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The sidebar's "Shared with you": sessions joined here, and a way to join one. */
export function SharedGroup({ activeId, onOpen }: { activeId: string | null; onOpen: (threadId: string) => void }) {
  const joined = useJoinedShares();
  return (
    <SidebarGroup>
      <div className="flex items-center pr-1">
        <SidebarGroupLabel className="flex-1 text-sm text-sidebar-foreground">Shared with you</SidebarGroupLabel>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Join a shared session" className={toolbarButtonClass} onClick={openJoin}>
              <PlusIcon />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Join a shared session</TooltipContent>
        </Tooltip>
      </div>
      <SidebarMenu>
        {joined.map((s) => (
          <SidebarMenuItem key={s.threadId}>
            <SidebarMenuButton isActive={s.threadId === activeId} onClick={() => onOpen(s.threadId)}>
              <EyeIcon />
              <span className="truncate">{s.thread.title || "Shared session"}</span>
              <StatusMark share={s} />
            </SidebarMenuButton>
            <SidebarMenuAction showOnHover aria-label="Leave" onClick={() => void leaveShare(s.threadId)}>
              <XIcon />
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
        {joined.length === 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton className="text-muted-foreground" onClick={openJoin}>
              <LogInIcon /> <span>Join shared session…</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function StatusMark({ share }: { share: ShareView }) {
  if (share.status === "live") return <span className="ml-auto size-1.5 shrink-0 rounded-full bg-brand" aria-label="Live" />;
  const label = share.status === "lobby" ? "waiting" : share.status === "ended" ? "ended" : "offline";
  return <span className="ml-auto shrink-0 text-xs text-muted-foreground">{label}</span>;
}

/**
 * Who's watching, in the header. For the host it opens the share dialog and
 * counts anyone waiting to be let in; a guest sees the host and the others.
 */
export function SharePresence({ threadId }: { threadId: string }) {
  const share = useShare(threadId);
  if (!isLive(share)) return null;
  const host = share.role === "owner";
  const people = watchers(share).filter((m) => !host || m.role !== "owner");
  const shown = people.slice(0, 4);
  const names = people.map((m) => (m.role === "owner" ? `${m.name} (host)` : m.name)).join(", ");
  const label = host
    ? people.length === 0
      ? "Shared live: nobody watching yet"
      : `Watching: ${names}`
    : `${share.thread.hostName}’s session · ${names || "nobody else"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={host ? () => openShare(threadId) : undefined}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs text-muted-foreground",
            host && "hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          <RadioIcon className={cn("size-3.5", share.status === "live" ? "text-brand" : "opacity-50")} />
          <span>{host ? "Live" : "Watching"}</span>
          {shown.length > 0 && (
            <span className="flex -space-x-1.5">
              {shown.map((m) => (
                <UserAvatar key={m.userId} image={safeImage(m.image)} name={m.name} className="size-5 text-[10px] ring-2 ring-background" />
              ))}
            </span>
          )}
          {people.length > shown.length && <span>+{people.length - shown.length}</span>}
          {host && share.lobby.length > 0 && (
            <span className="rounded-full bg-brand px-1.5 text-[10px] font-medium text-brand-foreground">{share.lobby.length} waiting</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** In place of the composer: whose session this is, and how it's going. */
export function WatchingBar({ share }: { share: ShareView }) {
  const text =
    share.status === "lobby"
      ? `Waiting for ${share.thread.hostName} to let you in…`
      : share.status === "ended"
        ? (share.ended ?? "This shared session has ended.")
        : share.status === "live"
          ? `You’re watching ${share.thread.hostName}’s session. Only they can send messages or approve actions.`
          : (share.error ?? "Connecting…");
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-dashed border-foreground/20 px-4 py-3 text-sm text-muted-foreground">
      <EyeIcon className="size-4 shrink-0" />
      <span className="flex-1">{text}</span>
      <Button variant="ghost" size="sm" className="h-7 rounded-full text-xs" onClick={() => void leaveShare(share.threadId)}>
        Leave
      </Button>
    </div>
  );
}
