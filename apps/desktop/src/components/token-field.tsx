// A text field where values from earlier workflow steps show as chips
// ("Company", "Research the customer") instead of `{{trigger.record.company}}`.
// The text is still stored with `{{key}}` markers, so nothing else changes;
// people just never have to read or type them. "+ Insert" puts a value at
// the cursor; a chip deletes as one piece with Backspace.

import { PlusIcon } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Variable } from "@/lib/workflows";

const TOKEN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const CHIP =
  "mx-0.5 inline-flex select-none items-center rounded-md bg-brand/12 px-1.5 py-px align-baseline text-xs font-medium text-brand whitespace-nowrap";

export interface TokenFieldHandle {
  insert: (key: string) => void;
}

/** Build the field's contents: text, and a chip per `{{key}}`. */
function render(el: HTMLElement, value: string, labelFor: (key: string) => string) {
  el.replaceChildren();
  let last = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index! > last) el.append(document.createTextNode(value.slice(last, m.index)));
    el.append(chip(m[1], labelFor(m[1])));
    last = m.index! + m[0].length;
  }
  if (last < value.length) el.append(document.createTextNode(value.slice(last)));
}

function chip(key: string, label: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.token = key;
  span.className = CHIP;
  span.textContent = label;
  return span;
}

/** Read the field back as text with `{{key}}` markers. */
function serialize(node: Node): string {
  let out = "";
  node.childNodes.forEach((c) => {
    if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue ?? "";
    else if (c instanceof HTMLElement) {
      if (c.dataset.token) out += `{{${c.dataset.token}}}`;
      else if (c.tagName === "BR") out += "\n";
      else {
        // A browser's own line (a div from Enter) starts on a new line.
        if ((c.tagName === "DIV" || c.tagName === "P") && out && !out.endsWith("\n")) out += "\n";
        out += serialize(c);
      }
    }
  });
  return out;
}

export const TokenField = forwardRef<
  TokenFieldHandle,
  {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    labelFor: (key: string) => string;
    multiline?: boolean;
    placeholder?: string;
    "aria-label"?: string;
    "aria-describedby"?: string;
  }
>(function TokenField({ id, value, onChange, labelFor, multiline, placeholder, ...aria }, ref) {
  const el = useRef<HTMLDivElement>(null);
  /** What this field last sent, so its own edits don't rebuild it under the cursor. */
  const sent = useRef<string | null>(null);
  const range = useRef<Range | null>(null);

  useLayoutEffect(() => {
    if (!el.current || value === sent.current) return;
    render(el.current, value, labelFor);
    sent.current = value;
  }, [value, labelFor]);

  // Remember where the cursor was, so Insert (from a menu that takes focus) lands there.
  useEffect(() => {
    const keep = () => {
      const sel = document.getSelection();
      if (sel?.rangeCount && el.current?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", keep);
    return () => document.removeEventListener("selectionchange", keep);
  }, []);

  const emit = () => {
    if (!el.current) return;
    const v = serialize(el.current);
    sent.current = v;
    onChange(v);
  };

  useImperativeHandle(ref, () => ({
    insert: (key) => {
      const box = el.current;
      if (!box) return;
      box.focus();
      const sel = document.getSelection();
      let r = range.current && box.contains(range.current.startContainer) ? range.current : null;
      if (!r) {
        r = document.createRange();
        r.selectNodeContents(box);
        r.collapse(false);
      }
      r.deleteContents();
      const c = chip(key, labelFor(key));
      const after = document.createTextNode(" ");
      r.insertNode(after);
      r.insertNode(c);
      r.setStartAfter(after);
      r.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(r);
      emit();
    },
  }));

  return (
    <div className="relative">
      <div
        ref={el}
        id={id}
        role="textbox"
        aria-multiline={multiline || undefined}
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
        {...aria}
        onInput={emit}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (multiline) document.execCommand("insertText", false, "\n");
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, multiline ? text : text.replace(/\s*\n\s*/g, " "));
        }}
        className={cn(
          "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-6 break-words whitespace-pre-wrap outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
          multiline ? "min-h-24" : "min-h-9 overflow-hidden",
        )}
      />
      {!value && placeholder && (
        <span aria-hidden className="pointer-events-none absolute top-2 left-3 right-3 text-sm leading-6 text-muted-foreground">
          {placeholder}
        </span>
      )}
    </div>
  );
});

/** "+ Insert": the values a step can use, by where they come from. */
export function InsertMenu({ variables, onPick }: { variables: Variable[]; onPick: (key: string) => void }) {
  if (variables.length === 0) return null;
  const groups = [...new Set(variables.map((v) => v.group))];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="text-brand" onMouseDown={(e) => e.preventDefault()}>
          <PlusIcon />
          Insert
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {groups.map((g, i) => (
          <DropdownMenuGroup key={g}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{g}</DropdownMenuLabel>
            {variables
              .filter((v) => v.group === g)
              .map((v) => (
                <DropdownMenuItem key={v.key} onSelect={() => onPick(v.key)}>
                  <span className={CHIP}>{v.label}</span>
                </DropdownMenuItem>
              ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
