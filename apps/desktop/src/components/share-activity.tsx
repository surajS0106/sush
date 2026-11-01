// A shared session's room: a chat for everyone in it (beside the session,
// never sent to the model), who's in it with their roles, and the activity log
// (who joined, steered, suggested, approved, stopped...), which the host keeps
// and sends to everyone in the share. Opened from the header's Room button,
// and a tab of a guest's side panel. See `lib/share.ts`.

import { ActivityIcon, MessageSquareTextIcon, SendIcon, UsersIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { toolbarButtonClass } from "@/components/nav-controls";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { addComment, isLive, safeImage, useShare } from "@/lib/share";
import { errorMessage, type ShareAuditEntry, type ShareMember, type ShareView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The header button: the room of a shared session. */
export function ShareActivityButton({ threadId }: { threadId: string }) {
  const share = useShare(threadId);
  if (!isLive(share) || share.status === "lobby") return null;
  const count = share.comments.length;
  return (
    <Sheet>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <button type="button" aria-label="Room: chat, people and activity" className={cn(toolbarButtonClass, "relative")}>
              <MessageSquareTextIcon />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5 rounded-full bg-brand px-1 text-[9px] leading-3.5 font-medium text-brand-foreground">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Room: chat, people and activity</TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pb-0">
          <SheetTitle>{share.thread.title || "Shared session"}</SheetTitle>
          <SheetDescription>Everyone in the session talks here. The agent never sees it.</SheetDescription>
        </SheetHeader>
        <RoomView share={share} className="min-h-0 flex-1" />
      </SheetContent>
    </Sheet>
  );
}

type RoomTab = "chat" | "people" | "activity";

/** The room itself: chat, people and activity, as tabs. */
export function RoomView({ share, className }: { share: ShareView; className?: string }) {
  const [tab, setTab] = useState<RoomTab>("chat");
  // The host's own list holds only guests, so the host counts themselves.
  const online = share.members.filter((m) => m.online).length + (share.role === "owner" ? 1 : 0);
  const tabs: { key: RoomTab; label: string; Icon: typeof UsersIcon }[] = [
    { key: "chat", label: share.comments.length ? `Chat (${share.comments.length})` : "Chat", Icon: MessageSquareTextIcon },
    { key: "people", label: `People (${online})`, Icon: UsersIcon },
    { key: "activity", label: "Activity", Icon: ActivityIcon },
  ];
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div role="tablist" aria-label="Room" className="flex shrink-0 gap-1 border-b px-3 py-2">
        {tabs.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs",
              tab === key ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5",
            )}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>
      {tab === "chat" ? (
        <Chat share={share} />
      ) : tab === "people" ? (
        <People share={share} />
      ) : (
        <ActivityLog entries={share.audit} className="min-h-0 flex-1 overflow-y-auto p-4" />
      )}
    </div>
  );
}

function Chat({ share }: { share: ShareView }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Everyone in the room talks, viewers too.
  const canChat = share.status === "live";
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [share.comments.length]);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await addComment(share, text.trim());
      setText("");
    } catch (err) {
      toast.error("Couldn’t send that", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {share.comments.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet. Say hello: everyone in the session sees it, the agent doesn’t.</p>
        )}
        {share.comments.map((c) => {
          const mine = c.author.userId === share.me;
          return (
            <div key={c.id} className={cn("flex gap-2.5", mine && "flex-row-reverse")}>
              <UserAvatar image={safeImage(c.author.image)} name={c.author.name} className="size-6 shrink-0 text-[10px]" />
              <div className={cn("flex min-w-0 max-w-[85%] flex-col", mine && "items-end")}>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{mine ? "You" : c.author.name}</span> · {time(c.at)}
                </p>
                <p className={cn("mt-0.5 rounded-2xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap", mine ? "bg-brand/15" : "bg-muted")}>
                  {c.text}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {canChat ? (
        <form onSubmit={(e) => void submit(e)} className="flex shrink-0 items-end gap-2 border-t p-3">
          <Textarea
            aria-label="Message the room"
            placeholder="Message the room"
            value={text}
            maxLength={4096}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            className="max-h-40 min-h-10 resize-none text-sm"
          />
          <Button type="submit" size="icon" className="shrink-0 rounded-full" aria-label="Send" disabled={busy || !text.trim()}>
            <SendIcon className="size-4" />
          </Button>
        </form>
      ) : (
        <p className="shrink-0 border-t p-3 text-xs text-muted-foreground">
          {share.status === "ended" ? "This session has ended." : "You can chat once you’re in."}
        </p>
      )}
    </>
  );
}

const ROLE_LABEL: Record<ShareMember["role"], string> = { owner: "Host", driver: "Driving", collaborator: "Can suggest", viewer: "Watching" };

/** Who's in the session: the host first, then whoever's online, then the rest. */
function People({ share }: { share: ShareView }) {
  const order = (m: ShareMember) => (m.role === "owner" ? 0 : m.online ? 1 : 2);
  // The host's own list holds only guests.
  const host: ShareMember[] =
    share.role === "owner" && share.me ? [{ userId: share.me, name: share.thread.hostName, role: "owner", online: true }] : [];
  const people = [...host, ...share.members].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
      {people.map((m) => (
        <li key={m.userId} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span className="relative">
            <UserAvatar image={safeImage(m.image)} name={m.name} className="size-7 text-[11px]" />
            <span
              className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background", m.online ? "bg-green-500" : "bg-muted-foreground/40")}
              aria-label={m.online ? "Online" : "Away"}
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {m.name}
            {m.userId === share.me && <span className="text-muted-foreground"> (you)</span>}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{ROLE_LABEL[m.role]}</span>
        </li>
      ))}
      {share.role === "owner" && share.lobby.length > 0 && (
        <li className="px-2 pt-2 text-xs text-muted-foreground">{share.lobby.length} waiting to be let in: open the share dialog to let them in.</li>
      )}
    </ul>
  );
}

const ROLE: Record<string, string> = { driver: "the driver", collaborator: "a collaborator", viewer: "a viewer" };

/** What an entry says someone did. */
function describe(e: ShareAuditEntry): string {
  const d = e.detail ?? {};
  const s = (key: string) => String(d[key] ?? "");
  switch (e.kind) {
    case "joined":
      return "joined";
    case "left":
      return "left";
    case "steered":
      return `sent “${s("preview")}”`;
    case "suggested":
      return `suggested “${s("preview")}”`;
    case "accepted":
      return `sent ${s("from")}’s suggestion${d.edited ? ", edited" : ""}: “${s("preview")}”`;
    case "dropped":
      return `dropped ${s("from")}’s suggestion`;
    case "approved":
      return "approved a tool call";
    case "denied":
      return "denied a tool call";
    case "answered":
      return "answered the agent’s questions";
    case "interrupted":
      return "had the waiting messages join now";
    case "stopped":
      return "paused the agent";
    case "resumed":
      return "resumed the agent";
    case "commented":
      return "commented";
    case "role":
      return d.delegation
        ? "changed what the driver may approve"
        : d.away
          ? "changed what happens when they step away"
          : `made ${s("name")} ${ROLE[s("role")] ?? s("role")}`;
    case "kicked":
      return `removed ${s("name")}`;
    case "denied-intent":
      return `was refused (${s("intent")}): ${s("error")}`;
    case "ended":
      return "ended the share";
    case "undid":
      return d.path ? `undid the changes to ${s("path")}` : `undid a turn’s changes (${s("restored")} files)`;
    case "control":
      switch (s("action")) {
        case "requested":
          return "asked to drive";
        case "accepted":
          return `let ${s("name")} drive`;
        case "declined":
          return `turned down ${s("name")}’s request to drive`;
        case "passed":
          return `passed control to ${s("name")}`;
        case "released":
          return "gave control back";
        default:
          return "took control back";
      }
    case "away":
      return d.away ? (d.mode === "pause" ? "stepped away (the agent pauses)" : `stepped away (the driver carries on for ${s("minutes")} min)`) : "came back";
  }
}

/** The audit log, newest first. */
export function ActivityLog({ entries, className }: { entries: ShareAuditEntry[]; className?: string }) {
  if (entries.length === 0) return <p className={cn("text-sm text-muted-foreground", className)}>Nothing yet.</p>;
  return (
    <ol className={cn("flex flex-col gap-2", className)}>
      {[...entries].reverse().map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex gap-2 text-sm">
          <span className="w-14 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">{time(e.at)}</span>
          <span className={cn("min-w-0 break-words", e.kind === "denied-intent" && "text-muted-foreground")}>
            <span className="font-medium">{e.actorName}</span> {describe(e)}
          </span>
        </li>
      ))}
    </ol>
  );
}
