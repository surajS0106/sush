// The doc editor: a Notion-style block editor (BlockNote, shadcn flavour) over
// a doc's Markdown, with its title and icon above it. "/" opens the block menu,
// the handle beside each block drags it or opens its menu, and selecting text
// shows the formatting toolbar, with "Ask Sush" when the doc is open beside a
// chat. Changes save themselves (`saveDoc`) a moment after typing stops.
//
// Loaded on demand (React.lazy): the editor is large and most chats never open a doc.
//
// Markdown is the stored form, so a doc goes through BlockNote's converter both
// ways. The text is saved only once it differs from what loading produced, so
// opening a doc never records an edit.

import "@blocknote/shadcn/style.css";

import type { BlockNoteEditor } from "@blocknote/core";
import { SuggestionMenu as SuggestionMenuExtension, SyntaxHighlightingExtension } from "@blocknote/core/extensions";
import {
  type DefaultReactSuggestionItem,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  SuggestionMenuController,
  type SuggestionMenuProps,
  TableHandlesController,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useExtensionState,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import {
  ChevronDownIcon,
  ChevronRightSquareIcon,
  CodeIcon,
  EllipsisIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  RotateCcwIcon,
  SearchIcon,
  SparklesIcon,
  TableIcon,
  TextQuoteIcon,
  TypeIcon,
  WorkflowIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { DocByline } from "@/components/doc-byline";
import { DocTableHandle } from "@/components/doc-table-menu";
import { MascotSprite } from "@/components/mascot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DIAGRAM_GUIDE } from "@/lib/diagram";
import { complete, extractJson } from "@/lib/complete";
import { codeBlockKey } from "@/lib/doc-code-block";
import { SELECT_ALL_EVENT } from "@/lib/select-all";
import { blocksToMarkdown, markdownToBlocks, schema } from "@/lib/doc-schema";
import { getDoc, saveDoc } from "@/lib/docs";
import { useMascot } from "@/lib/mascot";
import { getTarget } from "@/lib/store";
import type { Doc } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- toolbar ----------------------------------------------------------------------------

function AskButton({ onAsk }: { onAsk: (selection: string) => void }) {
  const editor = useBlockNoteEditor(schema);
  const Components = useComponentsContext()!;
  const kind = useMascot();
  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Ask Sush about this"
      label="Ask Sush"
      icon={<MascotSprite kind={kind} scale={0.4} />}
      onClick={() => onAsk(editor.getSelectedText())}
    >
      <span className="flex items-center gap-1.5 px-0.5 text-xs font-medium">
        <MascotSprite kind={kind} scale={0.35} /> Ask Sush
      </span>
    </Components.FormattingToolbar.Button>
  );
}

// --- the block sushi --------------------------------------------------------------------
//
// Beside the block the cursor is in sits a small Sushi. Clicking it asks the chat's model
// for three ways to improve that block; picking one replaces the block, as an ordinary edit
// (it saves, and shows in the history as yours).

interface Suggestion {
  label: string;
  text: string;
}

const SUGGEST_SYSTEM =
  "You help someone edit a document. You get the whole document for context and one block of it, in Markdown. " +
  "Suggest exactly three different ways to improve that block, each a complete replacement for it in Markdown: for " +
  "example tighten the wording, make it clearer, add a concrete example or detail the document supports, or turn it " +
  "into a list, checklist or table when that reads better. Fit the block's place in the document; keep its facts and " +
  "never invent figures, names or dates; write in the document's language and tone; keep a heading a heading. Reply " +
  'with JSON only: {"suggestions":[{"label":"…","text":"…"}]}. `label` is 2 to 5 words saying what the suggestion ' +
  'does ("Tighten the wording"); `text` is the new block.';

/** Most of the document the model gets as context, in characters. */
const CONTEXT_CHARS = 12_000;

/** Suggestions already fetched, by block id and text: reopening the menu on an unchanged block is instant. */
const suggestionCache = new Map<string, Suggestion[]>();

async function fetchSuggestions(title: string, doc: string, block: string): Promise<Suggestion[]> {
  const target = getTarget();
  if (!target) throw new Error("Pick a model in the chat first.");
  const context = doc.length > CONTEXT_CHARS ? `${doc.slice(0, CONTEXT_CHARS)}\n…` : doc;
  const reply = await complete(target, SUGGEST_SYSTEM, `Title: ${title}\n\n<document>\n${context}\n</document>\n\n<block>\n${block}\n</block>`);
  const raw = (extractJson(reply) as { suggestions?: unknown })?.suggestions;
  const list = (Array.isArray(raw) ? raw : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return typeof o.label === "string" && typeof o.text === "string" && o.text.trim() ? [{ label: o.label.trim(), text: o.text.trim() }] : [];
  });
  if (list.length === 0) throw new Error("The model didn't suggest anything. Try again.");
  return list.slice(0, 3);
}

interface Anchor {
  id: string;
  top: number;
  left: number;
}

type BlockEditor = BlockNoteEditor<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>;

// Code blocks are coloured by Shiki, loaded the first time a doc shows one; languages load
// as blocks use them. With a light and a dark theme loaded, BlockNote writes both colours
// on each token (--shiki-light / --shiki-dark) and index.css picks one by the app's theme.
// BlockNote finds the pair by "light" and "dark" in their names, so both must carry them.
// Night Owl Light (calm blues and teals, italic accents) on the light paper, Vitesse Dark
// (soft, muted) on the dark one.
const CODE_HIGHLIGHTING = SyntaxHighlightingExtension({
  createHighlighter: () => import("shiki").then((s) => s.createHighlighter({ themes: ["night-owl-light", "vitesse-dark"], langs: [] })),
});

function BlockSushi({ editor, anchor, title, onOpenChange }: { editor: BlockEditor; anchor: Anchor; title: string; onOpenChange: (open: boolean) => void }) {
  const kind = useMascot();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; error?: string; suggestions?: Suggestion[] }>({ loading: false });

  const load = async (fresh: boolean) => {
    const block = editor.getBlock(anchor.id);
    if (!block) return;
    const markdown = blocksToMarkdown(editor, [block]).trim();
    const key = `${anchor.id}\n${markdown}`;
    const cached = !fresh && suggestionCache.get(key);
    if (cached) return setState({ loading: false, suggestions: cached });
    setState({ loading: true });
    try {
      const suggestions = await fetchSuggestions(title, blocksToMarkdown(editor), markdown);
      suggestionCache.set(key, suggestions);
      setState({ loading: false, suggestions });
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const apply = (s: Suggestion) => {
    if (!editor.getBlock(anchor.id)) return toast.error("That block is gone.");
    const blocks = markdownToBlocks(editor, s.text);
    if (blocks.length === 0) return;
    editor.replaceBlocks([anchor.id], blocks);
    const last = blocks.at(-1);
    if (last) editor.setTextCursorPosition(last.id, "end");
    editor.focus();
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange(o);
        if (o) void load(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Suggestions for this block"
          title="Suggestions for this block"
          // Keep the cursor where it is: the block stays the one suggested for.
          onMouseDown={(e) => e.preventDefault()}
          className="doc-block-sushi absolute z-10 flex size-7 items-center justify-center rounded-md opacity-70 transition hover:bg-accent hover:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100"
          style={{ top: anchor.top, left: anchor.left }}
        >
          <MascotSprite kind={kind} scale={0.42} closed={!open} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-80">
        <DropdownMenuLabel className="flex items-center gap-2">
          <MascotSprite kind={kind} scale={0.3} /> Sushi suggests
        </DropdownMenuLabel>
        {state.loading && (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Reading this block…
          </div>
        )}
        {state.error && <p className="px-2 py-2 text-sm text-destructive">{state.error}</p>}
        {state.suggestions?.map((s, i) => (
          <DropdownMenuItem key={i} onSelect={() => apply(s)} className="flex-col items-start gap-0.5">
            <span className="font-medium">{s.label}</span>
            <span className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{s.text}</span>
          </DropdownMenuItem>
        ))}
        {!state.loading && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void load(true);
              }}
            >
              <RotateCcwIcon /> Try again
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- the toolbar ------------------------------------------------------------------------
//
// Floats at the bottom of the doc, like Claude's: turn the current block into another kind,
// insert a table, a diagram (drawn by Sush from the section, or blank), a checklist or a
// toggle, more blocks under "⋯", and Ask Sush about the selection or the current block.

const BLANK_DIAGRAM = JSON.stringify(
  {
    title: "New diagram",
    nodes: [
      { id: "start", label: "Start", detail: "What sets it off", focus: true },
      { id: "step", label: "Step", detail: "What happens next" },
      { id: "result", label: "Result", detail: "What comes out" },
    ],
    edges: [
      { from: "start", to: "step" },
      { from: "step", to: "result" },
    ],
  },
  null,
  2,
);

const DRAW_SYSTEM =
  "You turn part of a document into one diagram. " +
  DIAGRAM_GUIDE +
  " Reply with the JSON object only, no code fence and no prose. Use only what the text says.";

/** The section the block is in: from the heading above it to the next heading of the same level or higher. */
function sectionAround(editor: BlockEditor, blockId: string): string {
  const all = editor.document;
  const at = all.findIndex((b) => b.id === blockId);
  if (at < 0) return blocksToMarkdown(editor);
  let start = at;
  while (start > 0 && all[start].type !== "heading") start--;
  const level = all[start].type === "heading" ? Number((all[start].props as { level?: number }).level ?? 1) : 0;
  let end = at + 1;
  while (end < all.length && !(all[end].type === "heading" && Number((all[end].props as { level?: number }).level ?? 1) <= (level || 6))) end++;
  return blocksToMarkdown(editor, all.slice(start, end));
}

function ToolButton({ label, onClick, children, ...rest }: { label: string; onClick?: () => void; children: React.ReactNode } & React.ComponentProps<"button">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Keep the cursor in the doc: the toolbar acts on the block it's in.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className="flex h-8 min-w-8 items-center justify-center gap-0.5 rounded-lg px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground [&_svg]:size-4"
          {...rest}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function DocToolbar({ editor, title, onAsk }: { editor: BlockEditor; title: string; onAsk?: (text: string) => void }) {
  const kind = useMascot();
  const [drawing, setDrawing] = useState(false);

  const current = () => {
    try {
      return editor.getTextCursorPosition().block;
    } catch {
      return editor.document[editor.document.length - 1];
    }
  };
  const isEmpty = (b: ReturnType<typeof current>) => b.type === "paragraph" && !editor.blocksToMarkdownLossy([b]).trim();

  /** Puts blocks after the current one, or in its place when it's an empty line. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insert = (blocks: any[]) => {
    const at = current();
    const added = isEmpty(at) ? editor.replaceBlocks([at.id], blocks).insertedBlocks : editor.insertBlocks(blocks, at.id, "after");
    if (added[0]) editor.setTextCursorPosition(added[0].id, "end");
    editor.focus();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const turnInto = (update: any) => {
    editor.updateBlock(current().id, update);
    editor.focus();
  };

  const draw = async () => {
    const target = getTarget();
    if (!target) return toast.error("Pick a model in the chat first.");
    const at = current();
    setDrawing(true);
    const pending = toast.loading("Sush is drawing a diagram…");
    try {
      const reply = await complete(target, DRAW_SYSTEM, `Document: ${title}\n\n<section>\n${sectionAround(editor, at.id)}\n</section>`);
      const spec = extractJson(reply);
      insert([{ type: "diagram", props: { lang: "diagram", source: JSON.stringify(spec, null, 2) } }]);
    } catch (e) {
      toast.error("Couldn’t draw a diagram", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      toast.dismiss(pending);
      setDrawing(false);
    }
  };

  const ask = () => {
    const selected = editor.getSelectedText().trim();
    onAsk?.(selected || blocksToMarkdown(editor, [current()]).trim());
  };

  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-8 flex justify-center">
      <div role="toolbar" aria-label="Insert and format" className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-popover/95 p-1 shadow-lg backdrop-blur">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton label="Turn into">
              <TypeIcon />
              <ChevronDownIcon className="size-3!" />
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-48">
            <DropdownMenuItem onSelect={() => turnInto({ type: "paragraph", props: {} })}>
              <PilcrowIcon /> Text
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => turnInto({ type: "heading", props: { level: 1 } })}>
              <Heading1Icon /> Heading 1
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => turnInto({ type: "heading", props: { level: 2 } })}>
              <Heading2Icon /> Heading 2
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => turnInto({ type: "heading", props: { level: 3 } })}>
              <Heading3Icon /> Heading 3
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => turnInto({ type: "bulletListItem", props: {} })}>
              <ListIcon /> Bulleted list
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => turnInto({ type: "numberedListItem", props: {} })}>
              <ListOrderedIcon /> Numbered list
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => turnInto({ type: "quote", props: {} })}>
              <TextQuoteIcon /> Quote
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton
          label="Table"
          onClick={() =>
            insert([
              {
                type: "table",
                content: { type: "tableContent", headerRows: 1, rows: [{ cells: ["", "", ""] }, { cells: ["", "", ""] }, { cells: ["", "", ""] }] },
              },
            ])
          }
        >
          <TableIcon />
        </ToolButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton label="Diagram" disabled={drawing}>
              {drawing ? <Spinner className="size-4" /> : <WorkflowIcon />}
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuItem onSelect={() => void draw()}>
              <SparklesIcon />
              <span className="flex flex-col">
                Draw this section
                <span className="text-xs text-muted-foreground">Sush makes a flow chart from it</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => insert([{ type: "diagram", props: { lang: "diagram", source: BLANK_DIAGRAM } }])}>
              <WorkflowIcon /> Blank diagram
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton label="Checklist" onClick={() => insert([{ type: "checkListItem", content: "" }])}>
          <ListChecksIcon />
        </ToolButton>
        <ToolButton label="Toggle list" onClick={() => insert([{ type: "toggleListItem", content: "" }])}>
          <ChevronRightSquareIcon />
        </ToolButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton label="More blocks">
              <EllipsisIcon />
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-48">
            <DropdownMenuItem onSelect={() => insert([{ type: "bulletListItem", content: "" }])}>
              <ListIcon /> Bulleted list
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => insert([{ type: "numberedListItem", content: "" }])}>
              <ListOrderedIcon /> Numbered list
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => insert([{ type: "quote", content: "" }])}>
              <TextQuoteIcon /> Quote
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => insert([{ type: "codeBlock", props: { language: "text" }, content: "" }])}>
              <CodeIcon /> Code
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => insert([{ type: "divider" }, { type: "paragraph", content: "" }])}>
              <MinusIcon /> Divider
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onAsk && (
          <>
            <span className="mx-1 h-5 w-px bg-border" />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={ask}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium transition-colors hover:bg-accent/70"
            >
              <MascotSprite kind={kind} scale={0.4} /> Ask Sush
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// --- the editor -------------------------------------------------------------------------


const ICONS = ["📄", "📝", "📈", "💡", "🚀", "🎯", "📊", "🧭", "🛠️", "📚", "✅", "🗓️", "💬", "🔍", "🏁", "🌱", "⚡", "🧪", "🍣", "❤️"];

/** How long after typing stops a change is saved. */
const SAVE_DELAY = 700;

export interface DocEditorProps {
  doc: Doc;
  /** Ask about the selected text in the doc's chat; leave out where there's no chat. */
  onAsk?: (selection: string) => void;
  /** The scrolling element's child that holds the blocks, for the outline to find headings in. */
  className?: string;
}

export default function DocEditor({ doc, onAsk, className }: DocEditorProps) {
  const { resolvedTheme } = useTheme();
  const editor = useCreateBlockNote({ schema, extensions: [CODE_HIGHLIGHTING] });
  const rootRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const menuOpen = useRef(false);

  // The sushi sits at the right of the block the cursor is in, level with its first line.
  const place = useCallback(() => {
    const root = rootRef.current;
    if (!root || menuOpen.current) return;
    let block;
    try {
      block = editor.getTextCursorPosition().block;
    } catch {
      return;
    }
    const el = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${block.id}"] .bn-block-content`);
    if (!el || block.type === "diagram" || !editor.blocksToMarkdownLossy([block]).trim()) return setAnchor(null);
    const r = el.getBoundingClientRect();
    const c = root.getBoundingClientRect();
    setAnchor({ id: block.id, top: r.top - c.top, left: r.right - c.left + 8 });
  }, [editor]);

  // Undo and redo, handled here rather than left to the keymap: on macOS the window's Edit menu
  // owns Cmd+Z, and it can run the webview's own undo (which knows nothing of the editor's changes)
  // instead of passing the key on. So the key is caught first, and the menu's undo request too.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // A text box inside the doc (a diagram's source) keeps its own undo.
    const inEditor = (t: EventTarget | null) => t instanceof Element && !!t.closest(".bn-editor") && !t.closest("textarea, input");
    const run = (redo: boolean) => {
      try {
        if (redo) editor.redo();
        else editor.undo();
      } catch {
        // No history yet.
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (!inEditor(e.target)) return;
      // Tab, Shift+Tab and Enter in a code block indent, outdent and keep the indent.
      if (codeBlockKey(editor.prosemirrorView, e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Select all, when the key reaches the page (Windows, Linux): BlockNote's Mod-a.
      if (k === "a" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        selectAll(e);
        return;
      }
      if (k !== "z" && k !== "y") return;
      e.preventDefault();
      e.stopPropagation();
      run(k === "y" || e.shiftKey);
    };
    const onInput = (e: InputEvent) => {
      if (!inEditor(e.target) || (e.inputType !== "historyUndo" && e.inputType !== "historyRedo")) return;
      e.preventDefault();
      e.stopPropagation();
      run(e.inputType === "historyRedo");
    };
    // Select all is BlockNote's Mod-a (the block's text, then the whole doc), handed a key event
    // straight, not through Tiptap's `keyboardShortcut` command, which keeps only a transaction's
    // steps and so dropped this selection-only change. On macOS Cmd+A is the Edit menu's, which
    // would select natively (nothing ProseMirror takes up, so nothing in a code block); the menu
    // item is Sush's own and asks the page (lib/select-all.ts), answered here.
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    let lastSelectAll = 0;
    const selectAll = (e?: KeyboardEvent) => {
      // A key that reached the page and the menu's request for the same press run it once.
      if (performance.now() - lastSelectAll < 150) return;
      lastSelectAll = performance.now();
      const view = editor.prosemirrorView;
      const key = e ?? new KeyboardEvent("keydown", { key: "a", metaKey: mac, ctrlKey: !mac });
      view.someProp("handleKeyDown", (f) => f(view, key));
    };
    const onSelectAll = (e: Event) => {
      if (!inEditor(e.target)) return;
      e.preventDefault();
      selectAll();
    };
    root.addEventListener("keydown", onKey, true);
    root.addEventListener("beforeinput", onInput, true);
    root.addEventListener(SELECT_ALL_EVENT, onSelectAll);
    return () => {
      root.removeEventListener("keydown", onKey, true);
      root.removeEventListener("beforeinput", onInput, true);
      root.removeEventListener(SELECT_ALL_EVENT, onSelectAll);
    };
  }, [editor]);

  useEffect(() => {
    const off = editor.onSelectionChange(() => place());
    window.addEventListener("resize", place);
    return () => {
      off?.();
      window.removeEventListener("resize", place);
    };
  }, [editor, place]);

  const [title, setTitle] = useState(doc.title);
  const [icon, setIcon] = useState<string | null>(doc.icon ?? null);
  // What's saved (or was loaded): the rev edits are made on, and its text as the editor writes it.
  const base = useRef({ rev: doc.rev, markdown: "", title: doc.title, icon: doc.icon ?? null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const loading = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const iconRef = useRef(icon);
  iconRef.current = icon;

  const load = useCallback(
    (d: Doc) => {
      loading.current = true;
      const blocks = markdownToBlocks(editor, d.content);
      // A blank doc still needs a block to type in. Loading isn't an edit, so it stays out of the
      // undo history: a first Cmd+Z mustn't empty the page.
      editor.transact((tr) => {
        tr.setMeta("addToHistory", false);
        editor.replaceBlocks(editor.document, blocks.length > 0 ? blocks : [{ type: "paragraph" }]);
      });
      base.current = { rev: d.rev, markdown: blocksToMarkdown(editor), title: d.title, icon: d.icon ?? null };
      setTitle(d.title);
      setIcon(d.icon ?? null);
      loading.current = false;
    },
    [editor],
  );

  // The doc's text, before the first paint.
  useLayoutEffect(() => {
    load(docRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, load]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const markdown = blocksToMarkdown(editor);
    const t = titleRef.current?.value ?? base.current.title;
    const ic = iconRef.current;
    const b = base.current;
    if (markdown === b.markdown && t.trim() === b.title.trim() && ic === b.icon) return;
    saving.current = true;
    const saved = await saveDoc(docRef.current, b.rev, t, markdown, ic);
    saving.current = false;
    if (saved) {
      base.current = { rev: saved.rev, markdown, title: saved.title, icon: saved.icon ?? null };
    }
    // Something else changed it meanwhile (or the save was refused): show that.
    const now = getDoc(docRef.current.id);
    if (now && now.rev !== base.current.rev) load(now);
  }, [editor, load]);

  const schedule = useCallback(() => {
    if (loading.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  }, [flush]);

  // Sush revised it, or another window saved: show the new text unless this editor made it.
  useEffect(() => {
    if (saving.current || doc.rev === base.current.rev) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    load(doc);
  }, [doc, load]);

  // Leaving with a change not yet saved saves it.
  useEffect(
    () => () => {
      if (timer.current) void flush();
    },
    [flush],
  );

  // The title grows with its text: measured again when it changes, when its width changes
  // (the panel is resized or still settling), and once the fonts have loaded.
  const fitTitle = useCallback(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fitTitle, [title, fitTitle]);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitTitle();
    });
    ro.observe(el);
    void document.fonts?.ready.then(fitTitle);
    return () => ro.disconnect();
  }, [fitTitle]);

  const pickIcon = (next: string | null) => {
    setIcon(next);
    iconRef.current = next;
    schedule();
  };

  return (
    <div ref={rootRef} className={cn("doc-editor relative", className)}>
      <div className="doc-gutter">
        <div className="group/title">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {icon ? (
                <button type="button" aria-label="Change icon" className="mb-2 rounded-lg p-1 text-4xl leading-none hover:bg-accent">
                  {icon}
                </button>
              ) : (
                <button
                  type="button"
                  className="mb-1 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground opacity-0 group-hover/title:opacity-100 hover:bg-accent focus-visible:opacity-100"
                >
                  Add icon
                </button>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <div className="grid grid-cols-5 gap-1 p-1">
                {ICONS.map((e) => (
                  <DropdownMenuItem key={e} onSelect={() => pickIcon(e)} className="justify-center text-xl">
                    {e}
                  </DropdownMenuItem>
                ))}
              </div>
              {icon && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => pickIcon(null)}>Remove icon</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <textarea
            ref={titleRef}
            value={title}
            rows={1}
            placeholder="Untitled"
            aria-label="Title"
            onChange={(e) => {
              setTitle(e.target.value.replace(/\n/g, ""));
              schedule();
            }}
            onKeyDown={(e) => {
              // Enter moves into the doc, like Notion.
              if (e.key === "Enter") {
                e.preventDefault();
                const first = editor.document[0];
                if (first) editor.setTextCursorPosition(first, "start");
                editor.focus();
              }
            }}
            className="doc-title w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted-foreground/50"
          />
          <DocByline doc={doc} className="mt-1.5 mb-4" />
        </div>
      </div>
      <BlockNoteView
        editor={editor}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        formattingToolbar={false}
        tableHandles={false}
        slashMenu={false}
        onChange={() => {
          schedule();
          place();
        }}
        className="doc-blocks"
      >
        <TableHandlesController tableHandle={DocTableHandle} />
        <SuggestionMenuController triggerCharacter="/" suggestionMenuComponent={SlashMenu} />
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>
              {getFormattingToolbarItems()}
              {onAsk && <AskButton onAsk={onAsk} />}
            </FormattingToolbar>
          )}
        />
      </BlockNoteView>
      <DocToolbar editor={editor} title={title} onAsk={onAsk} />
      {anchor && (
        <BlockSushi
          key={anchor.id}
          editor={editor}
          anchor={anchor}
          title={title}
          onOpenChange={(o) => {
            menuOpen.current = o;
            if (!o) place();
          }}
        />
      )}
    </div>
  );
}

/**
 * The "/" menu, with a search field on top. The field shows what's typed after the "/"
 * (that text is the query BlockNote filters by), so focus never leaves the doc: moving
 * it into a real input would close the menu, and arrow keys and Enter are handled by
 * the editor. Clicking the field keeps the cursor where it is.
 */
function SlashMenu({ items, loadingState, selectedIndex, onItemClick }: SuggestionMenuProps<DefaultReactSuggestionItem>) {
  const Components = useComponentsContext()!;
  const query = useExtensionState(SuggestionMenuExtension, { selector: (s) => s?.query ?? "" });

  const rows: React.ReactNode[] = [];
  let group: string | undefined;
  items.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group;
      rows.push(
        <Components.SuggestionMenu.Label key={`group-${group}`} className="bn-suggestion-menu-label">
          {group}
        </Components.SuggestionMenu.Label>,
      );
    }
    rows.push(
      <Components.SuggestionMenu.Item
        key={item.title}
        id={`bn-suggestion-menu-item-${i}`}
        className={cn("bn-suggestion-menu-item", item.size === "small" && "bn-suggestion-menu-item-small")}
        item={item}
        isSelected={i === selectedIndex}
        onClick={() => onItemClick?.(item)}
      />,
    );
  });
  const loading = loadingState !== "loaded";

  return (
    <div className="flex min-h-0 min-w-72 flex-col overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <div
        role="searchbox"
        aria-label="Search blocks"
        aria-readonly="true"
        onMouseDown={(e) => e.preventDefault()}
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-sm"
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        {query ? (
          <span className="truncate">{query}</span>
        ) : (
          <span className="truncate text-muted-foreground">Type to search blocks</span>
        )}
      </div>
      <Components.SuggestionMenu.Root
        id="bn-suggestion-menu"
        className="bn-suggestion-menu min-h-0 flex-1 rounded-none bg-transparent shadow-none ring-0"
      >
        {rows}
        {rows.length === 0 && !loading && (
          <Components.SuggestionMenu.EmptyItem className="bn-suggestion-menu-item">No matching blocks</Components.SuggestionMenu.EmptyItem>
        )}
        {loading && <Components.SuggestionMenu.Loader className="bn-suggestion-menu-loader" />}
      </Components.SuggestionMenu.Root>
    </div>
  );
}
