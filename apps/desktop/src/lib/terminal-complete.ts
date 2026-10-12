// Tab completion for the Cowork terminal: which word the caret is in, and how
// to write a completed name back so the shell reads it as one word. Rust
// (`terminal_complete`) does the listing; this is only the line editing.

import type { TerminalCompletion, TerminalInfo } from "@/lib/tauri";

type Shell = TerminalInfo["shell"];
type Quote = "'" | '"';

/** The word that ends at the caret. */
export interface Word {
  /** Where it starts in the line (its opening quote, if any). */
  start: number;
  /** Its text as the shell will read it: quotes and escapes removed. */
  text: string;
  /** The quote it opened with, if it starts with one. */
  quote: Quote | null;
}

const BREAK = /[\s|;&<>()]/;
/** Characters bash/sh would split or expand unless escaped. */
const SPECIAL = /[\s'"\\$`!&|;<>()*?[\]{}#]/g;
/** Characters that make PowerShell need the name quoted. */
const PS_SPECIAL = /[\s'"`$&|;(){}@,#]/;

/** Read the line up to the caret the way the shell would split it into words. */
export function wordAt(line: string, caret: number, shell: Shell): Word {
  const escape = shell === "powershell" ? "`" : "\\";
  let start = 0;
  let text = "";
  let quote: Quote | null = null;
  let opened: Quote | null = null;
  for (let i = 0; i < caret; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === escape && quote === '"' && i + 1 < caret) text += line[++i];
      else text += ch;
    } else if (BREAK.test(ch)) {
      start = i + 1;
      text = "";
      opened = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      if (i === start) opened = ch;
    } else if (ch === escape && i + 1 < caret) text += line[++i];
    else text += ch;
  }
  return { start, text, quote: opened };
}

/** Write `path` as one shell word. `done` closes an opened quote (a whole name, not a partial one). */
export function quotePath(path: string, shell: Shell, quote: Quote | null, done: boolean): string {
  if (shell === "powershell") {
    const q = quote ?? (PS_SPECIAL.test(path) ? "'" : null);
    if (!q) return path;
    const inner = q === "'" ? path.replace(/'/g, "''") : path.replace(/[`"$]/g, "`$&");
    return q + inner + (done ? q : "");
  }
  if (quote === "'") return `'${path.replace(/'/g, `'\\''`)}${done ? "'" : ""}`;
  if (quote === '"') return `"${path.replace(/[\\"$`]/g, "\\$&")}${done ? '"' : ""}`;
  return path.replace(SPECIAL, "\\$&");
}

/** The folder part of a word, up to and including its last separator. */
export function folderOf(text: string, shell: Shell): string {
  const at = Math.max(text.lastIndexOf("/"), shell === "powershell" ? text.lastIndexOf("\\") : -1);
  return text.slice(0, at + 1);
}

/** The longest start every name shares, ignoring case (spelled as the first name has it). */
export function commonPrefix(items: TerminalCompletion[]): string {
  if (!items.length) return "";
  const first = items[0].name;
  let n = first.length;
  for (const { name } of items.slice(1)) {
    let i = 0;
    while (i < n && i < name.length && name[i].toLowerCase() === first[i].toLowerCase()) i++;
    n = i;
  }
  return first.slice(0, n);
}

/** What a picked entry becomes: folders end in `/`; a lone file gets a space after it, like bash. */
export function completion(word: Word, item: TerminalCompletion, shell: Shell, trailingSpace: boolean): string {
  const path = folderOf(word.text, shell) + item.name + (item.dir ? "/" : "");
  return quotePath(path, shell, word.quote, true) + (!item.dir && trailingSpace ? " " : "");
}
