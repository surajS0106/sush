// The terminal in Cowork's side panel, drawn with the Terminal UI
// (`components/ui/Terminal.tsx`): each command after its `$` prompt, then what
// it printed, indented (stderr in red), and a prompt line to type at. The shell runs in Rust over plain pipes (`terminal.rs`); a marker
// after each command tells us it finished and where the shell now is.
//
// While a command runs, what you type goes to its input. Ctrl+C stops it (the
// shell restarts in the same folder), Ctrl+L clears, ↑/↓ walk the history.
// Tab completes file and folder names (Rust lists them, `lib/terminal-complete.ts`
// edits the line); when several fit it lists them, and Tab/Shift+Tab cycle.

import { EraserIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { TerminalFrame, TerminalHeaderButton, TerminalInput, TerminalPrompt } from "@/components/ui/Terminal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, type TerminalCompletion, type TerminalInfo, type Workspace } from "@/lib/tauri";
import { commonPrefix, completion, folderOf, quotePath, wordAt, type Word } from "@/lib/terminal-complete";
import { cn } from "@/lib/utils";
import { togglePanel } from "@/lib/workspaces";

type Entry =
  | { id: number; kind: "command"; cwd: string; text: string }
  | { id: number; kind: "out" | "err" | "input" | "info"; text: string };

/** The matches listed under the prompt after a Tab that couldn't pick one. */
interface Suggestions {
  items: TerminalCompletion[];
  word: Word;
  /** The one Tab/Shift+Tab put on the line, or -1 before cycling. */
  index: number;
  /** Where the inserted text ends; cycling replaces `word.start` up to here. */
  end: number;
}

/** Matches listed beyond this are only counted. */
const MAX_LISTED = 100;
/** Older output is dropped past this many characters. */
const MAX_CHARS = 400_000;
const CLEAR = new Set(["cls", "clear", "clear-host"]);
// Colour and cursor escapes; nothing here draws them.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

const clean = (text: string) => text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

let nextId = 0;

/** The user's own shell in the workspace folder (not sandboxed: it's them typing). */
export function TerminalPane({ workspace, className }: { workspace: Workspace; className?: string }) {
  const [term, setTerm] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  /** Where the shell waits for a command; null while one runs (or it's starting). */
  const [cwd, setCwd] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  /** The shell printed its first prompt. */
  const [started, setStarted] = useState(false);
  const [input, setInput] = useState("");
  const [suggest, setSuggest] = useState<Suggestions | null>(null);
  const latest = useRef("");
  latest.current = input;
  const history = useRef<string[]>([]);
  const historyAt = useRef(-1);
  const lastCwd = useRef(workspace.root);
  const body = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const stick = useRef(true);

  const append = (kind: Exclude<Entry["kind"], "command">, text: string) => {
    if (!text) return;
    setEntries((all) => {
      const last = all[all.length - 1];
      let next =
        last && last.kind === kind ? [...all.slice(0, -1), { ...last, text: last.text + text }] : [...all, { id: nextId++, kind, text }];
      let total = next.reduce((n, e) => n + e.text.length, 0);
      while (total > MAX_CHARS && next.length > 1) {
        total -= next[0].text.length;
        next = next.slice(1);
      }
      return next;
    });
  };

  useEffect(() => {
    let disposed = false;
    let id: string | null = null;
    setEntries([]);
    setCwd(null);
    setExited(false);
    setStarted(false);
    setError(null);
    api
      .terminalOpen(workspace.id, (event) => {
        if (disposed) return;
        if (event.kind === "output") append(event.error ? "err" : "out", clean(event.text));
        else if (event.kind === "prompt") {
          lastCwd.current = event.cwd;
          setCwd(event.cwd);
          setStarted(true);
        } else {
          append("info", "\nThe shell exited. Press Enter to start a new one.\n");
          setCwd(null);
          setExited(true);
        }
      })
      .then((info) => {
        id = info.id;
        if (disposed) void api.terminalClose(info.id);
        else setTerm(info);
      })
      .catch((e) => !disposed && setError(errorMessage(e)));
    return () => {
      disposed = true;
      setTerm(null);
      if (id) void api.terminalClose(id);
    };
  }, [workspace.id]);

  // Follow the output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, cwd]);

  useEffect(() => {
    if (term) field.current?.focus({ preventScroll: true });
  }, [term]);

  const cols = () => {
    const el = body.current;
    const char = measure.current?.getBoundingClientRect().width ?? 0;
    if (!el || !char) return 120;
    return Math.floor((el.clientWidth - 44) / (char / 10));
  };

  /** The folder's name before the prompt symbol (the full path is in the header). */
  const promptParts = (dir: string) => ({
    label: dir.split(/[\\/]/).filter(Boolean).pop() || dir,
    symbol: term?.shell === "powershell" ? "PS>" : "$",
  });
  const running = started && cwd === null && !exited;

  const restart = () => {
    if (!term) return;
    setCwd(null);
    setExited(false);
    void api.terminalInterrupt(term.id).catch((e) => append("err", `${errorMessage(e)}\n`));
  };

  const clear = () => setEntries([]);

  /** Put `text` on the line in place of `from`..`to`, with the caret after it. */
  const replace = (line: string, from: number, to: number, text: string) => {
    setInput(line.slice(0, from) + text + line.slice(to));
    historyAt.current = -1;
    const caret = from + text.length;
    requestAnimationFrame(() => field.current?.setSelectionRange(caret, caret));
    return caret;
  };

  /** Tab: finish the name if only one fits, else as far as they agree, else list them. */
  const complete = async (back: boolean) => {
    const el = field.current;
    if (!term || !cwd || !el) return;
    const shell = term.shell;
    if (suggest) {
      const n = suggest.items.length;
      const index = suggest.index === -1 ? (back ? n - 1 : 0) : (suggest.index + (back ? n - 1 : 1)) % n;
      const end = replace(input, suggest.word.start, suggest.end, completion(suggest.word, suggest.items[index], shell, false));
      setSuggest({ ...suggest, index, end });
      return;
    }
    const line = input;
    const caret = el.selectionStart ?? line.length;
    const word = wordAt(line, caret, shell);
    let items: TerminalCompletion[];
    try {
      items = await api.terminalComplete(term.id, word.text);
    } catch {
      return;
    }
    if (latest.current !== line || !items.length) return;
    if (items.length === 1) {
      replace(line, word.start, caret, completion(word, items[0], shell, true));
      return;
    }
    const shared = commonPrefix(items);
    const typed = word.text.slice(folderOf(word.text, shell).length);
    if (shared.length > typed.length) {
      // Typing "dow" with "Downloads" and "Downtime" there: the line gets "Down".
      replace(line, word.start, caret, quotePath(folderOf(word.text, shell) + shared, shell, word.quote, false));
      return;
    }
    stick.current = true;
    setSuggest({ items, word, index: -1, end: caret });
  };

  const submit = () => {
    if (!term || (!started && !exited)) return;
    const line = input;
    setInput("");
    setSuggest(null);
    historyAt.current = -1;
    stick.current = true;
    if (exited) {
      restart();
      return;
    }
    if (running) {
      append("input", line + "\n");
      void api.terminalWrite(term.id, line + "\n").catch(() => {});
      return;
    }
    const dir = cwd ?? lastCwd.current;
    if (line.trim()) {
      const h = history.current;
      if (h[h.length - 1] !== line) h.push(line);
    }
    if (CLEAR.has(line.trim().toLowerCase())) {
      clear();
      return;
    }
    setEntries((all) => [...all, { id: nextId++, kind: "command", cwd: dir, text: line }]);
    if (!line.trim()) return;
    setCwd(null);
    void api.terminalRun(term.id, line, cols()).catch((e) => {
      append("err", `${errorMessage(e)}\n`);
      setCwd(dir);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (ctrl && e.key.toLowerCase() === "c" && !window.getSelection()?.toString() && field.current?.selectionStart === field.current?.selectionEnd) {
      e.preventDefault();
      if (running) {
        append("input", "^C\n");
        restart();
      } else if (!exited && cwd) {
        setEntries((all) => [...all, { id: nextId++, kind: "command", cwd, text: input + "^C" }]);
        setInput("");
        setSuggest(null);
      }
    } else if (ctrl && e.key.toLowerCase() === "l") {
      e.preventDefault();
      clear();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !running) {
      const h = history.current;
      if (!h.length) return;
      e.preventDefault();
      let at = historyAt.current;
      if (e.key === "ArrowUp") at = at === -1 ? h.length - 1 : Math.max(0, at - 1);
      else at = at === -1 ? -1 : at + 1 >= h.length ? -1 : at + 1;
      historyAt.current = at;
      setInput(at === -1 ? "" : h[at]);
      setSuggest(null);
    } else if (e.key === "Tab") {
      e.preventDefault(); // completes, and never jumps out of the terminal
      if (!running && !e.altKey && !ctrl) void complete(e.shiftKey);
    } else if (e.key === "Escape" && suggest) {
      e.preventDefault();
      setSuggest(null);
    }
  };

  const action = (label: string, Icon: typeof XIcon, onClick: () => void, disabled = false) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <TerminalHeaderButton aria-label={label} onClick={onClick} disabled={disabled}>
          <Icon />
        </TerminalHeaderButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  // Output between two commands is one indented block, as in the Terminal UI.
  const blocks: ({ key: number; command: Extract<Entry, { kind: "command" }> } | { key: number; output: Entry[] })[] = [];
  for (const e of entries) {
    const last = blocks[blocks.length - 1];
    if (e.kind === "command") blocks.push({ key: e.id, command: e });
    else if (last && "output" in last) last.output.push(e);
    else blocks.push({ key: e.id, output: [e] });
  }

  return (
    <TerminalFrame
      className={className}
      meta={
        <span title={cwd ?? lastCwd.current}>
          {term?.shell ?? "shell"} · {running ? "Running…" : (cwd ?? lastCwd.current)}
        </span>
      }
      actions={
        <>
          {action("Stop (Ctrl+C)", SquareIcon, restart, !running)}
          {action("Clear (Ctrl+L)", EraserIcon, clear)}
          {action("Restart shell", RotateCwIcon, restart, !term)}
          {action("Close terminal", XIcon, () => togglePanel("terminal", false))}
        </>
      }
    >
      {error ? (
        <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : (
        <div
          ref={body}
          data-lenis-prevent
          className="relative min-h-0 flex-1 cursor-text overflow-y-auto overscroll-contain px-4 py-3 font-mono text-[13px] leading-relaxed"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          onMouseUp={() => {
            if (!window.getSelection()?.toString()) field.current?.focus({ preventScroll: true });
          }}
        >
          <span ref={measure} aria-hidden className="pointer-events-none invisible absolute whitespace-pre">
            MMMMMMMMMM
          </span>
          {blocks.map((b) =>
            "command" in b ? (
              <p key={b.key} className="mt-2 break-words whitespace-pre-wrap text-stone-800 first:mt-0 dark:text-stone-200">
                <TerminalPrompt {...promptParts(b.command.cwd)} />
                {b.command.text}
              </p>
            ) : (
              <pre key={b.key} className="m-0 pl-3 font-[inherit] break-words whitespace-pre-wrap">
                {b.output.map((e) => (
                  <span
                    key={e.id}
                    className={cn(
                      e.kind === "err" && "text-red-600 dark:text-red-400",
                      e.kind === "input" && "text-stone-800 dark:text-stone-200",
                      e.kind === "info" && "text-stone-400 italic dark:text-stone-500",
                      e.kind === "out" && "text-stone-500 dark:text-stone-400",
                    )}
                  >
                    {e.text}
                  </span>
                ))}
              </pre>
            ),
          )}
          {!term ? (
            <p className="mt-2 text-stone-400 first:mt-0 dark:text-stone-500">Starting…</p>
          ) : (
            <TerminalInput
              inputRef={field}
              className={cn(entries.length > 0 && cwd && "mt-2")}
              prompt={cwd ? <TerminalPrompt {...promptParts(cwd)} /> : running ? <span className="pl-3" /> : undefined}
              value={input}
              onValueChange={(v) => {
                setInput(v);
                setSuggest(null);
                historyAt.current = -1;
              }}
              onKeyDown={onKeyDown}
              aria-label={running ? "Input for the running command" : "Command"}
              placeholder={exited ? "Press Enter to restart" : !started ? "Starting…" : undefined}
            />
          )}
          {suggest && (
            <div
              aria-live="polite"
              aria-label={`${suggest.items.length} matches. Tab to cycle, Escape to close.`}
              className="mt-1 flex flex-wrap gap-x-5 pl-3"
            >
              {suggest.items.slice(0, MAX_LISTED).map((item, i) => (
                <button
                  key={item.name}
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    replace(input, suggest.word.start, suggest.end, completion(suggest.word, item, term!.shell, true));
                    setSuggest(null);
                  }}
                  className={cn(
                    "-mx-1 rounded px-1 text-left whitespace-pre",
                    item.dir ? "text-brand" : "text-stone-500 dark:text-stone-400",
                    i === suggest.index ? "bg-brand/15" : "hover:bg-stone-100 dark:hover:bg-white/5",
                  )}
                >
                  {item.name}
                  {item.dir && "/"}
                </button>
              ))}
              {suggest.items.length > MAX_LISTED && (
                <span className="text-stone-400 italic dark:text-stone-500">and {suggest.items.length - MAX_LISTED} more</span>
              )}
            </div>
          )}
        </div>
      )}
    </TerminalFrame>
  );
}
