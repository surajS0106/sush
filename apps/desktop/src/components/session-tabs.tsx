import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderIcon, GhostIcon, LoaderCircleIcon, MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import {
  animate,
  AnimatePresence,
  motion,
  Reorder,
  useMotionValue,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
  type PanInfo,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionStatus } from "@/lib/sessions";
import { openTabMenu, renameTab, useTabRename } from "@/components/session-actions";
import { createStore, getConversations, renameConversation, saveForAnotherWindow, type Conversation } from "@/lib/store";
import { api, errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { IS_MAIN_WINDOW, onAttachTab, onTabHover, openedSession } from "@/lib/windows";

interface TabState {
  /** Open sessions, in strip order. */
  open: string[];
  active: string | null;
}

// Each window has its own strip. The main window's is remembered; one opened
// for a dragged-out tab starts with just that tab.
const tabs = IS_MAIN_WINDOW
  ? createStore<TabState>("sush.tabs", { open: [], active: null })
  : createStore<TabState>("sush.tabs", { open: openedSession ? [openedSession] : [], active: openedSession }, false);

/** How far out of the strip (CSS pixels) a dragged tab pops out, and how close it has to come back to dock again. */
const TEAR_OFF = 28;
const REDOCK = 14;
/** Before it pops out, the tab gives this much (px) vertically, with resistance. */
const GIVE = 6;
/** The floating preview of a torn-off tab: the tab itself, at its own width. */
const PREVIEW_WIDTH = 208;

/**
 * Each open session's React key. A session that replaces the active tab takes
 * over that tab's key, so the tab stays put and only its contents change,
 * instead of one tab shrinking away while another grows in its place.
 */
const tabKeys = new Map<string, string>();
let nextTabKey = 0;
function tabKey(id: string) {
  let key = tabKeys.get(id);
  if (!key) tabKeys.set(id, (key = `tab-${++nextTabKey}`));
  return key;
}

/** The session that was open last time (for a window opened from a dragged-out tab, that tab), if it still exists. */
export function lastActiveTab(): string | null {
  const { active } = tabs.get();
  return active && getConversations().some((c) => c.id === active) ? active : null;
}

/**
 * Keeps the open tabs in step with the open session. A session opened from
 * anywhere (history, a mode switch) replaces the active tab, as following a
 * link does in a browser, unless `openInNewTab` was called first (the sidebar does).
 */
export function useTabs(activeId: string | null, ids: string[], setActiveId: (id: string | null) => void) {
  const state = useSyncExternalStore(tabs.subscribe, tabs.get);
  const open = state.open.filter((id) => ids.includes(id));
  const prev = useRef(activeId);
  const newTab = useRef(false);

  // Before paint, so the strip never shows a frame where the new session has no tab yet.
  useLayoutEffect(() => {
    const from = prev.current;
    prev.current = activeId;
    const asNew = newTab.current;
    newTab.current = false;
    if (!activeId) return;
    const live = new Set(getConversations().map((c) => c.id));
    const list = tabs.get().open.filter((id) => live.has(id));
    const at = from && !list.includes(activeId) ? list.indexOf(from) : -1;
    if (list.includes(activeId)) tabs.set({ open: list, active: activeId });
    else if (at < 0) tabs.set({ open: [...list, activeId], active: activeId });
    else {
      const next = [...list];
      if (asNew) next.splice(at + 1, 0, activeId);
      else {
        next[at] = activeId;
        tabKeys.set(activeId, tabKey(from!));
        tabKeys.delete(from!);
      }
      tabs.set({ open: next, active: activeId });
    }
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

  /**
   * A tab was dragged out of the strip: move it to the window it was dropped
   * on, or into a new one, as in a browser. A window whose last tab moves
   * away closes. Incognito chats stay: they're gone once left, and their
   * messages are in no other window's copy.
   */
  const detach = async (id: string): Promise<boolean> => {
    const convo = getConversations().find((c) => c.id === id);
    if (!convo || convo.incognito) return false;
    const last = open.length <= 1;
    try {
      await saveForAnotherWindow(id);
      const result = await api.tabDrop(id, last);
      if (result === "stayed") return false;
      if (last) await getCurrentWindow().close();
      else close(id);
      return true;
    } catch (e) {
      toast.error("Couldn’t move the tab", { description: errorMessage(e) });
      return false;
    }
  };

  return { open, openInNewTab, close, cycle, reorder, detach };
}

/** Browser-style tab strip for the title bar: one tab per open session, + for a new one. */
export function SessionTabs({
  open,
  conversations,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onDetach,
  onNew,
  activeMenu,
}: {
  open: string[];
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (order: string[]) => void;
  /** A tab was dragged out of the strip and let go; resolves to whether it moved to another window. */
  onDetach: (id: string) => Promise<boolean>;
  onNew: () => void;
  /** Shown inside the active tab, after its title: that session's actions. */
  activeMenu?: ReactNode;
}) {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const strip = useRef<HTMLDivElement>(null);
  // While a tab is out of the strip, its hidden slot shouldn't shuffle the others.
  const [tornOff, setTornOff] = useState(false);
  const landing = useLanding(strip, onSelect);

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
        onReorder={(order) => {
          if (!tornOff) onReorder(order);
        }}
        ref={strip}
        role="tablist"
        // Vertical room (cancelled by the negative margin) so a dragged tab's give and shadow aren't clipped.
        className="-my-2 flex min-w-0 items-center gap-0.5 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* New tabs grow in; closed ones shrink away. One dropped here from another window takes the slot opened for it. */}
        <AnimatePresence initial={false}>
          {withLanding(
            open.map((id) => {
              const c = byId.get(id);
              return c ? (
                <SessionTab
                  key={tabKey(id)}
                  conversation={c}
                  active={id === activeId}
                  arrived={id === landing.arrived}
                  strip={strip}
                  onSelect={() => onSelect(id)}
                  onClose={() => onClose(id)}
                  onTear={setTornOff}
                  onDetach={() => onDetach(id)}
                  menu={id === activeId ? activeMenu : undefined}
                />
              ) : null;
            }),
            open,
            landing.hover,
            byId,
          )}
        </AnimatePresence>
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

/** Where a tab from another window would land: the slot before the first tab whose middle is right of `x`. */
function slotAt(x: number, middles: number[]) {
  const i = middles.findIndex((m) => x < m);
  return i < 0 ? middles.length : i;
}

/**
 * A tab dragged in from another window. While it's over this strip, the strip
 * opens a slot where it would land (`hover`); dropped, it takes that slot, and
 * mounts at full size (`arrived`) so nothing moves.
 */
function useLanding(strip: RefObject<HTMLDivElement | null>, onSelect: (id: string) => void) {
  const [hover, setHover] = useState<{ threadId: string; index: number } | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  // Measured when the tab arrives over the strip, before the slot pushes the tabs along.
  const middles = useRef<number[] | null>(null);
  const last = useRef<{ threadId: string; index: number } | null>(null);
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    const measure = (threadId: string) =>
      [...(strip.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])]
        .filter((el) => el.dataset.tabId !== threadId)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2;
        });
    const stopHover = onTabHover((tab) => {
      clearTimeout(leaving.current);
      if (!tab) {
        // A drop sends "left" just before "attach"; wait a moment so the slot isn't closed and reopened.
        leaving.current = setTimeout(() => {
          middles.current = null;
          setHover(null);
        }, 120);
        return;
      }
      middles.current ??= measure(tab.threadId);
      last.current = { threadId: tab.threadId, index: slotAt(tab.x, middles.current) };
      setHover(last.current);
    });
    const stopAttach = onAttachTab(({ threadId, x }) => {
      clearTimeout(leaving.current);
      const index = last.current?.threadId === threadId ? last.current.index : slotAt(x, middles.current ?? measure(threadId));
      tabs.set(({ open }) => {
        const list = open.filter((t) => t !== threadId);
        list.splice(Math.min(index, list.length), 0, threadId);
        return { open: list, active: threadId };
      });
      middles.current = null;
      last.current = null;
      setHover(null);
      setArrived(threadId);
      select.current(threadId);
    });
    return () => {
      clearTimeout(leaving.current);
      stopHover();
      stopAttach();
    };
  }, [strip]);

  return { hover, arrived };
}

/** The strip's tabs with the slot for a tab from another window, if one is over it. */
function withLanding(
  items: ReactNode[],
  open: string[],
  hover: { threadId: string; index: number } | null,
  byId: Map<string, Conversation>,
) {
  const c = hover && byId.get(hover.threadId);
  if (!hover || !c || open.includes(hover.threadId)) return items;
  const next = [...items];
  next.splice(Math.min(hover.index, next.length), 0, <LandingSlot key="landing" conversation={c} />);
  return next;
}

/** The slot a tab from another window would drop into: an outline of it, opened between the tabs. */
function LandingSlot({ conversation }: { conversation: Conversation }) {
  return (
    <motion.div
      layout
      initial={HIDDEN_TAB}
      animate={OPEN_TAB}
      transition={SNAP}
      aria-hidden
      className="flex h-8 shrink items-center gap-2 overflow-hidden rounded-md bg-muted/60 text-sm text-muted-foreground ring-1 ring-foreground/15 ring-inset"
    >
      <TabFace conversation={conversation} />
    </motion.div>
  );
}

/** How far the pointer is out of the strip's band (0 inside it); outside the window counts as far. */
function distanceOut({ x, y }: { x: number; y: number }, strip: HTMLElement | null) {
  if (!strip) return 0;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return Infinity;
  const r = strip.getBoundingClientRect();
  return Math.max(r.top - y, y - r.bottom, 0);
}

const SNAP = { type: "spring", stiffness: 560, damping: 40 } as const;
const SETTLE = { type: "spring", stiffness: 420, damping: 34 } as const;
/**
 * The tab's own size, matching `w-52 pl-2.5 pr-1`. The minimum width (for when the strip is
 * crowded) grows and shrinks with it, or a new tab would snap open to it before growing.
 */
const OPEN_TAB = { width: 208, minWidth: 96, opacity: 1, paddingLeft: 10, paddingRight: 4 };
const HIDDEN_TAB = { width: 0, minWidth: 0, opacity: 0, paddingLeft: 0, paddingRight: 0 };

/**
 * One tab. Drag along the strip to reorder. Pull it down and it gives a little,
 * then pops out into a floating window preview that follows the pointer while
 * its slot closes up; let go there to move it to another window. Bring it back
 * to the strip and it docks again.
 */
function SessionTab({
  conversation: c,
  active,
  arrived,
  strip,
  onSelect,
  onClose,
  onTear,
  onDetach,
  menu,
}: {
  conversation: Conversation;
  active: boolean;
  /** Dropped here from another window, into the slot opened for it: no grow-in. */
  arrived: boolean;
  strip: RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  onClose: () => void;
  onTear: (torn: boolean) => void;
  onDetach: () => Promise<boolean>;
  menu?: ReactNode;
}) {
  const self = useRef<HTMLDivElement>(null);
  const renaming = useTabRename() === c.id;
  const [dragging, setDragging] = useState(false);
  // Out of the strip: its slot is closed. Stays so after a drop until the move is known, so the slot
  // doesn't reopen (pushing the next tab back) just before the tab leaves for good.
  const [tornOff, setTornOff] = useState(false);
  // The floating preview, shown while the torn-off tab is being dragged.
  const [lifted, setLifted] = useState(false);
  const torn = useRef(false);
  // Vertical give while still docked; the drag itself only moves along x.
  const give = useMotionValue(0);
  // The pointer, less where the tab was grabbed: where the preview's top left goes.
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const grab = useRef({ x: 0, y: 0 });
  // Where the tab was when it popped out, relative to the preview, so the preview starts from there.
  const [popFrom, setPopFrom] = useState({ x: 0, y: 0 });
  // Over another window's strip, which shows the tab instead (`tab_hover`), so the preview steps aside.
  const [overOther, setOverOther] = useState(false);
  const outside = useRef(false);
  const asking = useRef(false);
  // The latest hover call, which the drop waits for so a late one can't reopen a slot after it.
  const inflight = useRef<Promise<unknown>>(Promise.resolve());

  const hover = (over: boolean) => {
    if (over) {
      // One question in flight at a time; pointer moves come faster than answers.
      if (asking.current) return;
      asking.current = true;
    }
    inflight.current = api.tabHover(over ? c.id : null).then(
      (onStrip) => {
        if (over) asking.current = false;
        setOverOther(torn.current && outside.current && onStrip);
      },
      () => {
        if (over) asking.current = false;
      },
    );
  };

  const tear = (next: boolean) => {
    if (torn.current === next) return;
    torn.current = next;
    if (next && self.current) {
      const r = self.current.getBoundingClientRect();
      setPopFrom({ x: r.left - px.get(), y: r.top - py.get() });
    }
    if (!next && outside.current) {
      outside.current = false;
      hover(false);
    }
    setTornOff(next);
    setLifted(next);
    onTear(next);
  };

  const follow = (info: PanInfo) => {
    px.set(info.point.x - grab.current.x);
    py.set(info.point.y - grab.current.y);
  };

  const onDragStart = (_: unknown, info: PanInfo) => {
    const r = self.current?.getBoundingClientRect();
    grab.current = r ? { x: Math.min(info.point.x - r.left, PREVIEW_WIDTH - 32), y: info.point.y - r.top } : { x: 0, y: 0 };
    follow(info);
    setDragging(true);
    // Dragging shouldn't select text on the way.
    window.getSelection()?.removeAllRanges();
    document.documentElement.style.cursor = "grabbing";
    document.documentElement.style.userSelect = "none";
  };

  const onDrag = (_: unknown, info: PanInfo) => {
    follow(info);
    if (c.incognito) return;
    const out = distanceOut(info.point, strip.current);
    if (torn.current ? out < REDOCK : out > TEAR_OFF) tear(!torn.current);
    // Out of this window, ask whether another window's strip is under the pointer.
    if (torn.current && out === Infinity) {
      outside.current = true;
      hover(true);
    } else if (outside.current) {
      outside.current = false;
      setOverOther(false);
      hover(false);
    }
    // A soft pull towards the pointer, easing off: the tab is stuck to the strip until it lets go.
    const dy = info.offset.y;
    give.set(torn.current ? 0 : Math.sign(dy) * GIVE * (1 - Math.exp(-Math.abs(dy) / 40)));
  };

  const onDragEnd = () => {
    document.documentElement.style.cursor = "";
    document.documentElement.style.userSelect = "";
    outside.current = false;
    setOverOther(false);
    setDragging(false);
    void animate(give, 0, SETTLE);
    if (!torn.current) return;
    torn.current = false;
    setLifted(false);
    void inflight.current
      .catch(() => undefined)
      .then(onDetach)
      .then((moved) => {
        // Gone to another window (and unmounting), or back into its slot if it stayed.
        if (!moved) setTornOff(false);
        onTear(false);
      });
  };

  return (
    <>
      <Reorder.Item
        ref={self}
        as="div"
        value={c.id}
        // No dragging while the title is being edited: a drag in the text box selects text.
        dragListener={!renaming}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        initial={arrived ? false : HIDDEN_TAB}
        // Torn off, its slot closes and the tabs after it slide over; docked again, it reopens.
        animate={tornOff ? HIDDEN_TAB : OPEN_TAB}
        exit={HIDDEN_TAB}
        transition={tornOff ? { ...SNAP, opacity: { duration: 0.08 } } : SNAP}
        whileDrag={{ scale: 1.03 }}
        style={{ y: give }}
        role="tab"
        aria-selected={active}
        data-active={active}
        data-tab-id={c.id}
        title={c.title}
        // Selects on press, as in a browser, so the tab being dragged is the open one.
        onPointerDown={(e) => {
          if (e.button === 0) onSelect();
        }}
        // A press here never starts a text selection, which the drag would stretch across the page.
        onMouseDown={(e) => e.preventDefault()}
        // Double-click renames in place; a right-click (two-finger click, Control-click) opens the session menu.
        onDoubleClick={(e) => {
          if (e.button === 0 && !renaming && !(e.target as HTMLElement).closest("button")) renameTab(c.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (renaming) return;
          onSelect();
          openTabMenu(c.id);
        }}
        // Middle-click closes, as in a browser.
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        className={cn(
          "group/tab relative flex h-8 shrink cursor-default items-center gap-2 overflow-hidden rounded-md text-sm transition-colors",
          active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          dragging && "z-10 bg-muted shadow-md",
        )}
      >
        <TabFace conversation={c} title={renaming ? <TabTitleInput conversation={c} /> : undefined} />
        {/* Inactive tabs keep the menu's room, so switching tabs changes only their styling. */}
        {menu ?? <span className="size-5 shrink-0" aria-hidden />}
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
      {createPortal(
        <AnimatePresence>
          {lifted && <TabPreview conversation={c} x={px} y={py} from={popFrom} grabX={grab.current.x} hidden={overOther} />}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

/** The tab's title as a text box while it's renamed in place: Enter or clicking away saves, Escape cancels. */
function TabTitleInput({ conversation: c }: { conversation: Conversation }) {
  const [title, setTitle] = useState(c.title);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // A frame late, so a menu that's closing (Rename in the tab's menu) has let go of focus first.
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) renameConversation(c.id, title);
    renameTab(null);
  };
  return (
    <input
      ref={input}
      value={title}
      aria-label="Session name"
      onChange={(e) => setTitle(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Keep the app's own shortcuts (Ctrl+W, Ctrl+Tab…) out of the text box.
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      // Clicks and drags in the box edit the text; they don't select or drag the tab.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm bg-background px-1 text-foreground outline-none ring-1 ring-ring/60"
    />
  );
}

/** Icon (or spinner), title and "waiting for you" dot: what a tab and its preview both show. */
function TabFace({ conversation: c, title }: { conversation: Conversation; title?: ReactNode }) {
  const status = useSessionStatus(c.id);
  const Icon = c.incognito ? GhostIcon : c.workspaceId ? FolderIcon : MessageSquareIcon;
  return (
    <>
      {status === "working" ? (
        <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      {title ?? <span className="min-w-0 flex-1 truncate">{c.title}</span>}
      {status === "needs-input" && (
        <span className="size-2 shrink-0 rounded-full bg-brand" aria-label="Waiting for you" title="Waiting for you" />
      )}
    </>
  );
}

/**
 * A torn-off tab, following the pointer: just the tab, lifted. It pops from
 * where the tab was, and leans a little into fast moves.
 */
function TabPreview({
  conversation: c,
  x,
  y,
  from,
  grabX,
  hidden,
}: {
  conversation: Conversation;
  x: MotionValue<number>;
  y: MotionValue<number>;
  from: { x: number; y: number };
  grabX: number;
  /** Another window's strip is showing the tab. */
  hidden: boolean;
}) {
  const lean = useSpring(useTransform(useVelocity(x), [-2000, 0, 2000], [-4, 0, 4], { clamp: true }), {
    stiffness: 300,
    damping: 30,
  });
  return (
    <motion.div className="pointer-events-none fixed top-0 left-0 z-[100]" style={{ x, y }} aria-hidden>
      <motion.div
        initial={{ x: from.x, y: from.y, scale: 1 }}
        animate={{ x: 0, y: 0, scale: hidden ? 0.92 : 1, opacity: hidden ? 0 : 1 }}
        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14, ease: "easeOut" } }}
        transition={SNAP}
        style={{ rotate: lean, transformOrigin: `${grabX}px 16px`, width: PREVIEW_WIDTH }}
        className="flex h-8 items-center gap-2 overflow-hidden rounded-md border bg-muted px-2.5 text-sm text-foreground shadow-xl"
      >
        <TabFace conversation={c} />
      </motion.div>
    </motion.div>
  );
}
