import { FolderIcon, LoaderCircleIcon, MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import { Reorder } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionStatus } from "@/lib/sessions";
import { createStore, getConversations, type Conversation } from "@/lib/store";
import { cn } from "@/lib/utils";

interface TabState {
  /** Open sessions, in strip order. */
  open: string[];
  active: string | null;
}

const tabs = createStore<TabState>("sush.tabs", { open: [], active: null });

/** The session that was open last time, if it still exists. */
export function lastActiveTab(): string | null {
  const { active } = tabs.get();
  return active && getConversations().some((c) => c.id === active) ? active : null;
}

/**
 * Keeps the open tabs in step with the open session. A session opened from
 * anywhere (sidebar, history, a mode switch) replaces the active tab, as
 * following a link does in a browser, unless `asNewTab` was called first.
 */
export function useTabs(activeId: string | null, ids: string[], setActiveId: (id: string | null) => void) {
  const state = useSyncExternalStore(tabs.subscribe, tabs.get);
  const open = state.open.filter((id) => ids.includes(id));
  const prev = useRef(activeId);
  const newTab = useRef(false);

  useEffect(() => {
    const from = prev.current;
    prev.current = activeId;
    const asNew = newTab.current;
    newTab.current = false;
    if (!activeId) return;
    const live = new Set(getConversations().map((c) => c.id));
    tabs.set(({ open }) => {
      const list = open.filter((id) => live.has(id));
      if (list.includes(activeId)) return { open: list, active: activeId };
      const at = from ? list.indexOf(from) : -1;
      if (at < 0) return { open: [...list, activeId], active: activeId };
      const next = [...list];
      if (asNew) next.splice(at + 1, 0, activeId);
      else next[at] = activeId;
      return { open: next, active: activeId };
    });
  }, [activeId]);

  /** Open `id` in a tab of its own, next to the active one. */
  const openInNewTab = (id: string) => {
    if (id !== activeId) newTab.current = true;
    setActiveId(id);
  };

  /** Close a tab; closing the active one moves to its neighbour. */
  const close = (id: string) => {
    const i = open.indexOf(id);
    const rest = open.filter((t) => t !== id);
    tabs.set((s) => ({ ...s, open: s.open.filter((t) => t !== id) }));
    if (id === activeId) setActiveId(rest[Math.min(i, rest.length - 1)] ?? null);
  };

  /** Move to the next (+1) or previous (-1) tab, wrapping round. */
  const cycle = (by: 1 | -1) => {
    if (open.length < 2 || !activeId) return;
    const i = open.indexOf(activeId);
    setActiveId(open[(i + by + open.length) % open.length]);
  };

  /** Put the tabs in a new order (dragging one along the strip). */
  const reorder = (order: string[]) => tabs.set((s) => ({ ...s, open: order }));

  return { open, openInNewTab, close, cycle, reorder };
}

/** Browser-style tab strip for the title bar: one tab per open session, + for a new one. */
export function SessionTabs({
  open,
  conversations,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onNew,
}: {
  open: string[];
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (order: string[]) => void;
  onNew: () => void;
}) {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const strip = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when the strip overflows.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[data-active=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, open.length]);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Reorder.Group
        as="div"
        axis="x"
        values={open}
        onReorder={onReorder}
        ref={strip}
        role="tablist"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {open.map((id) => {
          const c = byId.get(id);
          return c ? (
            <SessionTab
              key={id}
              conversation={c}
              active={id === activeId}
              onSelect={() => onSelect(id)}
              onClose={() => onClose(id)}
            />
          ) : null;
        })}
      </Reorder.Group>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNew}
            aria-label="New tab"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PlusIcon className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>New tab (Ctrl+T)</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SessionTab({
  conversation: c,
  active,
  onSelect,
  onClose,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const status = useSessionStatus(c.id);
  const Icon = c.workspaceId ? FolderIcon : MessageSquareIcon;
  const [dragging, setDragging] = useState(false);
  return (
    // Drag a tab along the strip to reorder it.
    <Reorder.Item
      as="div"
      value={c.id}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      role="tab"
      aria-selected={active}
      data-active={active}
      title={c.title}
      // Selects on press, as in a browser, so the tab being dragged is the open one.
      onPointerDown={(e) => {
        if (e.button === 0) onSelect();
      }}
      // Middle-click closes, as in a browser.
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className={cn(
        "group/tab relative flex h-8 w-52 min-w-24 shrink cursor-default items-center gap-2 rounded-md pr-1 pl-2.5 text-sm transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        dragging && "bg-muted shadow-sm",
      )}
    >
      {status === "working" ? (
        <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{c.title}</span>
      {status === "needs-input" && (
        <span className="size-2 shrink-0 rounded-full bg-brand" aria-label="Waiting for you" title="Waiting for you" />
      )}
      <button
        type="button"
        aria-label="Close tab"
        // Keep a press on × from selecting or dragging the tab.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10",
          !active && "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <XIcon className="size-3.5" />
      </button>
    </Reorder.Item>
  );
}
