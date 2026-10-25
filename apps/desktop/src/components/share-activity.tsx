// A shared session's side notes: comments (beside the session, never sent to
// the model) and the activity log (who joined, steered, suggested, approved,
// stopped...), which the host keeps and sends to everyone in the share.
// Opened from the header, next to who's watching. See `lib/share.ts`.

import { ActivityIcon, MessageSquareTextIcon, SendIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { toolbarButtonClass } from "@/components/nav-controls";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { addComment, isLive, safeImage, useShare } from "@/lib/share";
import { errorMessage, type ShareAuditEntry, type ShareView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The header button: comments and activity for a shared session. */
export function ShareActivityButton({ threadId }: { threadId: string }) {
  const share = useShare(threadId);
  const [tab, setTab] = useState<"comments" | "activity">("comments");
  if (!isLive(share) || share.status === "lobby") return null;
  const count = share.comments.length;
  return (
    <Sheet>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <button type="button" aria-label="Comments and activity" className={cn(toolbarButtonClass, "relative")}>
              <MessageSquareTextIcon />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5 rounded-full bg-brand px-1 text-[9px] leading-3.5 font-medium text-brand-foreground">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Comments and activity</TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{share.thread.title || "Shared session"}</SheetTitle>
          <SheetDescription>Comments stay beside the session. The agent never sees them.</SheetDescription>
          <div className="mt-3 flex gap-1">
            {(["comments", "activity"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs",
                  tab === t ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5",
                )}
              >
                {t === "comments" ? <MessageSquareTextIcon className="size-3.5" /> : <ActivityIcon className="size-3.5" />}
                {t === "comments" ? `Comments${count ? ` (${count})` : ""}` : "Activity"}
              </button>
            ))}
          </div>
        </SheetHeader>
        {tab === "comments" ? <Comments share={share} /> : <ActivityLog entries={share.audit} className="flex-1 overflow-y-auto p-4" />}
      </SheetContent>
    </Sheet>
  );
}

function Comments({ share }: { share: ShareView }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Viewers read; everyone else (and the owner) writes.
  const canComment = share.role !== "viewer" && share.status === "live";
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await addComment(share, text.trim());
      setText("");
    } catch (err) {
      toast.error("Couldn’t comment", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {share.comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
        {share.comments.map((c) => (
          <div key={c.id} className="flex gap-2.5">
            <UserAvatar image={safeImage(c.author.image)} name={c.author.name} className="size-6 text-[10px]" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.author.name}</span> · {time(c.at)}
              </p>
              <p className="text-sm break-words whitespace-pre-wrap">{c.text}</p>
            </div>
          </div>
        ))}
      </div>
      {canComment ? (
        <form onSubmit={(e) => void submit(e)} className="flex items-end gap-2 border-t p-3">
          <Textarea
            aria-label="Comment"
            placeholder="Add a comment"
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
          <Button type="submit" size="icon" className="shrink-0 rounded-full" aria-label="Comment" disabled={busy || !text.trim()}>
            <SendIcon className="size-4" />
          </Button>
        </form>
      ) : (
        <p className="border-t p-3 text-xs text-muted-foreground">You’re watching. The host can let you comment.</p>
      )}
    </>
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
