// The side panel of a Cowork session watched from another machine: the files
// it changed and, if the host allows it, the rest of its folder, read-only.
// Every read is a request the host checks (`share.rs`); secret files never come.

import { ChevronRightIcon, FileIcon, FolderIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { LoadingState } from "@/components/ui/loading-state";
import { requestDir, requestFile } from "@/lib/share";
import { errorMessage, type FileView, type ShareView, type WorkspaceEntry } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export function SharedFilesPanel({ share, changed }: { share: ShareView; changed: Set<string> }) {
  const [open, setOpen] = useState(true);
  const [path, setPath] = useState<string | null>(null);
  const threadId = share.threadId;
  if (!open) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l pt-2">
        <button type="button" aria-label="Show files" className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground" onClick={() => setOpen(true)}>
          <PanelRightOpenIcon className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <aside className="flex w-[min(28rem,40vw)] min-w-64 shrink-0 flex-col border-l">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <FolderIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{share.thread.workspaceName ?? "Folder"}</span>
        <span className="text-xs text-muted-foreground">on {share.thread.hostName}’s machine</span>
        <button type="button" aria-label="Hide files" className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground" onClick={() => setOpen(false)}>
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>
      {path ? (
        <Viewer threadId={threadId} path={path} onBack={() => setPath(null)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
          <h3 className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Changed in this session</h3>
          {changed.size === 0 && <p className="px-2 pb-2 text-muted-foreground">Nothing yet.</p>}
          {[...changed].sort().map((p) => (
            <Row key={p} name={p} onClick={() => setPath(p)} />
          ))}
          {share.policy.browseFiles && (
            <>
              <h3 className="px-2 pt-4 pb-1.5 text-xs font-medium text-muted-foreground">All files</h3>
              <Folder threadId={threadId} path="" depth={0} onOpen={setPath} />
            </>
          )}
        </div>
      )}
    </aside>
  );
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
