// Cowork chrome around a session, laid out like an editor:
//
//   header   the folder chip (what Sush may do there, the sandbox) and the
//            Browser / Terminal / Files toggles
//   panel    beside the chat: the file tree and a tabbed, editable file
//            viewer (`code-editor.tsx`) on top, the built-in browser, and the
//            user's own terminal (`terminal-pane.tsx`) below a draggable split
//
// Settings changes apply from the next tool call, including in a run that's
// waiting for approval.

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  CircleIcon,
  CopyIcon,
  FileArchiveIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileCogIcon,
  FileIcon,
  FileImageIcon,
  FileLockIcon,
  FileTerminalIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GlobeIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { CodeEditor } from "@/components/code-editor";
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { useBrowserPage } from "@/lib/browser";
import { api, errorMessage, type Workspace, type WorkspaceEntry } from "@/lib/tauri";
import { PANEL, setLayout, useLayout } from "@/lib/layout";
import { createStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  closeFile,
  notifyWorkspaceChanged,
  openFile,
  removeWorkspace,
  selectFile,
  togglePanel,
  updateWorkspace,
  type PanelState,
  useFilesVersion,
  useOpenFiles,
  usePanels,
  useSandboxStatus,
  useUnsaved,
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

/** Header buttons that show or hide the browser, the terminal and the files. */
export function PanelToggles() {
  const panels = usePanels();
  const toggle = (which: keyof PanelState, label: string, Icon: typeof FileIcon) => (
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
      {toggle("browser", "Browser", GlobeIcon)}
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

/** The terminal's height under the files or browser; null for the default share. */
const terminalHeight = createStore<number | null>("sush.terminal-height", null);
const TERMINAL_MIN = 120;
/** What the files or browser keep when the terminal is dragged up. */
const ABOVE_MIN = 160;

/**
 * Files on top, then the browser, terminal below; files and browser share the
 * height, and the terminal's top edge drags. The panel's left edge drags to
 * resize; until then it takes about half the window. CSS keeps the chat at
 * least `PANEL.chatMin` wide when the window shrinks.
 */
export function CoworkPanel({ workspace, changed }: CoworkPanelProps) {
  const panels = usePanels();
  const { panel: width } = useLayout();
  const termHeight = useSyncExternalStore(terminalHeight.subscribe, terminalHeight.get);
  const ref = useRef<HTMLElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  if (!panels.files && !panels.terminal && !panels.browser) return null;
  const split = panels.terminal && (panels.files || panels.browser);

  const dragSplit = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = termRef.current?.offsetHeight ?? 240;
    const max = (ref.current?.clientHeight ?? 800) - ABOVE_MIN;
    document.documentElement.dataset.resizing = "";
    const move = (ev: PointerEvent) =>
      terminalHeight.set(Math.round(Math.min(max, Math.max(TERMINAL_MIN, start - (ev.clientY - startY)))));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      delete document.documentElement.dataset.resizing;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

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
        preview={(w) => {
          if (!ref.current) return;
          ref.current.style.width = `${w}px`;
          // Drop the default's percentage width and cap so the inline width shows.
          ref.current.classList.remove("w-[52%]", "max-w-[min(960px,calc(100%-360px))]");
        }}
        onResize={(panel) => setLayout({ panel })}
        onReset={() => setLayout({ panel: null })}
      />
      {panels.files && <FilesPane workspace={workspace} changed={changed} />}
      {panels.browser && <BrowserPane />}
      {split && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          title="Drag to resize; double-click to reset"
          onPointerDown={dragSplit}
          onDoubleClick={() => terminalHeight.set(null)}
          className="group relative -my-2 h-2 shrink-0 cursor-row-resize"
        >
          <span className="absolute inset-x-[40%] top-1/2 h-1 -translate-y-1/2 rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      )}
      {panels.terminal && (
        <div
          ref={termRef}
          className={cn("flex min-h-0 flex-col", !split ? "flex-1" : termHeight === null ? "h-[38%] min-h-32 shrink-0" : "shrink-0")}
          style={split && termHeight !== null ? { height: termHeight } : undefined}
        >
          <TerminalPane workspace={workspace} className="flex-1" />
        </div>
      )}
    </aside>
  );
}

function Pane({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background", className)}>{children}</section>;
}

// --- files -----------------------------------------------------------------------------------

type IconSpec = readonly [typeof FileIcon, string];

const CODE = (color: string): IconSpec => [FileCodeIcon, color];
const SHELL: IconSpec = [FileTerminalIcon, "text-green-600 dark:text-green-500"];
const CONFIG: IconSpec = [FileCogIcon, "text-rose-500/80"];
const IMAGE: IconSpec = [FileImageIcon, "text-fuchsia-500"];
const ARCHIVE: IconSpec = [FileArchiveIcon, "text-stone-500"];
const SECRET: IconSpec = [FileLockIcon, "text-amber-600"];

/** Icon and colour by extension, roughly as editors draw them. */
const ICONS: Record<string, IconSpec> = {
  ts: CODE("text-blue-500"), tsx: CODE("text-blue-500"), js: CODE("text-yellow-500"), jsx: CODE("text-yellow-500"),
  mjs: CODE("text-yellow-500"), cjs: CODE("text-yellow-500"), rs: CODE("text-orange-600"), py: CODE("text-emerald-500"),
  go: CODE("text-cyan-500"), tf: CODE("text-violet-500"), hcl: CODE("text-violet-500"), tfvars: [FileCogIcon, "text-violet-500"],
  html: CODE("text-orange-500"), css: CODE("text-sky-500"), scss: CODE("text-pink-500"), vue: CODE("text-emerald-500"),
  svelte: CODE("text-orange-500"), java: CODE("text-red-500"), kt: CODE("text-violet-500"), swift: CODE("text-orange-500"),
  c: CODE("text-blue-600"), h: CODE("text-blue-600"), cpp: CODE("text-blue-600"), hpp: CODE("text-blue-600"),
  cs: CODE("text-purple-500"), rb: CODE("text-red-500"), php: CODE("text-indigo-400"), lua: CODE("text-blue-400"),
  sql: CODE("text-amber-600"), graphql: CODE("text-pink-500"), xml: CODE("text-orange-400"),
  json: [FileBracesIcon, "text-amber-500"], md: [FileTextIcon, "text-sky-500"], mdx: [FileTextIcon, "text-sky-500"],
  txt: [FileTextIcon, "text-muted-foreground"], yml: CONFIG, yaml: CONFIG, toml: CONFIG, ini: CONFIG, cfg: CONFIG, conf: CONFIG,
  sh: SHELL, bash: SHELL, zsh: SHELL, ps1: SHELL, psm1: SHELL, bat: SHELL, cmd: SHELL,
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, svg: IMAGE, webp: IMAGE, ico: IMAGE, bmp: IMAGE,
  zip: ARCHIVE, tar: ARCHIVE, gz: ARCHIVE, tgz: ARCHIVE, "7z": ARCHIVE, rar: ARCHIVE,
  lock: [FileLockIcon, "text-muted-foreground"], pem: SECRET, key: SECRET, crt: SECRET,
};

function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const n = name.toLowerCase();
  const [Icon, color] = n.startsWith(".env") ? SECRET : (ICONS[n.split(".").pop() ?? ""] ?? [FileIcon, "text-muted-foreground"]);
  return <Icon className={cn("size-3.5 shrink-0", color, className)} />;
}

const REVEAL = /Mac/i.test(navigator.userAgent)
  ? "Reveal in Finder"
  : /Windows/i.test(navigator.userAgent)
    ? "Reveal in File Explorer"
    : "Open containing folder";

function absolutePath(workspace: Workspace, rel: string) {
  const sep = workspace.root.includes("\\") ? "\\" : "/";
  return rel ? `${workspace.root.replace(/[\\/]+$/, "")}${sep}${rel.split("/").join(sep)}` : workspace.root;
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error("Couldn't copy to the clipboard"),
  );
}

const reveal = (workspace: Workspace, path: string) =>
  void api.workspaceReveal(workspace.id, path).catch((e) => toast.error(errorMessage(e)));

/** Right-click actions for a file or folder in the tree. */
function EntryMenu({ workspace, path, dir, children }: { workspace: Workspace; path: string; dir: boolean; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        {!dir && (
          <ContextMenuItem onSelect={() => openFile(workspace.id, path)}>
            <FileIcon /> Open
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => copy(path, "relative path")}>
          <CopyIcon /> Copy relative path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(absolutePath(workspace, path), "path")}>
          <CopyIcon /> Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => reveal(workspace, path)}>
          <FolderOpenIcon /> {REVEAL}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FilesPane({ workspace, changed }: CoworkPanelProps) {
  const { tabs, active } = useOpenFiles(workspace.id);
  const unsaved = useUnsaved(workspace.id);
  const [filter, setFilter] = useState("");
  // Remounting the tree closes every folder.
  const [treeKey, setTreeKey] = useState(0);
  const names = tabs.map((p) => p.split("/").pop()!);

  const closeOthers = (keep: string | null) => {
    for (const t of tabs) if (t !== keep && !closeFile(workspace.id, t)) return;
  };

  // Up/Down/Home/End move between rows; folders open with Right and close with Left.
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]")];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    rows[next].focus();
  };

  return (
    <Pane className="flex-1">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-1.5">
        <div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.length === 0 && <span className="px-2 text-sm text-muted-foreground">No file open</span>}
          {tabs.map((path, i) => {
            const isActive = path === active;
            const dirty = unsaved(path);
            const parent = names.filter((n) => n === names[i]).length > 1 ? path.split("/").slice(-2, -1)[0] : undefined;
            return (
              <ContextMenu key={path}>
                <ContextMenuTrigger asChild>
                  <div
                    role="tab"
                    aria-selected={isActive}
                    title={path}
                    onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                    onAuxClick={(e) => e.button === 1 && closeFile(workspace.id, path)}
                    className={cn(
                      "group flex h-7 max-w-56 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-sm transition-colors",
                      isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <button type="button" className="flex min-w-0 items-center gap-1.5" onClick={() => selectFile(workspace.id, path)}>
                      <FileTypeIcon name={names[i]} />
                      <span className={cn("truncate", changed.has(path) && "text-amber-700 dark:text-amber-400")}>{names[i]}</span>
                      {parent && <span className="truncate text-xs text-muted-foreground">{parent}</span>}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${path}`}
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded hover:bg-background",
                        !isActive && !dirty && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                      )}
                      onClick={() => closeFile(workspace.id, path)}
                    >
                      {dirty ? (
                        <>
                          <CircleIcon className="size-2 fill-current group-hover:hidden" aria-label="Unsaved" />
                          <XIcon className="hidden size-3 group-hover:block" />
                        </>
                      ) : (
                        <XIcon className="size-3" />
                      )}
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuItem onSelect={() => closeFile(workspace.id, path)}>Close</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeOthers(path)} disabled={tabs.length < 2}>
                    Close others
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeOthers(null)}>Close all</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => copy(path, "relative path")}>
                    <CopyIcon /> Copy relative path
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => reveal(workspace, path)}>
                    <FolderOpenIcon /> {REVEAL}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close files" onClick={() => togglePanel("files", false)}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 shrink-0 flex-col border-r">
          <div className="flex items-center gap-0.5 p-1.5">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setFilter("")}
                placeholder="Filter files"
                aria-label="Filter files"
                className="h-7 w-full rounded-md border bg-transparent pr-2 pl-7 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" onClick={() => notifyWorkspaceChanged(workspace.id)}>
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Collapse folders" onClick={() => setTreeKey((k) => k + 1)}>
                  <ChevronsDownUpIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse folders</TooltipContent>
            </Tooltip>
          </div>
          <div role="tree" aria-label="Files" onKeyDown={onTreeKey} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm">
            {filter.trim() ? (
              <FilterResults workspace={workspace} query={filter} active={active} />
            ) : (
              <TreeFolder key={treeKey} workspace={workspace} path="" depth={0} changed={changed} active={active} />
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {active ? (
            <CodeEditor key={active} workspaceId={workspace.id} path={active} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileCodeIcon className="size-7 text-muted-foreground" />
              <p className="text-sm font-medium">No file open</p>
              <p className="max-w-60 text-xs text-muted-foreground">Pick a file to view and edit it. Ctrl+S saves; right-click for more.</p>
            </div>
          )}
        </div>
      </div>
    </Pane>
  );
}

function FilterResults({ workspace, query, active }: { workspace: Workspace; query: string; active: string | null }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    // Wait for typing to pause; the search walks the folder.
    const timer = setTimeout(() => {
      api
        .workspaceFind(workspace.id, query)
        .then((p) => live && setPaths(p))
        .catch(() => live && setPaths([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspace.id, query]);
  if (!paths) return <p className="px-2 py-1 text-xs text-muted-foreground">Searching…</p>;
  if (paths.length === 0) return <p className="px-2 py-1 text-xs text-muted-foreground">No files match.</p>;
  return (
    <ul>
      {paths.map((p) => (
        <li key={p}>
          <EntryMenu workspace={workspace} path={p} dir={false}>
            <button
              type="button"
              data-tree-row
              title={p}
              onClick={() => openFile(workspace.id, p)}
              className={cn(
                "flex w-full items-start gap-1.5 rounded-md px-2 py-0.5 text-left outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring",
                p === active && "bg-muted",
              )}
            >
              <FileTypeIcon name={p.split("/").pop()!} className="mt-[3px]" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{p.split("/").pop()}</span>
                <span className="truncate text-xs text-muted-foreground">{p}</span>
              </span>
            </button>
          </EntryMenu>
        </li>
      ))}
    </ul>
  );
}

interface TreeProps {
  workspace: Workspace;
  changed: ReadonlySet<string>;
  active: string | null;
}

const ROW = "flex w-full items-center rounded-md py-[3px] pr-2 text-left outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring";

/** One folder's entries, loaded when it's shown and again when files change. */
function TreeFolder({ workspace, path, depth, changed, active }: TreeProps & { path: string; depth: number }) {
  const version = useFilesVersion(workspace.id);
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .workspaceTree(workspace.id, path)
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspace.id, path, version]);

  const indent = (extra: number) => ({ paddingLeft: `${depth * 12 + extra}px` });
  if (error) return <p className="px-2 py-1 text-xs text-destructive">{error}</p>;
  if (!entries) return <p className="py-1 text-xs text-muted-foreground" style={indent(6)}>Loading…</p>;
  if (entries.length === 0) {
    return depth === 0 ? (
      <p className="px-2 py-1 text-xs text-muted-foreground">Empty folder</p>
    ) : (
      <p className="py-0.5 text-xs text-muted-foreground italic" style={indent(22)}>Empty</p>
    );
  }
  return (
    <ul role={depth ? "group" : undefined} className="relative">
      {depth > 0 && (
        // Indent guide under the parent folder's chevron.
        <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: `${(depth - 1) * 12 + 12.5}px` }} />
      )}
      {entries.map((e) =>
        e.dir ? (
          <TreeDir key={e.path} workspace={workspace} entry={e} depth={depth} changed={changed} active={active} />
        ) : (
          <li key={e.path} role="treeitem" aria-selected={e.path === active}>
            <EntryMenu workspace={workspace} path={e.path} dir={false}>
              <button
                type="button"
                data-tree-row
                title={e.path}
                onClick={() => openFile(workspace.id, e.path)}
                className={cn(
                  ROW,
                  "gap-1.5",
                  e.path === active && "bg-accent text-accent-foreground",
                  changed.has(e.path) && "text-amber-700 dark:text-amber-400",
                )}
                style={indent(22)}
              >
                <FileTypeIcon name={e.name} />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {changed.has(e.path) && (
                  <span className="shrink-0 text-[10px] font-semibold" title="Changed in this session">
                    M
                  </span>
                )}
              </button>
            </EntryMenu>
          </li>
        ),
      )}
    </ul>
  );
}

function TreeDir({ entry, depth, ...rest }: TreeProps & { entry: WorkspaceEntry; depth: number }) {
  const prefix = entry.path + "/";
  const [open, setOpen] = useState(() => !!rest.active?.startsWith(prefix));
  // Opening a file (from the chat, say) reveals it in the tree.
  useEffect(() => {
    if (rest.active?.startsWith(prefix)) setOpen(true);
  }, [rest.active, prefix]);
  const hasChanges = [...rest.changed].some((p) => p.startsWith(prefix));
  const Icon = open ? FolderOpenIcon : FolderIcon;
  return (
    <li role="treeitem" aria-expanded={open}>
      <EntryMenu workspace={rest.workspace} path={entry.path} dir>
        <button
          type="button"
          data-tree-row
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" && !open) setOpen(true);
            else if (e.key === "ArrowLeft" && open) setOpen(false);
          }}
          className={cn(ROW, "gap-1")}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          title={entry.path}
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Icon className="size-3.5 shrink-0 text-sky-600/80 dark:text-sky-400/80" />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {hasChanges && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Has changes from this session" />}
        </button>
      </EntryMenu>
      {open && <TreeFolder path={entry.path} depth={depth + 1} {...rest} />}
    </li>
  );
}

// --- browser ---------------------------------------------------------------------------------

/** Menus and dialogs, which the native browser would cover. */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

function overlayCovers(r: DOMRect) {
  return [...document.querySelectorAll(OVERLAYS)].some((el) => {
    const o = el.getBoundingClientRect();
    return o.width > 0 && o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top;
  });
}

/**
 * The address bar, and the place the browser sits. The page itself is a native
 * webview Rust lays over `host`; it's drawn above everything in this window, so
 * it steps aside while a menu or dialog overlaps it.
 */
function BrowserPane() {
  const page = useBrowserPage();
  const host = useRef<HTMLDivElement>(null);
  const shown = page?.url && page.url !== "about:blank" ? page.url : "";
  const [address, setAddress] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setAddress(shown);
  }, [shown, editing]);

  const hasPage = !!page;
  useEffect(() => {
    const el = host.current;
    if (!el || !hasPage) return;
    let frame = 0;
    let last = "";
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const bounds =
          r.width < 1 || r.height < 1 || overlayCovers(r) ? null : { x: r.left, y: r.top, width: r.width, height: r.height };
        const key = JSON.stringify(bounds);
        if (key === last) return;
        last = key;
        void api.browserSetView(bounds).catch(() => {});
      });
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(el);
    // Menus and dialogs are portalled straight into <body>.
    const overlays = new MutationObserver(place);
    overlays.observe(document.body, { childList: true });
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", place);
      void api.browserSetView(null).catch(() => {});
    };
  }, [hasPage]);

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;
    (document.activeElement as HTMLElement | null)?.blur();
    void api.browserOpen(address).catch((err) => toast.error(errorMessage(err)));
  };
  const nav = (label: string, Icon: typeof FileIcon, to: "back" | "forward" | "reload", spin?: boolean) => (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={label}
      title={label}
      disabled={!hasPage}
      onClick={() => void api.browserGo(to).catch(() => {})}
    >
      <Icon className={cn("size-4", spin && "animate-spin")} />
    </Button>
  );

  return (
    <Pane className="flex-1">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b px-1.5">
        {nav("Back", ArrowLeftIcon, "back")}
        {nav("Forward", ArrowRightIcon, "forward")}
        {nav("Reload", RotateCwIcon, "reload", page?.loading)}
        <form onSubmit={open} className="mx-1 min-w-0 flex-1">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
            placeholder="Type a URL"
            aria-label="Address"
            title={page?.title || undefined}
            spellCheck={false}
            className="h-7 w-full rounded-md border bg-muted/40 px-2.5 text-sm outline-none focus-visible:bg-transparent focus-visible:ring-1 focus-visible:ring-ring"
          />
        </form>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close browser" onClick={() => togglePanel("browser", false)}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {hasPage ? (
        <div ref={host} className="min-h-0 flex-1 bg-white" />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <GlobeIcon className="size-7 text-muted-foreground" />
          <p className="text-sm font-medium">Browse with Sush</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            Type a URL, or ask Sush to open a site. It can read, click and type, and asks before opening a site for the first time.
          </p>
        </div>
      )}
    </Pane>
  );
}
