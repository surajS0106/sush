// The `/` command picker above the composer: lists skills and built-in commands
// while the user types the command word, like Claude Code and Copilot.

import { ScrollTextIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { hasMentions, mentionSegments } from "@/lib/mentions";
import { leadingCommand, slashCommands, type SlashCommand } from "@/lib/skills";
import { cn } from "@/lib/utils";

export const SLASH_MENU_ID = "slash-menu";

/** Commands matching what's typed so far; null when the input isn't a bare `/word`. */
function matches(value: string): SlashCommand[] | null {
  const query = /^\/([a-z0-9-]*)$/i.exec(value)?.[1]?.toLowerCase();
  if (query === undefined) return null;
  const all = slashCommands().filter((c) => c.name.includes(query));
  // Prefix matches first, then the rest in their usual order.
  return [...all.filter((c) => c.name.startsWith(query)), ...all.filter((c) => !c.name.startsWith(query))];
}

/** Picker state plus a keydown handler for the textarea. */
export function useSlashMenu(value: string, setValue: (v: string) => void) {
  const [active, setActive] = useState(0);
  // Escape hides the menu until the input changes.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const commands = (value === dismissedAt ? null : matches(value)) ?? [];
  const open = commands.length > 0;

  useEffect(() => setActive(0), [value]);

  const pick = (c: SlashCommand) => setValue(`/${c.name} `);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    const n = commands.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      const c = commands[active];
      // A fully typed command sends on Enter; otherwise Enter completes it.
      if (e.key === "Enter" && value.toLowerCase() === `/${c.name}`) return;
      e.preventDefault();
      pick(c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissedAt(value);
    }
  };

  return {
    open,
    commands,
    active,
    setActive,
    pick,
    onKeyDown,
    activeId: open ? `${SLASH_MENU_ID}-${active}` : undefined,
  };
}

interface SlashMenuProps {
  commands: SlashCommand[];
  active: number;
  onHover: (i: number) => void;
  onPick: (c: SlashCommand) => void;
}

export function SlashMenu({ commands, active, onHover, onPick }: SlashMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`#${SLASH_MENU_ID}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={list}
      id={SLASH_MENU_ID}
      role="listbox"
      aria-label="Commands"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      {commands.map((c, i) => {
        const Icon = c.skill ? ScrollTextIcon : SparklesIcon;
        return (
          <div
            key={c.name}
            id={`${SLASH_MENU_ID}-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown, not click, so the textarea keeps focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseMove={() => onHover(i)}
            className={cn(
              "flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm",
              i === active && "bg-accent text-accent-foreground",
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">/{c.name}</span>
                {c.skill && !c.skill.enabled && <span className="text-xs text-muted-foreground">off</span>}
              </div>
              {c.description && <p className="line-clamp-1 text-xs text-muted-foreground">{c.description}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Box-shadow pads the chip without shifting the text against the caret. No font-weight
// change either: bolder glyphs are wider, which drifts the text ahead of the caret.
const CHIP = "rounded-[5px] bg-brand/12 text-brand shadow-[0_0_0_3px] shadow-brand/12";

/**
 * Paints a leading `/command` and `@connector` mentions as chips behind the composer textarea, which can't
 * style part of its own text. It mirrors the textarea's text and box exactly; while
 * a command is present the textarea's own glyphs go transparent (caret and selection
 * stay), so what shows is this copy.
 */
export function SlashHighlight({
  value,
  className,
  scrollRef,
}: {
  value: string;
  /** The textarea's typography and padding, so lines wrap identically. */
  className: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const command = leadingCommand(value) ?? "";
  if (!command && !hasMentions(value)) return null;
  return (
    <div
      ref={scrollRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap", className)}
    >
      {command && <span className={CHIP}>{command}</span>}
      {mentionSegments(value.slice(command.length)).map((s, i) =>
        s.connector ? (
          <span key={i} className={CHIP}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
      {/* A trailing newline needs content after it to take up a line, as in the textarea. */}
      {"\u200b"}
    </div>
  );
}

/** Whether `SlashHighlight` paints anything, in which case the textarea hides its own glyphs. */
export const hasHighlight = (value: string) => leadingCommand(value) !== null || hasMentions(value);
