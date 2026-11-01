// The side panel of a session watched from another machine, like the Cowork
// panel beside the owner's: the room (chat, people, activity), and for a
// Cowork session the files it changed (and, if the host allows it, the rest
// of its folder, read-only), the folder's git graph, and the host's browser,
// followed in this app's own. Every read is a request the host checks
// (`share.rs`); secret files never come. Its left edge drags to resize.

import { ChevronRightIcon, FileIcon, FolderIcon, GitGraphIcon, GlobeIcon, MessageSquareTextIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { GitGraph, type GitSource } from "@/components/git-graph-pane";
import { RoomView } from "@/components/share-activity";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Switch } from "@/components/ui/switch";
import { BrowserPane } from "@/components/workspace-panel";
import { PANEL, setLayout, useLayout } from "@/lib/layout";
import { followUrl, requestDir, requestFile, requestGitCommit, requestGitLog } from "@/lib/share";
import { createStore } from "@/lib/store";
import { api, errorMessage, type FileView, type ShareView, type WorkspaceEntry } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Tab = "room" | "files" | "graph" | "browser";

const panelTab = createStore<Tab>("sush.shared-panel-tab", "room");
const panelOpen = createStore<boolean>("sush.shared-panel-open", true);

export function SharedPanel({ share, changed }: { share: ShareView; changed: Set<string> }) {
  const open = useSyncExternalStore(panelOpen.subscribe, panelOpen.get);
  const picked = useSyncExternalStore(panelTab.subscribe, panelTab.get);
  const { panel: width } = useLayout();
  const ref = useRef<HTMLElement>(null);
  const [path, setPath] = useState<string | null>(null);
  const cowork = share.thread.kind === "cowork";
  const tabs: { key: Tab; label: string; Icon: typeof FileIcon }[] = [
    { key: "room", label: "Room", Icon: MessageSquareTextIcon },
    ...(cowork
      ? [
          { key: "files" as const, label: "Files", Icon: FolderIcon },
          { key: "graph" as const, label: "Graph", Icon: GitGraphIcon },
        ]
      : []),
    { key: "browser", label: "Browser", Icon: GlobeIcon },
  ];
  const tab = tabs.some((t) => t.key === picked) ? picked : "room";
  const openFile = useCallback((p: string) => {
    setPath(p);
    panelTab.set("files");
  }, []);
  if (!open) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l pt-2">
        <button type="button" aria-label="Show the side panel" className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground" onClick={() => panelOpen.set(true)}>
          <PanelRightOpenIcon className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <aside
      ref={ref}
      className={cn(
        "relative flex max-w-[calc(100%-360px)] min-w-[320px] shrink-0 flex-col gap-2 p-2 pl-0",
        width === null && "w-[44%] max-w-[min(820px,calc(100%-360px))]",
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
          ref.current.classList.remove("w-[44%]", "max-w-[min(820px,calc(100%-360px))]");
        }}
        onResize={(panel) => setLayout({ panel })}
        onReset={() => setLayout({ panel: null })}
      />
      <div className="flex shrink-0 items-center gap-1">
        <div role="tablist" aria-label="Side panel" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 [scrollbar-width:none]">
          {tabs.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => panelTab.set(key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors",
                tab === key ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Hide the side panel" className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground" onClick={() => panelOpen.set(false)}>
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>
      {tab === "room" && (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
          <RoomView share={share} className="flex-1" />
        </section>
      )}
      {tab === "files" && <FilesTab share={share} changed={changed} path={path} onPath={setPath} />}
      {tab === "graph" && <GraphTab share={share} changed={changed} onOpenFile={openFile} />}
      {tab === "browser" && <FollowBrowser share={share} onClose={() => panelOpen.set(false)} />}
    </aside>
  );
}

function FilesTab({ share, changed, path, onPath }: { share: ShareView; changed: Set<string>; path: string | null; onPath: (path: string | null) => void }) {
  const threadId = share.threadId;
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <FolderIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{share.thread.workspaceName ?? "Folder"}</span>
        <span className="truncate text-xs text-muted-foreground">on {share.thread.hostName}’s machine</span>
      </div>
      {path ? (
        <Viewer threadId={threadId} path={path} onBack={() => onPath(null)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
          <h3 className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Changed in this session</h3>
          {changed.size === 0 && <p className="px-2 pb-2 text-muted-foreground">Nothing yet.</p>}
          {[...changed].sort().map((p) => (
            <Row key={p} name={p} onClick={() => onPath(p)} />
          ))}
          {share.policy.browseFiles && (
            <>
              <h3 className="px-2 pt-4 pb-1.5 text-xs font-medium text-muted-foreground">All files</h3>
              <Folder threadId={threadId} path="" depth={0} onOpen={onPath} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** The host's folder history, read through the share (no emails, no secret-looking paths). */
function GraphTab({ share, changed, onOpenFile }: { share: ShareView; changed: Set<string>; onOpenFile: (path: string) => void }) {
  const threadId = share.threadId;
  const source = useMemo<GitSource>(
    () => ({
      key: `shared:${share.shareId}`,
      log: (limit, all) => requestGitLog(threadId, limit, all),
      commit: (sha) => requestGitCommit(threadId, sha),
      // The session's file changes are the closest sign that the history moved.
      version: changed,
      openFile: onOpenFile,
      onClose: () => panelTab.set("room"),
    }),
    [share.shareId, threadId, changed, onOpenFile],
  );
  return <GitGraph source={source} className="flex-1" />;
}

/**
 * The host's browser, followed in this app's own: each page the host opens
 * opens here too (a page the host serves itself, at the host's network
 * address). Turn following off to browse on your own.
 */
function FollowBrowser({ share, onClose }: { share: ShareView; onClose: () => void }) {
  const [follow, setFollow] = useState(true);
  const page = share.browser;
  const target = page ? followUrl(page) : null;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!follow || !target || opened.current === target) return;
    opened.current = target;
    void api.browserOpen(target).catch((e) => toast.error("Couldn’t open the host’s page", { description: errorMessage(e) }));
  }, [follow, target]);
  const host = share.thread.hostName;
  const banner = (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <GlobeIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={page?.url}>
        {share.policy.hideBrowser
          ? `${host} keeps their browser to themselves.`
          : page
            ? `${host} is on ${page.title || page.url}${page.loading ? " (loading…)" : ""}`
            : `${host} hasn’t opened a page yet.`}
      </span>
      <label className="flex shrink-0 items-center gap-1.5">
        Follow
        <Switch
          checked={follow}
          onCheckedChange={(on) => {
            setFollow(on);
            if (on) opened.current = null;
          }}
          aria-label={`Follow ${host}’s browser`}
        />
      </label>
    </div>
  );
  return <BrowserPane onClose={onClose} banner={banner} />;
}

function Row({ name, onClick, dir, depth = 0, open }: { name: string; onClick: () => void; dir?: boolean; depth?: number; open?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
      className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-foreground/5"
    >
      {dir ? (
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      ) : (
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{name}</span>
    </button>
  );
}

function Folder({ threadId, path, depth, onOpen }: { threadId: string; path: string; depth: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    requestDir(threadId, path).then(
      (e) => live && setEntries(e),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [threadId, path]);
  if (error) return <p className="px-2 py-1 text-xs text-destructive">{error}</p>;
  if (!entries) return <LoadingState label="Loading" />;
  return (
    <>
      {entries.map((e) =>
        e.dir ? (
          <div key={e.path}>
            <Row
              name={e.name}
              dir
              depth={depth}
              open={expanded.has(e.path)}
              onClick={() =>
                setExpanded((s) => {
                  const next = new Set(s);
                  if (next.has(e.path)) next.delete(e.path);
                  else next.add(e.path);
                  return next;
                })
              }
            />
            {expanded.has(e.path) && <Folder threadId={threadId} path={e.path} depth={depth + 1} onOpen={onOpen} />}
          </div>
        ) : (
          <Row key={e.path} name={e.name} depth={depth} onClick={() => onOpen(e.path)} />
        ),
      )}
    </>
  );
}

function Viewer({ threadId, path, onBack }: { threadId: string; path: string; onBack: () => void }) {
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setFile(null);
    setError(null);
    requestFile(threadId, path).then(
      (f) => live && setFile(f),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [threadId, path]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button type="button" onClick={onBack} className="flex items-center gap-1 border-b px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3.5 rotate-180" /> <span className="truncate font-mono">{path}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-3 text-sm text-muted-foreground">{error}</p>
        ) : !file ? (
          <LoadingState label="Loading" />
        ) : file.text === null ? (
          <p className="p-3 text-sm text-muted-foreground">A binary file ({file.size.toLocaleString()} bytes).</p>
        ) : (
          <pre className="p-3 font-mono text-xs leading-5">
            {file.text.split("\n").map((line, i) => (
              <div key={i} className="flex">
                <span className="w-10 shrink-0 pr-3 text-right text-muted-foreground/60 select-none">{i + 1}</span>
                <span className="whitespace-pre">{line}</span>
              </div>
            ))}
            {file.truncated && <p className="mt-2 text-muted-foreground">Only the start of this file is shown.</p>}
          </pre>
        )}
      </div>
    </div>
  );
}
