// Messages collaborators suggested in a shared session, above the composer.
// Whoever sends messages to the agent (the owner, or the driver) sends each
// on as it is, edits it first, or drops it; the host credits it to whoever
// wrote it. A collaborator sees their own, waiting. See `lib/share.ts`.

import { ArrowUpIcon, ImageIcon, LightbulbIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { acceptSuggestion, dropSuggestion, safeImage } from "@/lib/share";
import type { ShareSuggestion, ShareView } from "@/lib/tauri";

export function SuggestionQueue({ share }: { share: ShareView }) {
  const sends = share.role === "owner" || share.role === "driver";
  const shown = sends ? share.suggestions : share.suggestions.filter((s) => s.author.userId === share.me);
  if (shown.length === 0 || share.status === "ended") return null;
  const decider = share.members.find((m) => m.role === "driver")?.name ?? share.thread.hostName;
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-2 dark:border-white/10">
      <p className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
        <LightbulbIcon className="size-3.5" />
        {sends ? "Suggested: send one to the agent, edit it first, or drop it" : `Your suggestions: waiting for ${decider}`}
      </p>
      {shown.map((s) => (
        <SuggestionRow key={s.id} share={share} suggestion={s} sends={sends} />
      ))}
    </div>
  );
}

function SuggestionRow({ share, suggestion, sends }: { share: ShareView; suggestion: ShareSuggestion; sends: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(suggestion.text);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  const send = () => run(() => acceptSuggestion(share, suggestion.id, editing && draft !== suggestion.text ? draft : undefined));
  const images = suggestion.files.length;
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-background px-3 py-2 text-sm shadow-xs dark:bg-card">
      <UserAvatar image={safeImage(suggestion.author.image)} name={suggestion.author.name} className="mt-0.5 size-5 text-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {suggestion.author.name}
          {images > 0 && (
            <span className="flex items-center gap-0.5">
              · <ImageIcon className="size-3" /> {images}
            </span>
          )}
        </p>
        {editing ? (
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="mt-1 max-h-48 min-h-10 resize-none text-sm"
          />
        ) : (
          <p className="break-words whitespace-pre-wrap">{suggestion.text || "(images only)"}</p>
        )}
      </div>
      {sends && (
        <div className="flex shrink-0 items-center gap-0.5">
          {editing ? (
            <Button variant="ghost" size="sm" className="h-7 rounded-full px-2 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full"
                aria-label="Drop"
                disabled={busy}
                onClick={() => run(() => dropSuggestion(share, suggestion.id))}
              >
                <XIcon className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7 rounded-full" aria-label="Edit" onClick={() => setEditing(true)}>
                <PencilIcon className="size-3.5" />
              </Button>
            </>
          )}
          <Button size="sm" className="h-7 rounded-full px-2.5 text-xs" disabled={busy || (editing && !draft.trim())} onClick={send}>
            <ArrowUpIcon className="size-3.5" /> Send
          </Button>
        </div>
      )}
    </div>
  );
}
