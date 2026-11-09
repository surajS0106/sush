// The Folders page: every Cowork folder at a glance, the sessions that worked in
// them, and each folder's files (`FolderDetail`). Opening a file starts a Cowork
// session in that folder with the file in the viewer.

import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LayoutGridIcon,
  ListIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { GithubLogoIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createStore, useConversations, type Conversation } from "@/lib/store";
import { api, errorMessage, type GitInfo, type Workspace, type WorkspaceEntry } from "@/lib/tauri";
import {
  addWorkspace,
  cachedGitInfo,
  loadGitInfo,
  removeWorkspace,
  useFilesVersion,
  useGitInfo,
  useWorkspaces,
} from "@/lib/workspaces";
import { cn } from "@/lib/utils";

/** Grid or list, remembered per window. */
const viewStore = createStore<"grid" | "list">("sush.folders-view", "grid", true, false);

interface FoldersPageProps {
  /** Start a Cowork session in a folder. */
  onNewSession: (workspaceId: string) => void;
  onOpenSession: (threadId: string) => void;
  /** Start a Cowork session in a folder with this file open in the viewer. */
  onOpenFile: (workspaceId: string, path: string) => void;
}

export function FoldersPage(props: FoldersPageProps) {
  // The folder shown, and the subfolder within it; null shows the overview.
  const [open, setOpen] = useState<{ id: string; path: string } | null>(null);
  const workspaces = useWorkspaces();
  const workspace = open ? workspaces.find((w) => w.id === open.id) : undefined;
  // Removed (here or in another window) while shown: back to the overview.
  useEffect(() => {
    if (open && !workspace) setOpen(null);
  }, [open, workspace]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 pt-8 pb-16">
        {open && workspace ? (
          <FolderDetail
            {...props}
            workspace={workspace}
            path={open.path}
            onNavigate={(path) => setOpen({ id: workspace.id, path })}
            onBack={() => setOpen(null)}
          />
        ) : (
          <Overview {...props} onOpenFolder={(id) => setOpen({ id, path: "" })} />
        )}
      </div>
    </div>
  );
}

// --- overview ---------------------------------------------------------------------

type FolderFilter = "all" | "repos" | "plain";
type FolderSort = "recent" | "name" | "added";

const FOLDER_FILTERS: { value: FolderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "repos", label: "Repositories" },
  { value: "plain", label: "Plain folders" },
];

const SORTS: { value: FolderSort; label: string }[] = [
  { value: "recent", label: "Last used" },
  { value: "name", label: "Name" },
  { value: "added", label: "Date added" },
];

/** Each folder's git state, loaded once per folder for the cards and the filter. */
function useGitInfos(workspaces: Workspace[]): Record<string, GitInfo | null> {
  // Start from the last known state so the icons are right on the first frame.
  const [infos, setInfos] = useState<Record<string, GitInfo | null>>(() => {
    const known: Record<string, GitInfo | null> = {};
    for (const w of workspaces) {
      const g = cachedGitInfo(w.id);
      if (g !== undefined) known[w.id] = g;
    }
    return known;
  });
  const ids = workspaces.map((w) => w.id).join("|");
  useEffect(() => {
    let live = true;
    for (const w of workspaces) {
      loadGitInfo(w.id).then((g) => live && setInfos((all) => ({ ...all, [w.id]: g })));
    }
    return () => {
      live = false;
    };
  }, [ids]);
  return infos;
}

function Overview({ onNewSession, onOpenSession, onOpenFolder }: FoldersPageProps & { onOpenFolder: (id: string) => void }) {
  const workspaces = useWorkspaces();
  const conversations = useConversations();
  const git = useGitInfos(workspaces);
  const view = useSyncExternalStore(viewStore.subscribe, viewStore.get);
  const [filter, setFilter] = useState<FolderFilter>("all");
  const [sort, setSort] = useState<FolderSort>("recent");
  const [query, setQuery] = useState("");

  // Started Cowork sessions, newest first.
  const sessions = useMemo(
    () =>
      conversations
        .filter((c) => c.workspaceId && c.messages.length > 0 && !c.incognito && !c.parentId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );
  const byFolder = useMemo(() => {
    const m = new Map<string, Conversation[]>();
    for (const c of sessions) m.set(c.workspaceId!, [...(m.get(c.workspaceId!) ?? []), c]);
    return m;
  }, [sessions]);
  const lastUsed = (w: Workspace) => byFolder.get(w.id)?.[0]?.updatedAt ?? w.createdAt;

  const q = query.trim().toLowerCase();
  const folders = workspaces
    .filter((w) => (filter === "repos" ? !!git[w.id] : filter === "plain" ? git[w.id] === null : true))
    .filter((w) => !q || w.name.toLowerCase().includes(q) || w.root.toLowerCase().includes(q))
    .sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "added" ? b.createdAt - a.createdAt : lastUsed(b) - lastUsed(a),
    );

  const add = async () => {
    try {
      const w = await addWorkspace();
      if (w) onOpenFolder(w.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Recent sessions, filtered to one folder by its chip.
  const [sessionFolder, setSessionFolder] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const sq = sessionQuery.trim().toLowerCase();
  const shownSessions = sessions
    .filter((c) => !sessionFolder || c.workspaceId === sessionFolder)
    .filter((c) => !sq || c.title.toLowerCase().includes(sq))
    .slice(0, 12);
  const usedFolders = workspaces.filter((w) => byFolder.has(w.id)).slice(0, 4);
  const nameOf = (id: string | undefined) => workspaces.find((w) => w.id === id)?.name ?? "Removed folder";

  return (
    <>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Folders</h1>
        <p className="mt-2 text-muted-foreground">Folders Sush can work in, the sessions that worked there, and their files.</p>
      </header>

      <section className="mt-10">
        <SectionLabel count={workspaces.length}>Folders</SectionLabel>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chips value={filter} options={FOLDER_FILTERS} onChange={setFilter} />
          <span className="flex-1" />
          <SortMenu value={sort} onChange={setSort} />
          <div className="flex items-center rounded-md border p-0.5">
            <ViewButton active={view === "grid"} label="Grid" onClick={() => viewStore.set("grid")}>
              <LayoutGridIcon />
            </ViewButton>
            <ViewButton active={view === "list"} label="List" onClick={() => viewStore.set("list")}>
              <ListIcon />
            </ViewButton>
          </div>
          <SearchField value={query} onChange={setQuery} placeholder="Search folders…" />
          <Button size="sm" className="h-8" onClick={() => void add()}>
            <PlusIcon /> Add folder
          </Button>
        </div>

        {workspaces.length === 0 ? (
          <button
            type="button"
            onClick={() => void add()}
            className="mt-4 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <FolderPlusIcon className="size-6" />
            <span className="text-sm">Add a folder for Sush to work in</span>
          </button>
        ) : folders.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">No folders match.</p>
        ) : (
          <div className={cn("mt-4", view === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3" : "flex flex-col divide-y rounded-xl border")}>
            {folders.map((w) => (
              <FolderCard
                key={w.id}
                workspace={w}
                git={git[w.id]}
                sessions={byFolder.get(w.id)?.length ?? 0}
                list={view === "list"}
                onOpen={() => onOpenFolder(w.id)}
                onNewSession={() => onNewSession(w.id)}
              />
            ))}
          </div>
        )}
      </section>

      {sessions.length > 0 && (
        <section className="mt-12">
          <SectionLabel count={sessions.length}>Recent sessions</SectionLabel>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Chips
              value={sessionFolder ?? "all"}
              options={[{ value: "all", label: "All" }, ...usedFolders.map((w) => ({ value: w.id, label: w.name }))]}
              onChange={(v) => setSessionFolder(v === "all" ? null : v)}
            />
            <span className="flex-1" />
            <SearchField value={sessionQuery} onChange={setSessionQuery} placeholder="Search sessions…" />
          </div>
          {shownSessions.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">No sessions match.</p>
          ) : (
            <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-4 gap-y-5">
              {shownSessions.map((c) => (
                <TileButton
                  key={c.id}
                  onClick={() => onOpenSession(c.id)}
                  preview={
                    git[c.workspaceId!] ? (
                      <RepoLogo className="size-10" />
                    ) : (
                      <MessageSquareIcon className="size-9 text-muted-foreground/50" strokeWidth={1.25} />
                    )
                  }
                  title={c.title}
                  meta={`${nameOf(c.workspaceId)} · ${ago(c.updatedAt)}`}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function FolderCard({
  workspace: w,
  git,
  sessions,
  list,
  onOpen,
  onNewSession,
}: {
  workspace: Workspace;
  git: GitInfo | null | undefined;
  sessions: number;
  list: boolean;
  onOpen: () => void;
  onNewSession: () => void;
}) {
  const readOnly = w.access === "read-only";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 transition-colors hover:bg-muted/50",
        list ? "px-3 py-2.5 first:rounded-t-xl last:rounded-b-xl" : "rounded-xl border bg-card px-3.5 py-3 shadow-xs",
      )}
    >
      <button type="button" onClick={onOpen} className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${w.name}`} />
      <FolderGlyph repo={!!git} className="size-6" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={w.root}>
          {w.name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {git ? (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{git.branch ?? "detached"}</span>
            </span>
          ) : readOnly ? (
            <span className="flex items-center gap-1">
              <LockIcon className="size-3" /> Read-only
            </span>
          ) : (
            <span>Folder</span>
          )}
          <span>·</span>
          <span className="shrink-0">
            {sessions} {sessions === 1 ? "session" : "sessions"}
          </span>
        </div>
      </div>
      {list && <span className="hidden truncate text-xs text-muted-foreground sm:block sm:max-w-64">{w.root}</span>}
      <FolderMenu workspace={w} onNewSession={onNewSession} />
    </div>
  );
}

function FolderMenu({ workspace: w, onNewSession, className }: { workspace: Workspace; onNewSession: () => void; className?: string }) {
  const remove = () => void removeWorkspace(w.id).catch((e) => toast.error(errorMessage(e)));
  const openIn = (target: "vscode" | "files") => void api.workspaceOpenIn(w.id, target).catch((e) => toast.error(errorMessage(e)));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${w.name} options`}
          className={cn("relative size-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100", className)}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onNewSession}>
          <PencilIcon /> New session here
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openIn("files")}>
          <FolderOpenIcon /> Show in file manager
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openIn("vscode")}>
          <ExternalLinkIcon /> Open in VS Code
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={remove}>
          <Trash2Icon /> Remove folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- one folder ----------------------------------------------------------------

function FolderDetail({
  workspace: w,
  path,
  onNavigate,
  onBack,
  onNewSession,
  onOpenFile,
}: FoldersPageProps & { workspace: Workspace; path: string; onNavigate: (path: string) => void; onBack: () => void }) {
  const version = useFilesVersion(w.id);
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    setEntries(null);
    api
      .workspaceTree(w.id, path)
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [w.id, path, version]);

  const git = useGitInfo(w.id);
  const parts = path.split("/").filter(Boolean);
  const q = query.trim().toLowerCase();
  const shown = (entries ?? [])
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={onBack}>
          Folders
        </button>
        <ChevronRightIcon className="size-3.5" />
        <button type="button" className={cn("hover:text-foreground", parts.length === 0 && "text-foreground")} onClick={() => onNavigate("")}>
          {w.name}
        </button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3.5" />
            <button
              type="button"
              className={cn("hover:text-foreground", i === parts.length - 1 && "text-foreground")}
              onClick={() => onNavigate(parts.slice(0, i + 1).join("/"))}
            >
              {p}
            </button>
          </span>
        ))}
      </nav>

      <button
        type="button"
        onClick={() => (parts.length ? onNavigate(parts.slice(0, -1).join("/")) : onBack())}
        className="mt-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" /> {parts.length ? (parts.length > 1 ? parts[parts.length - 2] : w.name) : "Folders"}
      </button>

      <header className="group mt-4 flex flex-wrap items-center gap-3">
        <FolderGlyph repo={!!git && parts.length === 0} className="size-7" />
        <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight" title={w.root}>
          {parts.length ? parts[parts.length - 1] : w.name}
        </h1>
        <SearchField value={query} onChange={setQuery} placeholder="Search files…" />
        <FolderMenu workspace={w} onNewSession={() => onNewSession(w.id)} className="opacity-100" />
        <Button size="sm" className="h-8" onClick={() => onNewSession(w.id)}>
          <PlusIcon /> New session
        </Button>
      </header>
      <p className="mt-1 truncate pl-10 text-xs text-muted-foreground">{w.root}</p>

      {error ? (
        <p className="mt-8 text-sm text-destructive">{error}</p>
      ) : entries === null ? (
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-muted/60" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">{q ? "No files match." : "This folder is empty."}</p>
      ) : (
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-5">
          {shown.map((e) =>
            e.dir ? (
              <TileButton
                key={e.path}
                onClick={() => onNavigate(e.path)}
                preview={<FolderIcon className="size-12 fill-sky-400 text-sky-400" strokeWidth={1} />}
                title={e.name}
                meta="Folder"
              />
            ) : (
              <TileButton
                key={e.path}
                onClick={() => onOpenFile(w.id, e.path)}
                preview={<FileGlyph name={e.name} />}
                title={e.name}
                meta={`${kindOf(e.name).label} · ${formatSize(e.size)}`}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}

// --- pieces ----------------------------------------------------------------------

/** A folder's icon: the GitHub logo for a repository, else a blue folder. */
function FolderGlyph({ repo, className }: { repo: boolean; className?: string }) {
  if (!repo) return <FolderIcon className={cn("shrink-0 fill-sky-400 text-sky-400", className)} />;
  return <RepoLogo className={className} />;
}

/** The one GitHub logo used for repositories everywhere on this page. */
function RepoLogo({ className }: { className?: string }) {
  return <GithubLogoIcon aria-label="Git repository" className={cn("shrink-0 text-foreground/70", className)} />;
}

/** A card with a large preview area and a caption under it. */
function TileButton({ preview, title, meta, onClick }: { preview: ReactNode; title: string; meta: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group min-w-0 text-left outline-none">
      <span className="flex aspect-[4/3] items-center justify-center rounded-xl border bg-card shadow-xs transition group-hover:bg-muted/40 group-hover:shadow-sm group-focus-visible:ring-2 group-focus-visible:ring-ring">
        {preview}
      </span>
      <span className="mt-2 block truncate text-sm font-medium" title={title}>
        {title}
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta}</span>
    </button>
  );
}

const KINDS: { ext: string[]; label: string; badge: string; color: string; lines: "text" | "table" | "image" }[] = [
  { ext: ["pdf"], label: "PDF", badge: "PDF", color: "bg-rose-500", lines: "image" },
  { ext: ["doc", "docx", "rtf", "odt"], label: "Document", badge: "DOC", color: "bg-blue-500", lines: "text" },
  { ext: ["xls", "xlsx", "csv", "tsv", "ods"], label: "Spreadsheet", badge: "XLS", color: "bg-emerald-500", lines: "table" },
  { ext: ["ppt", "pptx", "key"], label: "Presentation", badge: "PPT", color: "bg-orange-500", lines: "image" },
  { ext: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"], label: "Image", badge: "IMG", color: "bg-violet-500", lines: "image" },
  { ext: ["md", "mdx", "txt"], label: "Text", badge: "MD", color: "bg-slate-500", lines: "text" },
  { ext: ["json", "yaml", "yml", "toml", "xml", "ini", "lock"], label: "Config", badge: "CFG", color: "bg-amber-500", lines: "text" },
  {
    ext: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt", "swift", "c", "h", "cpp", "cs", "rb", "php", "sh", "ps1", "css", "html", "sql", "vue", "svelte"],
    label: "Code",
    badge: "",
    color: "bg-cyan-600",
    lines: "text",
  },
];

function kindOf(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const kind = KINDS.find((k) => k.ext.includes(ext));
  if (!kind) return { label: ext ? ext.toUpperCase() : "File", badge: ext.slice(0, 4).toUpperCase(), color: "bg-zinc-500", lines: "text" as const };
  return { ...kind, badge: kind.badge || ext.slice(0, 4).toUpperCase() };
}

/** A sheet of paper with the file type's badge, like a document thumbnail. */
function FileGlyph({ name }: { name: string }) {
  const kind = kindOf(name);
  return (
    <span className="relative flex h-16 w-13 flex-col gap-1 rounded-md border bg-background p-2 shadow-xs">
      {kind.lines === "image" ? (
        <span className="h-5 rounded-sm bg-muted" />
      ) : kind.lines === "table" ? (
        Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="flex gap-0.5">
            <span className="h-1 flex-1 rounded-full bg-muted" />
            <span className="h-1 flex-1 rounded-full bg-muted" />
            <span className="h-1 flex-1 rounded-full bg-muted" />
          </span>
        ))
      ) : (
        Array.from({ length: 4 }, (_, i) => <span key={i} className={cn("h-1 rounded-full bg-muted", i === 3 && "w-2/3")} />)
      )}
      {kind.badge && (
        <span className={cn("absolute bottom-2.5 -left-2 rounded-[3px] px-1 py-px text-[9px] leading-tight font-bold text-white", kind.color)}>
          {kind.badge}
        </span>
      )}
    </span>
  );
}

function SectionLabel({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children} <span className="ml-1 tabular-nums opacity-70">{count}</span>
    </h2>
  );
}

function Chips<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="flex flex-wrap items-center gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "max-w-40 truncate rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
            value === o.value && "bg-muted text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SortMenu({ value, onChange }: { value: FolderSort; onChange: (v: FolderSort) => void }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="size-8" aria-label="Sort folders">
              <ArrowDownUpIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Sort: {SORTS.find((s) => s.value === value)?.label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {SORTS.map((s) => (
          <DropdownMenuItem key={s.value} onSelect={() => onChange(s.value)} className={cn(value === s.value && "font-medium")}>
            {s.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-6.5 items-center justify-center rounded-[5px] text-muted-foreground hover:text-foreground [&>svg]:size-3.5",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-44 pl-8 text-sm"
      />
    </div>
  );
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
