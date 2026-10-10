// Commits as cards: one commit in full (message, author, sha, diff stats, files), or a list of
// commits as compact rows.

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRightIcon, CheckIcon, ChevronRightIcon, CopyIcon, GitCommitHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { Avatar } from "@/components/ui/PullRequestCard";
import { relativeTime, type Commit, type CommitFile, type CommitSet } from "@/lib/github";
import { cn } from "@/lib/utils";

const LIST_PREVIEW = 5;
const FILES_PREVIEW = 8;

export function CommitsCard({ set, className }: { set: CommitSet; className?: string }) {
  return set.commits.length === 1 ? (
    <CommitCard commit={set.commits[0]} repo={set.repo} className={className} />
  ) : (
    <CommitListCard set={set} className={className} />
  );
}

function CommitCard({ commit, repo, className }: { commit: Commit; repo?: string; className?: string }) {
  const url = commitUrl(commit, repo);
  const hasStats = commit.additions !== undefined || commit.deletions !== undefined;

  return (
    <article
      className={cn("w-full max-w-xl rounded-2xl border bg-card p-5 text-card-foreground shadow-sm", className)}
      aria-label={`Commit ${commit.sha.slice(0, 7)}: ${commit.subject}`}
    >
      <CardHeader label="Commit" repo={repo} url={url} />

      <h3 className="mt-1 text-lg leading-snug font-semibold tracking-tight">{commit.subject}</h3>
      {commit.body && <Body text={commit.body} />}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        {commit.author && (
          <span className="inline-flex items-center gap-1.5">
            <Avatar login={commit.author.login ?? commit.author.name} src={commit.author.avatarUrl} />
            <span className="text-foreground/80">{commit.author.name}</span>
            {commit.date && <time title={new Date(commit.date).toLocaleString()}>committed {relativeTime(commit.date)}</time>}
          </span>
        )}
        <Sha sha={commit.sha} />
        {commit.files && (
          <span>
            {commit.files.length} {commit.files.length === 1 ? "file" : "files"} changed
          </span>
        )}
        {hasStats && <Stats additions={commit.additions} deletions={commit.deletions} />}
      </div>

      {commit.files && commit.files.length > 0 && <Files files={commit.files} />}
    </article>
  );
}

function CommitListCard({ set, className }: { set: CommitSet; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? set.commits : set.commits.slice(0, LIST_PREVIEW);
  const hidden = set.commits.length - shown.length;

  return (
    <article className={cn("w-full max-w-xl rounded-2xl border bg-card p-2 text-card-foreground shadow-sm", className)}>
      <div className="px-3 pt-2 pb-1">
        <CardHeader
          label={`${set.commits.length} commits`}
          repo={set.repo}
          url={set.repo ? `https://github.com/${set.repo}/commits` : undefined}
        />
      </div>
      <ul className="flex flex-col">
        {shown.map((c) => {
          const url = commitUrl(c, set.repo);
          return (
            <li key={c.sha}>
              <button
                type="button"
                disabled={!url}
                onClick={() => url && void openUrl(url)}
                title={c.body ? `${c.subject}\n\n${c.body}` : c.subject}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors enabled:hover:bg-accent"
              >
                <Avatar login={c.author?.login ?? c.author?.name ?? "?"} src={c.author?.avatarUrl} className="size-6 text-[11px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.subject}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.author?.name ?? "Unknown author"}
                    {c.date && ` · ${relativeTime(c.date)}`}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mx-3 mt-1 mb-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </article>
  );
}

function CardHeader({ label, repo, url }: { label: string; repo?: string; url?: string }) {
  return (
    <header className="flex items-center gap-1.5 text-xs">
      <GitCommitHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium text-foreground/80">{label}</span>
      {repo && <span className="min-w-0 truncate text-muted-foreground">· {repo}</span>}
      {url && (
        <button
          type="button"
          onClick={() => void openUrl(url)}
          title="Open on GitHub"
          aria-label="Open on GitHub"
          className="-mr-1.5 ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowUpRightIcon className="size-4" />
        </button>
      )}
    </header>
  );
}

function Body({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 5;
  return (
    <>
      <p className={cn("mt-1.5 text-sm leading-relaxed whitespace-pre-line text-foreground/80", !expanded && "line-clamp-5")}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function Sha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; nothing to do.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? "Copied" : `Copy ${sha}`}
      className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 transition-colors hover:bg-muted"
    >
      {sha.slice(0, 7)}
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3 opacity-60" />}
    </button>
  );
}

function Stats({ additions, deletions }: { additions?: number; deletions?: number }) {
  return (
    <span className="font-medium tabular-nums">
      <span className="text-green-600 dark:text-green-500">+{additions ?? 0}</span>{" "}
      <span className="text-red-600 dark:text-red-500">−{deletions ?? 0}</span>
    </span>
  );
}

const FILE_STATUS: Record<string, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-green-600 dark:text-green-500" },
  removed: { letter: "D", className: "text-red-600 dark:text-red-500" },
  renamed: { letter: "R", className: "text-blue-600 dark:text-blue-400" },
};

function Files({ files }: { files: CommitFile[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES_PREVIEW);
  return (
    <section className="mt-4 border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Files changed
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1">
          {shown.map((f) => {
            const status = FILE_STATUS[f.status ?? ""] ?? { letter: "M", className: "text-amber-600 dark:text-amber-400" };
            return (
              <li key={f.path} className="flex items-center gap-2 text-xs">
                <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", status.className)} title={f.status}>
                  {status.letter}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/80" title={f.path}>
                  {f.path}
                </span>
                {(f.additions !== undefined || f.deletions !== undefined) && (
                  <Stats additions={f.additions} deletions={f.deletions} />
                )}
              </li>
            );
          })}
          {files.length > FILES_PREVIEW && (
            <li>
              <button
                type="button"
                onClick={() => setAll((a) => !a)}
                className="pl-5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {all ? "Show fewer" : `Show all ${files.length} files`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function commitUrl(commit: Commit, repo?: string) {
  return commit.url ?? (repo ? `https://github.com/${repo}/commit/${commit.sha}` : undefined);
}
