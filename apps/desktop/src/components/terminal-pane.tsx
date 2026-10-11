// The terminal in Cowork's side panel, drawn like VS Code's: each command
// after its prompt, then what it printed (stderr in red), and a prompt line to
// type at. The shell runs in Rust over plain pipes (`terminal.rs`); a marker
// after each command tells us it finished and where the shell now is.
//
// While a command runs, what you type goes to its input. Ctrl+C stops it (the
// shell restarts in the same folder), Ctrl+L clears, ↑/↓ walk the history.

import { EraserIcon, RotateCwIcon, SquareIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, type TerminalInfo, type Workspace } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { togglePanel } from "@/lib/workspaces";

type Entry =
  | { id: number; kind: "command"; cwd: string; text: string }
  | { id: number; kind: "out" | "err" | "input" | "info"; text: string };

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
    return Math.floor((el.clientWidth - 24) / (char / 10));
  };

  const prompt = (dir: string) => (term?.shell === "powershell" ? `PS ${dir}> ` : `${dir} $ `);
  const running = started && cwd === null && !exited;

  const restart = () => {
    if (!term) return;
    setCwd(null);
    setExited(false);
    void api.terminalInterrupt(term.id).catch((e) => append("err", `${errorMessage(e)}\n`));
  };

  const clear = () => setEntries([]);

  const submit = () => {
    if (!term || (!started && !exited)) return;
    const line = input;
    setInput("");
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
    } else if (e.key === "Tab") {
      e.preventDefault(); // no completion yet, but don't jump out of the terminal
    }
  };

  const action = (label: string, Icon: typeof XIcon, onClick: () => void, disabled = false) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={label} onClick={onClick} disabled={disabled}>
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <span className="text-[11px] font-medium tracking-wider text-foreground uppercase">Terminal</span>
        <span className="flex min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          <SquareTerminalIcon className="size-3 shrink-0" />
          {term?.shell ?? "shell"}
        </span>
        <span className="truncate text-xs text-muted-foreground" title={cwd ?? lastCwd.current}>
          {running ? "Running…" : (cwd ?? lastCwd.current)}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          {action("Stop (Ctrl+C)", SquareIcon, restart, !running)}
          {action("Clear (Ctrl+L)", EraserIcon, clear)}
          {action("Restart shell", RotateCwIcon, restart, !term)}
          {action("Close terminal", XIcon, () => togglePanel("terminal", false))}
        </div>
      </div>
      {error ? (
        <p className="p-3 text-sm text-destructive">{error}</p>
      ) : (
        <div
          ref={body}
          className="relative min-h-0 flex-1 cursor-text overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-[1.5]"
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
          <pre className="m-0 font-[inherit] break-words whitespace-pre-wrap">
            {entries.map((e) =>
              e.kind === "command" ? (
                <div key={e.id}>
                  <span className="text-sky-700 dark:text-sky-400">{prompt(e.cwd)}</span>
                  <span className="font-medium text-foreground">{e.text}</span>
                </div>
              ) : (
                <span
                  key={e.id}
                  className={cn(
                    e.kind === "err" && "text-red-600 dark:text-red-400",
                    e.kind === "input" && "text-foreground",
                    e.kind === "info" && "text-muted-foreground italic",
                    e.kind === "out" && "text-foreground/90",
                  )}
                >
                  {e.text}
                </span>
              ),
            )}
          </pre>
          <div className="flex items-baseline">
            {!term ? (
              <span className="text-muted-foreground">Starting…</span>
            ) : (
              <>
                {cwd && <span className="shrink-0 whitespace-pre text-sky-700 dark:text-sky-400">{prompt(cwd)}</span>}
                <input
                  ref={field}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    historyAt.current = -1;
                  }}
                  onKeyDown={onKeyDown}
                  aria-label={running ? "Input for the running command" : "Command"}
                  placeholder={exited ? "Press Enter to restart" : !started ? "Starting…" : undefined}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 font-[inherit] text-foreground caret-foreground outline-none placeholder:text-muted-foreground"
                />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
