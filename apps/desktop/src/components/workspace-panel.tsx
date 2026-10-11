// Cowork chrome around a session, laid out like an editor:
//
//   header   the folder chip (what Sush may do there, the sandbox) and the
//            Files / Terminal toggles
//   panel    beside the chat: the file tree and a tabbed, highlighted file
//            viewer on top, the user's own terminal below
//
// Settings changes apply from the next tool call, including in a run that's
// waiting for approval.

import "@xterm/xterm/css/xterm.css";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, type FileView, type Workspace, type WorkspaceEntry } from "@/lib/tauri";
import { PANEL, setLayout, useLayout } from "@/lib/layout";
import { cn } from "@/lib/utils";
import {
  closeFile,
  openFile,
  removeWorkspace,
  selectFile,
  togglePanel,
  updateWorkspace,
  useFilesVersion,
  useOpenFiles,
  usePanels,
  useSandboxStatus,
  useWorkspace,
} from "@/lib/workspaces";

// --- header -------------------------------------------------------------------------------

type Mode = "read-only" | "ask" | "auto-edits";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "read-only", label: "Read only", hint: "Read and search; no changes, no commands" },
  { value: "ask", label: "Ask before changes", hint: "Every edit and command needs your OK" },
  { value: "auto-edits", label: "Edit automatically", hint: "Edits and sandboxed commands run; you can undo a turn" },
];

const modeOf = (w: Workspace): Mode => (w.access === "read-only" ? "read-only" : w.approval);

/** The folder a Cowork session works in, with what Sush may do there. */
export function WorkspaceChip({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const sandbox = useSandboxStatus();
  if (!workspace) {
    return (
      <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground" title="This session's folder was removed from Cowork">
        Folder removed
      </span>
    );
  }
  const setMode = (mode: Mode) => {
    const [access, approval] = mode === "read-only" ? (["read-only", workspace.approval] as const) : (["workspace-write", mode] as const);
    void updateWorkspace(workspace.id, access, approval).catch((e) => toast.error(errorMessage(e)));
  };
  const remove = () => {
    if (!window.confirm(`Remove ${workspace.name} from Cowork? Its sessions stay, but Sush won't be able to use its files.`)) return;
    void removeWorkspace(workspace.id).catch((e) => toast.error(errorMessage(e)));
  };
  const mode = MODES.find((m) => m.value === modeOf(workspace))!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex max-w-64 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          title={workspace.root}
        >
          <FolderOpenIcon className="size-3.5 shrink-0" />
          <span className="truncate">{workspace.name}</span>
          <span className="shrink-0 opacity-70">· {mode.label}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{workspace.root}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode.value} onValueChange={(v) => setMode(v as Mode)}>
          {MODES.map((m) => (
            <DropdownMenuRadioItem key={m.value} value={m.value} className="flex-col items-start gap-0">
              <span>{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.hint}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <div className="flex gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          {sandbox?.available ? (
            <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-green-600 dark:text-green-400" />
          ) : (
            <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <span>
            {sandbox ? (
              <>
                <span className="font-medium text-foreground">
                  {sandbox.available ? `Sandboxed (${sandbox.mechanism})` : "No sandbox"}
                </span>
                {" · "}
                {sandbox.detail}
              </>
            ) : (
              "Checking the sandbox…"
            )}
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={remove}>
          <Trash2Icon /> Remove from Cowork
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Header buttons that show or hide the terminal and the files. */
export function PanelToggles() {
  const panels = usePanels();
  const toggle = (which: "terminal" | "files", label: string, Icon: typeof FileIcon) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", panels[which] && "bg-accent text-accent-foreground")}
          aria-pressed={panels[which]}
          aria-label={label}
          onClick={() => togglePanel(which)}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <div className="flex items-center gap-0.5">
      {toggle("terminal", "Terminal", SquareTerminalIcon)}
      {toggle("files", "Files", FolderTreeIcon)}
    </div>
  );
}

// --- side panel -----------------------------------------------------------------------------

interface CoworkPanelProps {
  workspace: Workspace;
  /** Paths this session changed, highlighted in the tree. */
  changed: ReadonlySet<string>;
}

/**
 * Files on top, terminal below; whichever is open fills the height. Its left
 * edge drags to resize; until then it takes about half the window. CSS keeps
 * the chat at least `PANEL.chatMin` wide when the window shrinks.
 */
export function CoworkPanel({ workspace, changed }: CoworkPanelProps) {
  const panels = usePanels();
  const { panel: width } = useLayout();
  const ref = useRef<HTMLElement>(null);
  if (!panels.files && !panels.terminal) return null;
  return (
    <aside
      ref={ref}
      className={cn(
        "relative flex max-w-[calc(100%-360px)] min-w-[320px] shrink-0 flex-col gap-2 p-2 pl-0",
        width === null && "w-[52%] max-w-[min(960px,calc(100%-360px))]",
      )}
      style={width === null ? undefined : { width }}
    >
      <ResizeHandle
        label="Resize side panel"
        edge="left"
        min={PANEL.min}
        max={() => Math.min(PANEL.max, (ref.current?.parentElement?.clientWidth ?? Infinity) - PANEL.chatMin)}
        measure={() => ref.current?.offsetWidth ?? PANEL.min}
        onResize={(panel) => setLayout({ panel })}
        onReset={() => setLayout({ panel: null })}
      />
      {panels.files && <FilesPane workspace={workspace} changed={changed} />}
      {panels.terminal && <TerminalPane workspace={workspace} fill={!panels.files} />}
    </aside>
  );
}

function Pane({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background", className)}>{children}</section>;
}

function FilesPane({ workspace, changed }: CoworkPanelProps) {
  const { tabs, active } = useOpenFiles(workspace.id);
  const [filter, setFilter] = useState("");
  return (
    <Pane className="flex-1">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.length === 0 && <span className="px-2 text-sm text-muted-foreground">No file open</span>}
          {tabs.map((path) => (
            <div
              key={path}
              className={cn(
                "group flex h-7 max-w-52 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-sm",
                path === active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <button type="button" className="truncate" title={path} onClick={() => selectFile(workspace.id, path)}>
                {path.split("/").pop()}
              </button>
              <button
                type="button"
                aria-label={`Close ${path}`}
                className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                onClick={() => closeFile(workspace.id, path)}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close files" onClick={() => togglePanel("files", false)}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 shrink-0 flex-col border-r">
          <div className="relative p-1.5">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setFilter("")}
              placeholder="Filter files"
              aria-label="Filter files"
              className="h-7 w-full rounded-md border bg-transparent pr-2 pl-7 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm">
            {filter.trim() ? (
              <FilterResults workspaceId={workspace.id} query={filter} active={active} />
            ) : (
              <TreeFolder workspaceId={workspace.id} path="" depth={0} changed={changed} active={active} />
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {active ? (
            <CodeView workspaceId={workspace.id} path={active} />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Pick a file to view it.</p>
          )}
        </div>
      </div>
    </Pane>
  );
}

function FilterResults({ workspaceId, query, active }: { workspaceId: string; query: string; active: string | null }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    // Wait for typing to pause; the search walks the folder.
    const timer = setTimeout(() => {
      api
        .workspaceFind(workspaceId, query)
        .then((p) => live && setPaths(p))
        .catch(() => live && setPaths([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, query]);
  if (!paths) return <p className="px-2 py-1 text-xs text-muted-foreground">Searching…</p>;
  if (paths.length === 0) return <p className="px-2 py-1 text-xs text-muted-foreground">No files match.</p>;
  return (
    <ul>
      {paths.map((p) => (
        <li key={p}>
          <button
            type="button"
            title={p}
            onClick={() => openFile(workspaceId, p)}
            className={cn("flex w-full flex-col rounded-md px-2 py-0.5 text-left hover:bg-muted", p === active && "bg-muted")}
          >
            <span className="truncate">{p.split("/").pop()}</span>
            <span className="truncate text-xs text-muted-foreground">{p}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface TreeProps {
  workspaceId: string;
  changed: ReadonlySet<string>;
  active: string | null;
}

/** One folder's entries, loaded when it's shown and again when files change. */
function TreeFolder({ workspaceId, path, depth, changed, active }: TreeProps & { path: string; depth: number }) {
  const version = useFilesVersion(workspaceId);
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .workspaceTree(workspaceId, path)
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, path, version]);

  const indent = (extra: number) => ({ paddingLeft: `${depth * 12 + extra}px` });
  if (error) return <p className="px-2 py-1 text-xs text-destructive">{error}</p>;
  if (!entries) return <p className="py-1 text-xs text-muted-foreground" style={indent(6)}>Loading…</p>;
  if (entries.length === 0 && depth === 0) return <p className="px-2 py-1 text-xs text-muted-foreground">Empty folder</p>;
  return (
    <ul>
      {entries.map((e) =>
        e.dir ? (
          <TreeDir key={e.path} workspaceId={workspaceId} entry={e} depth={depth} changed={changed} active={active} />
        ) : (
          <li key={e.path}>
            <button
              type="button"
              title={e.path}
              onClick={() => openFile(workspaceId, e.path)}
              className={cn(
                "flex w-full items-center gap-1.5 truncate rounded-md py-0.5 pr-2 text-left hover:bg-muted",
                e.path === active && "bg-muted text-foreground",
                changed.has(e.path) && "font-medium text-amber-700 dark:text-amber-400",
              )}
              style={indent(22)}
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function TreeDir({ entry, depth, ...rest }: TreeProps & { entry: WorkspaceEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 truncate rounded-md py-0.5 pr-2 text-left hover:bg-muted"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        title={entry.path}
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{entry.name}</span>
      </button>
      {open && <TreeFolder path={entry.path} depth={depth + 1} {...rest} />}
    </li>
  );
}

// --- file viewer -----------------------------------------------------------------------------

/** Shiki language ids by file extension (or whole file name). */
const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json",
  md: "markdown", rs: "rust", py: "python", go: "go", tf: "terraform", tfvars: "terraform", hcl: "hcl",
  yml: "yaml", yaml: "yaml", toml: "toml", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ps1: "powershell", psm1: "powershell", sql: "sql",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby",
  php: "php", lua: "lua", xml: "xml", graphql: "graphql", dockerfile: "dockerfile", makefile: "makefile",
};

/** Bigger files are shown without highlighting; it gets slow. */
const HIGHLIGHT_LIMIT = 200_000;

function langFor(path: string) {
  const name = path.split("/").pop()!.toLowerCase();
  return LANGS[name] ?? LANGS[name.split(".").pop() ?? ""] ?? "text";
}

function CodeView({ workspaceId, path }: { workspaceId: string; path: string }) {
  const version = useFilesVersion(workspaceId);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .workspaceReadFile(workspaceId, path)
      .then((f) => live && setFile(f))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, path, version]);

  useEffect(() => {
    setHtml(null);
    const text = file?.text;
    if (text == null || text.length > HIGHLIGHT_LIMIT) return;
    let live = true;
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(text, { lang: langFor(file!.path), themes: { light: "github-light", dark: "github-dark" }, defaultColor: "light" }),
      )
      .then((h) => live && setHtml(h))
      .catch(() => {}); // unknown language: the plain view stays
    return () => {
      live = false;
    };
  }, [file]);

  const plain = useMemo(() => file?.text?.split("\n") ?? [], [file]);
  const crumbs = path.split("/");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 truncate border-b px-3 text-xs text-muted-foreground">
        {crumbs.map((c, i) => (
          <span key={i} className={cn("truncate", i === crumbs.length - 1 && "text-foreground")}>
            {i > 0 && <span className="mx-1 opacity-60">/</span>}
            {c}
          </span>
        ))}
      </div>
      <div className="code-view min-h-0 flex-1 overflow-auto text-[12.5px] leading-[1.55]">
        {error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : !file ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : file.text == null ? (
          <p className="p-4 text-sm text-muted-foreground">Binary file ({file.size.toLocaleString()} bytes).</p>
        ) : html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="shiki">
            <code>
              {plain.map((line, i) => (
                <span key={i} className="line">
                  {line}
                  {"\n"}
                </span>
              ))}
            </code>
          </pre>
        )}
        {file?.truncated && <p className="px-4 pb-3 text-xs text-muted-foreground">Only the first 1 MB is shown.</p>}
      </div>
    </div>
  );
}

// --- terminal --------------------------------------------------------------------------------

/** The user's own shell in the workspace folder (not sandboxed: it's them typing). */
function TerminalPane({ workspace, fill }: { workspace: Workspace; fill: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let id: string | null = null;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      const dark = document.documentElement.classList.contains("dark");
      const term = new Terminal({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12.5,
        cursorBlink: true,
        allowTransparency: true,
        theme: dark
          ? { background: "#00000000", foreground: "#e6edf3", cursor: "#e6edf3", selectionBackground: "#3b82f655" }
          : { background: "#00000000", foreground: "#1f2328", cursor: "#1f2328", selectionBackground: "#3b82f633" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      try {
        id = await api.terminalOpen(workspace.id, term.cols, term.rows, (data) => term.write(data));
      } catch (e) {
        setError(errorMessage(e));
        term.dispose();
        return;
      }
      if (disposed) {
        void api.terminalClose(id);
        term.dispose();
        return;
      }
      const terminalId = id;
      const input = term.onData((data) => void api.terminalWrite(terminalId, data).catch(() => {}));
      const resize = new ResizeObserver(() => {
        fit.fit();
        void api.terminalResize(terminalId, term.cols, term.rows).catch(() => {});
      });
      resize.observe(el);
      term.focus();
      cleanup = () => {
        resize.disconnect();
        input.dispose();
        term.dispose();
        void api.terminalClose(terminalId);
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [workspace.id]);

  return (
    <Pane className={fill ? "flex-1" : "h-[38%] min-h-48 shrink-0"}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <SquareTerminalIcon className="size-4 text-muted-foreground" />
        <span>Terminal</span>
        <span className="truncate text-xs text-muted-foreground">{workspace.root}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="Close terminal" onClick={() => togglePanel("terminal", false)}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {error ? <p className="p-3 text-sm text-destructive">{error}</p> : <div ref={host} className="min-h-0 flex-1 px-2 py-1" />}
    </Pane>
  );
}
