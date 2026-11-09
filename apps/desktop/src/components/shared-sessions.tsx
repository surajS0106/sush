// Shared sessions in the app's chrome: the sidebar's "Shared with you" group
// and its join dialog, who's watching in the header, and what a guest has in
// place of the composer: a bar for a viewer, or a composer for a driver (whose
// messages steer the host's run) or a collaborator (whose messages wait as
// suggestions). The share dialog itself is `share-dialog.tsx`.

import type { FileUIPart } from "ai";
import { ArrowUpIcon, EyeIcon, HistoryIcon, ImagePlusIcon, LightbulbIcon, LogInIcon, NavigationIcon, PauseIcon, PlusIcon, RadioIcon, XIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { toast } from "sonner";

import { sectionButtonClass, sectionHeaderClass, sectionLabelClass, toolbarButtonClass } from "@/components/nav-controls";
import { openShare } from "@/components/session-actions";
import { ShareAccountSetup } from "@/components/share-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { sendMessage, stop } from "@/lib/sessions";
import {
  forgetShare,
  isLive,
  isLoopbackRelay,
  joinShare,
  leaveShare,
  originOf,
  rejoinShare,
  safeImage,
  useHostedShares,
  useJoinedShares,
  useShare,
  useShareAccount,
  useShareHistory,
  watchers,
  type ShareHistoryEntry,
} from "@/lib/share";
import { createStore, useConversations, type Conversation } from "@/lib/store";
import { errorMessage, type RunStatus, type ShareView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Images a guest may attach, as the host takes them. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 3;

const joining = createStore<boolean>("sush.joinDialog", false, false);
export const openJoin = () => joining.set(true);

/**
 * Paste an invite link and open the share. A link only works with the relay it was made on: when
 * that isn't the relay set up here, say which one it is and sign in to it here, then join.
 */
export function JoinSessionDialog({ onJoined }: { onJoined: (threadId: string) => void }) {
  const open = useSyncExternalStore(joining.subscribe, joining.get);
  const account = useShareAccount();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    joining.set(false);
    setLink("");
  };
  const join = async () => {
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void join();
  };
  const linkRelay = originOf(link);
  const ready = !!account?.user && !!linkRelay && linkRelay === account.relayUrl;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Join a shared session</DialogTitle>
          <DialogDescription>Watch someone’s session live. They let you in once you ask.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            autoFocus
            aria-label="Invite link"
            placeholder="Paste the invite link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            spellCheck={false}
          />
          {linkRelay && !ready ? null : (
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !link.trim()}>
                <LogInIcon /> Join
              </Button>
            </DialogFooter>
          )}
        </form>
        {linkRelay && !ready && (
          <div className="flex flex-col gap-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              This link goes through the relay at <code className="text-foreground">{linkRelay}</code>.{" "}
              {account?.user && account.relayUrl
                ? `You’re signed in to ${account.relayUrl}; sign in to this one instead to join (that replaces it).`
                : "Sign in to it, or create an account there, to join."}
            </p>
            {isLoopbackRelay(linkRelay) && (
              <p className="text-sm text-destructive">
                “{new URL(linkRelay).hostname}” means the computer it’s opened on. If the link was made on another computer, it
                won’t open here: ask whoever shared it to run “bun run dev:relay” and share again from their network address.
              </p>
            )}
            <ShareAccountSetup key={linkRelay} relay={linkRelay} onReady={() => void join()} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Recent sessions the sidebar lists before "Show all". */
const RECENT = 5;

/**
 * The sidebar's "Shared": sessions joined here, a way to join one, and the
 * history of sessions shared from here or joined (joined ones can be joined
 * again while they last; the host's conversation is never kept here).
 */
export function SharedGroup({
  activeId,
  onOpen,
  onOpenSession,
}: {
  activeId: string | null;
  onOpen: (threadId: string) => void;
  /** Opens a session of this app's own (one shared from here). */
  onOpenSession: (id: string) => void;
}) {
  const joined = useJoinedShares();
  const hosted = useHostedShares();
  const history = useShareHistory();
  const conversations = useConversations();
  const [all, setAll] = useState(false);
  const open = new Set([...joined, ...hosted.filter(isLive)].map((s) => s.shareId));
  const past = history.filter((h) => !open.has(h.shareId) && (!h.hosted || conversations.some((c) => c.id === h.threadId)));
  const shown = all ? past : past.slice(0, RECENT);
  const reopen = async (h: ShareHistoryEntry) => {
    if (h.hosted) return onOpenSession(h.threadId);
    if (h.ended) {
      toast(`“${h.title}” has ended`, { description: `Ask ${h.hostName} to share it again.` });
      return;
    }
    try {
      onOpen(await rejoinShare(h.shareId));
    } catch (e) {
      toast.error("Couldn’t join again", { description: errorMessage(e) });
    }
  };
  return (
    <SidebarGroup className="py-0">
      <div className={sectionHeaderClass}>
        <SidebarGroupLabel className={sectionLabelClass}>Shared</SidebarGroupLabel>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Join a shared session" className={cn(toolbarButtonClass, sectionButtonClass)} onClick={openJoin}>
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
        {hosted.filter(isLive).map((s) => (
          <SidebarMenuItem key={s.threadId}>
            <SidebarMenuButton onClick={() => onOpenSession(s.threadId)}>
              <RadioIcon className="text-brand" />
              <span className="truncate">{s.thread.title || "Shared session"}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">sharing</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
        {joined.length === 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton className="text-muted-foreground" onClick={openJoin}>
              <LogInIcon /> <span>Join shared session…</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {past.length > 0 && (
          <li className="px-2 pt-3 pb-1 text-xs text-muted-foreground/80" role="presentation">
            History
          </li>
        )}
        {shown.map((h) => (
          <SidebarMenuItem key={h.shareId}>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton className="text-muted-foreground" onClick={() => void reopen(h)}>
                  {h.hosted ? <RadioIcon /> : <HistoryIcon />}
                  <span className="truncate">{h.title}</span>
                  <span className="ml-auto shrink-0 text-xs">{h.hosted ? "shared" : h.ended ? "ended" : "rejoin"}</span>
                </SidebarMenuButton>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-64">
                {h.hosted ? "You shared it" : `${h.hostName}’s session`}
                {h.people.filter((p) => p !== h.hostName).length > 0 && ` with ${h.people.filter((p) => p !== h.hostName).join(", ")}`}
                {` · ${new Date(h.lastSeen).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}
              </TooltipContent>
            </Tooltip>
            <SidebarMenuAction showOnHover aria-label="Remove from history" onClick={() => forgetShare(h.shareId)}>
              <XIcon />
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
        {past.length > RECENT && (
          <SidebarMenuItem>
            <SidebarMenuButton className="text-xs text-muted-foreground" onClick={() => setAll((a) => !a)}>
              {all ? "Show less" : `Show all (${past.length})`}
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

/** The header's Share button, until the session is shared; then `SharePresence` stands in its place. */
export function ShareButton({ conversation }: { conversation: Conversation }) {
  const share = useShare(conversation.id);
  if (conversation.incognito || isLive(share)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 rounded-full px-2.5 text-xs" onClick={() => openShare(conversation.id)}>
          <RadioIcon className="size-3.5" /> Share
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Share this session live: others watch, chat, suggest or drive</TooltipContent>
    </Tooltip>
  );
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

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn’t read the image."));
    reader.readAsDataURL(file);
  });
}

/**
 * The composer in someone else's session, for a driver or a collaborator. A
 * driver's message goes to the host's run (joining at its next step while it
 * works); a collaborator's waits as a suggestion for the driver or the host.
 * Images go along; other files can't.
 */
export function GuestComposer({ share, status }: { share: ShareView; status: RunStatus }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<FileUIPart[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const driver = share.role === "driver";
  const busy = status === "submitted" || status === "streaming";
  const host = share.thread.hostName;
  const decider = share.members.find((m) => m.role === "driver")?.name ?? host;
  const canSend = !!text.trim() || images.length > 0;

  const send = () => {
    if (!canSend) return;
    sendMessage(share.threadId, text, images);
    setText("");
    setImages([]);
  };
  const attach = async (files: FileList | null) => {
    const picked = [...(files ?? [])];
    if (fileRef.current) fileRef.current.value = "";
    const ok = picked.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES);
    if (ok.length < picked.length) toast.error("Only PNG, JPEG, GIF or WebP images up to 2 MB can go along.");
    const room = MAX_IMAGES - images.length;
    if (ok.length > room) toast.error(`Attach at most ${MAX_IMAGES} images.`);
    const added = await Promise.all(
      ok.slice(0, Math.max(0, room)).map(async (f) => ({ type: "file" as const, mediaType: f.type, filename: f.name, url: await readAsDataUrl(f) })),
    );
    setImages((prev) => [...prev, ...added]);
  };

  return (
    <div className="rounded-2xl border border-foreground/15 bg-background shadow-xs dark:border-white/10 dark:bg-card">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {images.map((f, i) => (
            <div key={i} className="group/att relative size-14 overflow-hidden rounded-xl border">
              <img src={f.url} alt={f.filename ?? "image"} className="size-full object-cover" />
              <button
                type="button"
                aria-label={`Remove ${f.filename ?? "image"}`}
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute top-0.5 right-0.5 rounded-full bg-background/90 p-0.5 opacity-0 shadow-xs group-hover/att:opacity-100 focus-visible:opacity-100"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <Textarea
        aria-label={driver ? "Message" : "Suggestion"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          driver
            ? busy
              ? "Steer the agent: this joins its reply at the next step"
              : `Message the agent in ${host}’s session`
            : `Suggest a message: ${decider} decides whether to send it`
        }
        className="max-h-60 min-h-14 resize-none border-none bg-transparent px-4 pt-3.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
        <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={(e) => void attach(e.target.files)} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Attach images" className={toolbarButtonClass} onClick={() => fileRef.current?.click()}>
              <ImagePlusIcon />
            </button>
          </TooltipTrigger>
          <TooltipContent>Attach images</TooltipContent>
        </Tooltip>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-muted-foreground">
          {driver ? <NavigationIcon className="size-3.5 shrink-0 text-brand" /> : <LightbulbIcon className="size-3.5 shrink-0" />}
          {driver ? `You’re driving ${host}’s session` : `You can suggest in ${host}’s session`}
        </span>
        <Button variant="ghost" size="sm" className="h-7 rounded-full text-xs" onClick={() => void leaveShare(share.threadId)}>
          Leave
        </Button>
        {driver && busy && (
          <Button variant="outline" size="sm" className="h-8 rounded-full" onClick={() => stop(share.threadId)}>
            <PauseIcon className="size-3.5" /> Pause
          </Button>
        )}
        <Button
          size="sm"
          className="h-8 rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
          disabled={!canSend}
          onClick={send}
        >
          {driver ? <ArrowUpIcon className="size-4" /> : null}
          {driver ? "Send" : "Suggest"}
        </Button>
      </div>
    </div>
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
