// The docs editor's code block: BlockNote's own spec (keyboard shortcuts, Markdown, the
// `highlight` hook Shiki colours by) with its toolbar replaced. BlockNote draws a native
// <select>, as wide as its longest option and styled by the OS; here the language is a
// small button sized to its name that opens a filterable list, with Copy on the right.
// Also the code block's editing keys: Tab / Shift+Tab indent and outdent, Enter keeps
// the line's indent.

import { createCodeBlockSpec, type BlockNoteEditor } from "@blocknote/core";
import type { EditorView } from "prosemirror-view";
import { toast } from "sonner";

type Languages = Record<string, { name: string; aliases?: string[] }>;

const INDENT = "  ";

const CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const COPY =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (html) e.innerHTML = html;
  return e;
}

/** The text of a plain-content block (a code block's content is styled text runs). */
function blockText(content: unknown): string {
  return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("") : "";
}

/**
 * The language list: a filter field over the languages, keyboard and mouse. It lives on
 * <body>, fixed under the button, not inside the block: ProseMirror watches the editor's
 * DOM and redraws a block whose markup changes, which would take a menu inside it away.
 */
function openMenu(anchor: HTMLElement, languages: Languages, current: string, pick: (id: string) => void, onClose: () => void): () => void {
  const menu = el("div", "doc-code-menu");
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Code language");
  const input = el("input", "doc-code-menu-filter");
  input.placeholder = "Search for a language…";
  input.setAttribute("aria-label", "Search for a language");
  const list = el("div", "doc-code-menu-list");
  list.setAttribute("role", "listbox");
  menu.append(input, list);

  const all = Object.entries(languages);
  let shown = all;
  let active = Math.max(0, all.findIndex(([id]) => id === current));

  // The list is rebuilt only when the filter changes. Hovering moves the highlight on the
  // existing rows, so the row under the pointer is still there when it's pressed.
  const highlight = (i: number, reveal: boolean) => {
    list.children[active]?.removeAttribute("data-active");
    active = i;
    const row = list.children[active] as HTMLElement | undefined;
    if (!row) return;
    row.dataset.active = "";
    // Scroll the list by hand: scrollIntoView would also scroll the doc behind the menu.
    if (reveal) {
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  };
  const draw = () => {
    list.replaceChildren();
    if (!shown.length) list.append(el("div", "doc-code-menu-empty", "No matching language"));
    shown.forEach(([id, { name }], i) => {
      const item = el("div", "doc-code-menu-item");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(id === current));
      item.textContent = name;
      if (id === current) item.insertAdjacentHTML("beforeend", CHECK);
      // Picked on press, so nothing between press and release (a redraw, a blur) can lose it.
      item.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        choose(id);
      });
      item.addEventListener("mouseenter", () => highlight(i, false));
      list.append(item);
    });
    highlight(Math.min(active, Math.max(0, shown.length - 1)), true);
  };

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const height = menu.offsetHeight || 300;
    const below = r.bottom + 4 + height <= window.innerHeight - 8;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - height)}px`;
  };

  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", onScroll, true);
    menu.remove();
    onClose();
  };
  const choose = (id: string) => {
    close();
    pick(id);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  // The menu is fixed, so it follows the button when the doc scrolls.
  const onScroll = (e: Event) => {
    if (!menu.contains(e.target as Node)) place();
  };

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    shown = all.filter(([id, { name, aliases }]) => !q || [id, name, ...(aliases ?? [])].some((s) => s.toLowerCase().includes(q)));
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      highlight((active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) choose(shown[active][0]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  });

  document.body.append(menu);
  draw();
  place();
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("resize", close);
  window.addEventListener("scroll", onScroll, true);
  input.focus({ preventScroll: true });
  return close;
}

/** One indent level for a language: 4 spaces where that's the convention, a tab for Go. */
const FOUR = new Set(["python", "rust", "java", "c", "cpp", "csharp", "kotlin", "swift", "php", "powershell"]);
function indentUnit(language: string): string {
  return language === "go" ? "\t" : FOUR.has(language) ? "    " : INDENT;
}

/** Languages whose open tags (`<div>`) open a level. */
const TAG_LANGUAGES = new Set(["html", "xml", "jsx", "tsx", "markdown"]);
/** Elements that never close, so `<br>` or `<img …>` doesn't indent. */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const CLOSER: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/**
 * Whether the text before the caret on its line opens a level, and if so what closes it (for
 * splitting a pair the caret sits in): a trailing `{ [ (`, a trailing `:` in Python and YAML,
 * an open tag in markup, `then` / `do` in shell.
 */
function opener(before: string, language: string): { closer?: string } | null {
  const t = before.trimEnd();
  if (!t || language === "text") return null;
  const last = t[t.length - 1];
  if (last in CLOSER) return { closer: CLOSER[last] };
  if ((language === "python" || language === "yaml") && last === ":") return {};
  if (language === "bash" && /(^|[\s;])(then|do)$/.test(t)) return {};
  if (TAG_LANGUAGES.has(language)) {
    const tag = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>$/.exec(t);
    if (tag && !t.endsWith("/>") && !VOID_TAGS.has(tag[1].toLowerCase())) return { closer: `</${tag[1]}` };
  }
  return null;
}

/**
 * Typing and editing keys inside a code block, run before BlockNote's keys (from the editor's
 * capture listener). Returns whether the key was used. Indentation follows the block's
 * language (`indentUnit`).
 *  - Tab with a caret inserts an indent; with lines selected, indents each of them.
 *  - Shift+Tab takes one indent off the start of each line in the selection.
 *  - Enter starts the next line at the current indent, one level deeper after an opener, and
 *    between a pair (`{|}`, `<div>|</div>`) puts the closer on its own line below. On a blank
 *    line it's left to BlockNote, which also leaves the block after two empty lines.
 *  - A closer (`}` `]` `)`, or the `/` of `</`) typed on an indented blank line steps back a level.
 */
export function codeBlockKey(view: EditorView, e: KeyboardEvent): boolean {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
  const isCloser = e.key === "}" || e.key === "]" || e.key === ")" || e.key === "/";
  if (e.key !== "Tab" && !(e.key === "Enter" && !e.shiftKey) && !isCloser) return false;
  const { state } = view;
  const { $from, $to } = state.selection;
  if ($from.parent.type.name !== "codeBlock" || !$from.sameParent($to)) return false;

  const language = String($from.parent.attrs.language ?? "text");
  const unit = indentUnit(language);
  const base = $from.start();
  const text = $from.parent.textContent;
  const from = $from.parentOffset;
  const to = $to.parentOffset;
  const lineStart = (i: number) => text.lastIndexOf("\n", i - 1) + 1;
  const start = lineStart(from);
  const before = text.slice(start, from);
  // One level off the front of the text at `s`: a tab, or up to one unit of spaces.
  const outdentAt = (s: number) => text.slice(s).match(new RegExp(`^(\\t| {1,${unit === "\t" ? INDENT.length : unit.length}})`))?.[0].length ?? 0;

  if (isCloser) {
    if (from !== to || !/^[ \t]+$/.test(e.key === "/" ? before.replace(/<$/, "") : before)) return false;
    if (e.key === "/" && (!TAG_LANGUAGES.has(language) || !before.endsWith("<"))) return false;
    const n = outdentAt(start);
    if (!n) return false;
    view.dispatch(state.tr.delete(base + start, base + start + n).insertText(e.key, base + from - n).scrollIntoView());
    return true;
  }

  if (e.key === "Enter") {
    if (!before.trim() && !text.slice(from, text.indexOf("\n", from) === -1 ? undefined : text.indexOf("\n", from)).trim()) return false;
    const indent = before.match(/^[ \t]*/)?.[0] ?? "";
    const open = opener(before, language);
    if (!indent && !open) return false;
    const inner = open ? indent + unit : indent;
    const after = text.slice(to);
    const split = open?.closer && after.trimStart().startsWith(open.closer);
    const first = `\n${inner}`;
    const tr = state.tr.insertText(split ? `${first}\n${indent}` : first, base + from, base + to);
    if (split) {
      // The caret goes on the inner line, above the closer. A code block's selection is a
      // TextSelection; its own class makes the new one (prosemirror-state isn't a dependency here).
      const Sel = state.selection.constructor as unknown as { create?: (doc: typeof tr.doc, pos: number) => typeof state.selection };
      if (Sel.create) tr.setSelection(Sel.create(tr.doc, base + from + first.length));
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  // Tab and Shift+Tab: the start of every line the selection touches (a caret touches one).
  const starts = [start];
  for (let i = text.indexOf("\n", start); i !== -1 && i < to; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const tr = state.tr;
  if (!e.shiftKey && from === to) {
    tr.insertText(unit, base + from);
  } else if (!e.shiftKey) {
    for (const s of starts.reverse()) tr.insertText(unit, base + s);
  } else {
    for (const s of starts.reverse()) {
      const n = outdentAt(s);
      if (n) tr.delete(base + s, base + s + n);
    }
  }
  if (tr.docChanged) view.dispatch(tr.scrollIntoView());
  return true;
}

/** The code block spec, with BlockNote's behaviour and Sush's toolbar. */
export function codeBlockSpec(options: { defaultLanguage: string; supportedLanguages: Languages }) {
  const spec = createCodeBlockSpec(options);
  const languages = options.supportedLanguages;
  // BlockNote's render is already wrapped to put its output in the block's content element
  // (`.bn-block-content[data-content-type="codeBlock"]`, which every code block style keys
  // on), so it's called as is and only its <select> is swapped for the bar.
  const maybeBase = spec.implementation.render;
  if (!maybeBase) return spec;
  const base: NonNullable<typeof maybeBase> = maybeBase;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(this: unknown, block: any, editor: BlockNoteEditor<any, any, any>) {
        const out = base.call(this as never, block, editor);
        const language: string = block.props.language;
        const name = languages[language]?.name ?? language;
        // The block as it is now, found from where this view sits, not from `block`. A reload
        // (replaceBlocks) gives every block a new id, but ProseMirror keeps a view whose node is
        // unchanged (the id lives on the block's container), so `block.id` can be stale, and
        // updateBlock with it throws: the language wouldn't change.
        const getPos = (this as { props?: { getPos?: () => number | undefined } } | undefined)?.props?.getPos;
        const current = () => {
          const pos = getPos?.();
          if (pos === undefined) return { id: block.id as string, language, text: blockText(editor.getBlock(block.id)?.content) };
          const doc = editor.prosemirrorView.state.doc;
          const node = doc.nodeAt(pos);
          const container = doc.resolve(pos).parent;
          return { id: String(container.attrs.id ?? block.id), language: String(node?.attrs.language ?? language), text: node?.textContent ?? "" };
        };
        const bar = el("div", "doc-code-bar");
        bar.contentEditable = "false";
        // The bar's presses are its own, not ProseMirror's (which would select the block).
        for (const type of ["mousedown", "pointerdown", "click"]) bar.addEventListener(type, (e) => e.stopPropagation());

        // Nothing in the bar changes after it's drawn: ProseMirror would take a change to the
        // block's markup as an edit and redraw it.
        let closeMenu: (() => void) | undefined;
        if (editor.isEditable) {
          const button = el("button", "doc-code-lang", `<span></span>${CHEVRON}`);
          button.type = "button";
          button.firstElementChild!.textContent = name;
          button.setAttribute("aria-haspopup", "listbox");
          button.setAttribute("aria-label", `Language: ${name}. Change language`);
          button.addEventListener("mousedown", (e) => e.preventDefault());
          button.addEventListener("click", () => {
            if (closeMenu) return closeMenu();
            closeMenu = openMenu(
              button,
              languages,
              language,
              (id) => {
                const now = current();
                if (id !== now.language) editor.updateBlock(now.id, { props: { language: id } });
                editor.focus();
              },
              () => (closeMenu = undefined),
            );
          });
          bar.append(button);
        } else {
          const label = el("span", "doc-code-lang");
          label.textContent = name;
          bar.append(label);
        }

        const copy = el("button", "doc-code-copy", `${COPY}<span>Copy</span>`);
        copy.type = "button";
        copy.setAttribute("aria-label", "Copy code");
        copy.addEventListener("mousedown", (e) => e.preventDefault());
        copy.addEventListener("click", () => {
          navigator.clipboard.writeText(current().text).then(
            () => toast.success("Code copied"),
            () => toast.error("Couldn't copy the code"),
          );
        });
        bar.append(copy);

        const pre = out.dom.querySelector("pre");
        const picker = out.dom.querySelector("select")?.parentElement;
        if (picker) picker.replaceWith(bar);
        else if (pre) pre.before(bar);
        else out.dom.prepend(bar);
        return {
          ...out,
          destroy: () => {
            out.destroy?.();
            closeMenu?.();
          },
        };
      },
    },
  } as typeof spec;
}
