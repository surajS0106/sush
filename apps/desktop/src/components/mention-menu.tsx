// The `@` connector picker above the composer: lists active connectors while the
// user types `@name`, and inserts `@name ` on pick (see lib/mentions.ts).

import { PlugIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { catalogEntry, connectorIcon } from "@/lib/connector-catalog";
import { useConnectors, useConnectorStatus, usePlugins, type Connector } from "@/lib/library";
import { mentionables, mentionName, mentionQuery } from "@/lib/mentions";
import { cn } from "@/lib/utils";

export const MENTION_MENU_ID = "mention-menu";

/** Picker state plus handlers for the textarea, which reports its caret through `onSelect`. */
export function useMentionMenu(value: string, setValue: (v: string) => void) {
  // Re-render when connectors change so the list stays current.
  useConnectors();
  usePlugins();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const typing = value === dismissedAt ? null : mentionQuery(value, Math.min(caret, value.length));
  const connectors = typing
    ? [
        ...mentionables().filter((c) => mentionName(c).startsWith(typing.query)),
        ...mentionables().filter((c) => !mentionName(c).startsWith(typing.query) && mentionName(c).includes(typing.query)),
      ]
    : [];
  const open = connectors.length > 0;

  useEffect(() => setActive(0), [typing?.query]);

  const pick = (c: Connector) => {
    if (!typing) return;
    const end = Math.min(caret, value.length);
    const insert = `@${mentionName(c)} `;
    const after = value.slice(end).replace(/^[a-z0-9-]*\s?/i, ""); // finish a half-typed name
    setValue(value.slice(0, typing.start) + insert + after);
    const pos = typing.start + insert.length;
    setCaret(pos);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(pos, pos));
  };

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    textarea.current = e.currentTarget;
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    const n = connectors.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      pick(connectors[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissedAt(value);
    }
  };

  return {
    open,
    connectors,
    active,
    setActive,
    pick,
    onKeyDown,
    onSelect,
    activeId: open ? `${MENTION_MENU_ID}-${active}` : undefined,
  };
}

interface MentionMenuProps {
  connectors: Connector[];
  active: number;
  onHover: (i: number) => void;
  onPick: (c: Connector) => void;
}

export function MentionMenu({ connectors, active, onHover, onPick }: MentionMenuProps) {
  const status = useConnectorStatus();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`#${MENTION_MENU_ID}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={list}
      id={MENTION_MENU_ID}
      role="listbox"
      aria-label="Connectors"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      <p className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Connectors</p>
      {connectors.map((c, i) => {
        const state = status[c.id]?.state;
        const note =
          state === "ready" ? null : state === "needs-auth" ? "sign in needed" : state === "error" ? "error" : "connecting";
        return (
          <div
            key={c.id}
            id={`${MENTION_MENU_ID}-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown, not click, so the textarea keeps focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseMove={() => onHover(i)}
            className={cn(
              "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm",
              i === active && "bg-accent text-accent-foreground",
            )}
          >
            <ConnectorGlyph connector={c} />
            <span className="font-medium">@{mentionName(c)}</span>
            <span className="truncate text-xs text-muted-foreground">{c.name}</span>
            {note && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{note}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A connector's logo as a mask in its brand color, or a plug. */
export function ConnectorGlyph({ connector, className }: { connector: Connector; className?: string }) {
  const src = connectorIcon(connector);
  if (!src) return <PlugIcon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  return (
    <span
      aria-hidden
      className={cn("size-4 shrink-0 bg-current", className)}
      style={{
        backgroundColor: catalogEntry(connector.catalogId)?.color,
        mask: `url("${src}") center / contain no-repeat`,
        WebkitMask: `url("${src}") center / contain no-repeat`,
      }}
    />
  );
}
