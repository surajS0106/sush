// Cowork's git graph: the workspace's history drawn in lanes, like an
// editor's source control graph, with each branch, remote and tag where it
// points. Picking a commit shows its message and the files it changed (open
// in the viewer on click). Re-reads git whenever files change, which includes
// each command finishing in the terminal.

import { CloudIcon, CopyIcon, GitBranchIcon, GitGraphIcon, RefreshCwIcon, TagIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { LoadingState } from "@/components/ui/loading-state";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ago, edgePath, laneX, layout, rowY, type GraphGeometry, type GraphNode } from "@/lib/commit-graph";
import { createStore } from "@/lib/store";
import { api, errorMessage, type CommitDetail, type GitLog, type GitRef, type LogCommit, type Workspace } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { openFile, togglePanel, useGitLog } from "@/lib/workspaces";

const G: GraphGeometry = { row: 26, lane: 14, pad: 10 };
/** Commits read at a time; "Load more" reads this many more. */
const PAGE = 200;
/** Beyond this the graph column clips, so the subjects keep their room. */
const MAX_GRAPH_WIDTH = 168;
/** One colour per lane, cycling. */
const LANE_COLORS = [
  "text-brand",
  "text-amber-500",
  "text-violet-500",
  "text-teal-500",
  "text-rose-500",
  "text-green-600 dark:text-green-500",
  "text-orange-500",
  "text-sky-500",
];
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

/** Every branch, or only HEAD and the branch it tracks. */
const showAll = createStore<boolean>("sush.git-graph-all", true);

interface Row extends GraphNode {
  commit?: LogCommit;
}

function buildRows(log: GitLog): Row[] {
  const rows: Row[] = log.uncommitted > 0 && log.head ? [{ key: "~work", parents: [log.head] }] : [];
  for (const c of log.commits) rows.push({ key: c.sha, parents: c.parents, commit: c });
  return rows;
}

export function GitGraphPane({ workspace, className }: { workspace: Workspace; className?: string }) {
  const all = useSyncExternalStore(showAll.subscribe, showAll.get);
  const [limit, setLimit] = useState(PAGE);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const { log, error, loading } = useGitLog(workspace.id, limit, all, refresh);

  const rows = useMemo(() => (log ? buildRows(log) : []), [log]);
  const { cols, edges, lanes } = useMemo(() => layout(rows), [rows]);
  const width = Math.min(MAX_GRAPH_WIDTH, G.pad * 2 + (lanes - 1) * G.lane);

  // Up/Down move between commits.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const commits = rows.filter((r) => r.commit);
    if (!commits.length) return;
    e.preventDefault();
    const at = commits.findIndex((r) => r.key === selected);
    const next = e.key === "ArrowDown" ? Math.min(commits.length - 1, at + 1) : Math.max(0, at - 1);
    setSelected(commits[next].key);
    e.currentTarget.querySelector<HTMLElement>(`[data-sha="${commits[next].key}"]`)?.focus();
  };

  return (
    <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background", className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5 pl-3">
        <GitGraphIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">Graph</span>
        {log?.branch && <span className="truncate font-mono text-xs text-muted-foreground">{log.branch}</span>}
        <span className="flex-1" />
        <div role="radiogroup" aria-label="Branches shown" className="flex shrink-0 rounded-md bg-muted p-0.5 text-xs">
          {[
            [true, "All", "Every branch, remote and tag"],
            [false, "Current", "This branch and the one it tracks"],
          ].map(([value, label, hint]) => (
            <Tooltip key={String(value)}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={all === value}
                  onClick={() => {
                    showAll.set(value as boolean);
                    setLimit(PAGE);
                  }}
                  className={cn(
                    "rounded px-2 py-0.5 transition-colors",
                    all === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label as string}
                </button>
              </TooltipTrigger>
              <TooltipContent>{hint as string}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" onClick={() => setRefresh((r) => r + 1)}>
              <RefreshCwIcon className={cn("size-3.5", loading && log && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close graph" onClick={() => togglePanel("graph", false)}>
          <XIcon className="size-4" />
        </Button>
      </div>

      {!log ? (
        error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <GitGraphIcon className="size-7 text-muted-foreground" />
            <p className="max-w-64 text-sm text-muted-foreground">{error}</p>
          </div>
        ) : (
          <LoadingState label="Reading the history" className="m-3" />
        )
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">No commits yet</div>
      ) : (
        <>
          <div role="listbox" aria-label="Commits" onKeyDown={onKey} className="min-h-0 flex-1 overflow-y-auto py-1 text-sm">
            <div className="relative" style={{ paddingLeft: width + 4 }}>
              <svg
                className="pointer-events-none absolute top-0 left-0 overflow-hidden"
                width={width}
                height={rows.length * G.row}
                aria-hidden
              >
                {edges.map((e) => (
                  <path
                    key={`${rows[e.from].key}>${rows[e.to].key}`}
                    d={edgePath(G, e, cols)}
                    fill="none"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    strokeDasharray={rows[e.from].commit ? undefined : "2 3"}
                    className={laneColor(e.lane)}
                  />
                ))}
                {rows.map((r, i) => {
                  const head = r.key === log.head;
                  const hollow = !r.commit || r.commit.parents.length > 1;
                  return (
                    <circle
                      key={r.key}
                      cx={laneX(G, cols[i])}
                      cy={rowY(G, i)}
                      r={head ? 5 : 3.5}
                      strokeWidth={hollow || head ? 1.5 : 0}
                      stroke="currentColor"
                      className={cn(laneColor(cols[i]), hollow || head ? "fill-background" : "fill-current")}
                    />
                  );
                })}
              </svg>
              {rows.map((r, i) =>
                r.commit ? (
                  <CommitRow
                    key={r.key}
                    commit={r.commit}
                    color={laneColor(cols[i])}
                    you={log.you}
                    selected={selected === r.key}
                    onSelect={() => setSelected((s) => (s === r.key ? null : r.key))}
                  />
                ) : (
                  <div key={r.key} className="flex items-center gap-2 pr-3 text-muted-foreground" style={{ height: G.row }}>
                    <span className="min-w-0 flex-1 truncate italic">Uncommitted changes</span>
                    <span className="shrink-0 text-xs">
                      {log.uncommitted} {log.uncommitted === 1 ? "file" : "files"}
                    </span>
                  </div>
                ),
              )}
            </div>
            {log.more && (
              <button
                type="button"
                onClick={() => setLimit((l) => l + PAGE)}
                disabled={loading}
                className="mt-1 mb-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                style={{ marginLeft: width + 4 }}
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
          {selected && <CommitDetails key={selected} workspace={workspace} sha={selected} onClose={() => setSelected(null)} />}
        </>
      )}
    </section>
  );
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error("Couldn't copy"),
  );
}

function CommitRow({
  commit: c,
  color,
  you,
  selected,
  onSelect,
}: {
  commit: LogCommit;
  color: string;
  you: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const author = you && c.author === you ? "You" : c.author;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          role="option"
          aria-selected={selected}
          data-sha={c.sha}
          onClick={onSelect}
          title={`${c.subject}\n${c.sha.slice(0, 7)} · ${c.author} · ${new Date(c.time * 1000).toLocaleString()}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-l-md pr-3 pl-1 text-left outline-none focus-visible:bg-muted",
            selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
          )}
          style={{ height: G.row }}
        >
          <span className="min-w-0 truncate">{c.subject}</span>
          <RefChips refs={c.refs} color={color} />
          <span className="min-w-2 flex-1" />
          <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">{author}</span>
          <span className="w-10 shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">{ago(c.time)}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => copy(c.sha, "commit SHA")}>
          <CopyIcon /> Copy commit SHA
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(c.subject, "message")}>
          <CopyIcon /> Copy message
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface Chip {
  name: string;
  kind: GitRef["kind"];
  head: boolean;
  /** A local branch whose remote copy points here too (`origin/main` beside `main`). */
  synced: boolean;
}

/** A local branch and its remote copy at the same commit share one chip. */
function chipsOf(refs: GitRef[]): Chip[] {
  const locals = new Set(refs.filter((r) => r.kind === "branch").map((r) => r.name));
  const synced = new Set<string>();
  const chips: Chip[] = [];
  for (const r of refs) {
    if (r.kind !== "remote") continue;
    const local = r.name.slice(r.name.indexOf("/") + 1);
    if (locals.has(local)) synced.add(local);
  }
  for (const r of refs) {
    if (r.kind === "remote" && locals.has(r.name.slice(r.name.indexOf("/") + 1))) continue;
    chips.push({ name: r.name, kind: r.kind, head: r.head, synced: r.kind === "branch" && synced.has(r.name) });
  }
  // HEAD's branch first, then branches, remotes, tags.
  const order = { branch: 1, remote: 2, tag: 3 };
  return chips.sort((a, b) => Number(b.head) - Number(a.head) || order[a.kind] - order[b.kind]);
}

function RefChips({ refs, color }: { refs: GitRef[]; color: string }) {
  const chips = useMemo(() => chipsOf(refs), [refs]);
  if (chips.length === 0) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {chips.map((r) => {
        const Icon = r.kind === "tag" ? TagIcon : r.kind === "remote" ? CloudIcon : GitBranchIcon;
        return (
          <span
            key={`${r.kind}:${r.name}`}
            className={cn(
              "inline-flex h-[18px] max-w-40 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] last:shrink",
              r.kind === "tag" ? "bg-muted text-muted-foreground" : cn(color, "bg-current/12"),
              r.head && "ring-1 ring-current/40",
            )}
          >
            <Icon className="size-3 shrink-0" />
            <span className={cn("truncate font-mono", r.kind !== "tag" && "text-foreground", r.head && "font-semibold")}>{r.name}</span>
            {r.synced && <CloudIcon className="size-3 shrink-0" aria-label="Same as on the remote" />}
          </span>
        );
      })}
    </span>
  );
}

function CommitDetails({ workspace, sha, onClose }: { workspace: Workspace; sha: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .workspaceGitCommit(workspace.id, sha)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspace.id, sha]);

  const [subject, ...rest] = (detail?.message ?? "").split("\n");
  const body = rest.join("\n").trim();
  const added = detail?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0;
  const removed = detail?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0;

  return (
    <div className="flex max-h-[45%] min-h-24 shrink-0 flex-col border-t">
      {!detail ? (
        error ? (
          <p className="p-3 text-sm text-muted-foreground">{error}</p>
        ) : (
          <LoadingState label="Reading the commit" className="m-3" />
        )
      ) : (
        <div className="min-h-0 overflow-y-auto p-3 text-sm">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 font-medium">{subject}</p>
            <Button variant="ghost" size="icon" className="-mt-1 -mr-1 size-6" aria-label="Close commit" onClick={onClose}>
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span title={detail.email}>{detail.author}</span>·<span>{new Date(detail.time * 1000).toLocaleString()}</span>·
            <button
              type="button"
              className="inline-flex items-center gap-1 font-mono hover:text-foreground"
              title="Copy commit SHA"
              onClick={() => copy(detail.sha, "commit SHA")}
            >
              {detail.sha.slice(0, 7)} <CopyIcon className="size-3" />
            </button>
          </p>
          {body && <p className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">{body}</p>}
          <p className="mt-3 mb-1 text-xs text-muted-foreground">
            {detail.files.length} {detail.files.length === 1 ? "file" : "files"} changed
            {(added > 0 || removed > 0) && (
              <>
                {" "}
                <span className="text-green-600 dark:text-green-500">+{added}</span>{" "}
                <span className="text-red-600 dark:text-red-500">−{removed}</span>
              </>
            )}
          </p>
          <ul className="-mx-1.5">
            {detail.files.map((f) => {
              const slash = f.path.lastIndexOf("/");
              const local = f.local;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    disabled={!local}
                    onClick={() => local && openFile(workspace.id, local)}
                    title={local ? `Open ${local}` : `${f.path} is outside this folder`}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left enabled:hover:bg-muted/60 disabled:cursor-default"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {f.path.slice(slash + 1)}
                      {slash > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{f.path.slice(0, slash)}</span>}
                    </span>
                    {f.additions === null ? (
                      <span className="shrink-0 text-xs text-muted-foreground">binary</span>
                    ) : (
                      <span className="shrink-0 text-xs tabular-nums">
                        <span className="text-green-600 dark:text-green-500">+{f.additions}</span>{" "}
                        <span className="text-red-600 dark:text-red-500">−{f.deletions}</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
