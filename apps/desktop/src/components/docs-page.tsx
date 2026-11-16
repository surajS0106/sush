// The Docs page: every doc, whether Sush wrote it in a chat or the user started
// it here, in a list beside the open one. The open doc is the same editor as
// the chat's side panel (`DocBody`), with its history, outline and Share menu,
// and a link back to the chat it came from.

import { FileTextIcon, MessageSquareIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { DocBody, DocIcon, OutlineMenu, relativeTime, ShareMenu, VersionsMenu } from "@/components/doc-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createDoc, deleteDoc, useDocs } from "@/lib/docs";
import { getConversations } from "@/lib/store";
import type { Doc, DocVersion } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The first line of text under the title, for the list. */
function snippet(doc: Doc): string {
  for (const line of doc.content.split("\n")) {
    const t = line
      .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>|- \[[ x]\])\s*/i, "")
      .replace(/[*_`[\]]/g, "")
      .trim();
    if (t && !t.startsWith("```") && !t.startsWith("|")) return t;
  }
  return "Empty";
}

export function DocsPage({ onOpenSession }: { onOpenSession: (threadId: string) => void }) {
  const docs = useDocs();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocVersion | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)) : docs;
  }, [docs, query]);
  const open = docs.find((d) => d.id === openId) ?? shown[0] ?? null;
  const chatExists = !!open?.threadId && getConversations().some((c) => c.id === open.threadId);

  const select = (id: string) => {
    setOpenId(id);
    setPreview(null);
  };

  const remove = async (doc: Doc) => {
    if (!window.confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    if (await deleteDoc(doc)) setOpenId(null);
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* The list. */}
      <div className="flex w-72 shrink-0 flex-col border-r">
        <header className="flex items-center gap-2 px-4 pt-6 pb-3">
          <FileTextIcon className="size-5 text-muted-foreground" />
          <h1 className="flex-1 text-xl font-semibold tracking-tight">Docs</h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New doc"
                onClick={async () => {
                  const doc = await createDoc();
                  if (doc) select(doc.id);
                }}
              >
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New doc</TooltipContent>
          </Tooltip>
        </header>
        <div className="relative px-4 pb-3">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-6.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search docs" aria-label="Search docs" className="pl-8" />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {shown.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => select(d.id)}
                aria-current={open?.id === d.id}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50",
                  open?.id === d.id && "bg-accent",
                )}
              >
                <DocIcon icon={d.icon} className="mt-0.5 size-4 shrink-0 text-base" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{d.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{snippet(d)}</span>
                  <span className="block text-xs text-muted-foreground/80">{relativeTime(d.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query ? "No docs match." : "No docs yet. Ask Sush for a doc in any chat, or start one with +."}
            </li>
          )}
        </ul>
      </div>

      {/* The open doc. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {open ? (
          <>
            <header className="flex h-12 shrink-0 items-center gap-1 px-3">
              <VersionsMenu doc={open} preview={preview} onPreview={setPreview} />
              <div className="flex-1" />
              {chatExists && (
                <Button variant="ghost" size="sm" onClick={() => onOpenSession(open.threadId!)}>
                  <MessageSquareIcon /> Open chat
                </Button>
              )}
              <OutlineMenu doc={open} scroller={scroller} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Delete doc" onClick={() => void remove(open)} className="text-muted-foreground hover:text-destructive">
                    <Trash2Icon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
              <ShareMenu doc={open} />
            </header>
            <DocBody key={open.id} doc={open} preview={preview} onLeavePreview={() => setPreview(null)} scrollRef={scroller} />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <FileTextIcon className="size-8 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              Docs are pages Sush writes for you: plans, guides, write-ups. Edit them like Notion, keep every version, and share them.
            </p>
            <Button
              onClick={async () => {
                const doc = await createDoc();
                if (doc) select(doc.id);
              }}
            >
              <PlusIcon /> New doc
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
