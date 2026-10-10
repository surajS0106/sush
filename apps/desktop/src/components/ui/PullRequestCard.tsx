// A pull request as a card: status, title, branches and diff stats, its description, and any
// screenshots from the description as a small carousel.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  ImageIcon,
  TextIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { bodyImages, bodyText, type PullRequest, type PullRequestState } from "@/lib/github";
import { cn } from "@/lib/utils";

const STATES: Record<PullRequestState, { label: string; icon: typeof GitPullRequestIcon; className: string }> = {
  open: { label: "PR Open", icon: GitPullRequestIcon, className: "text-green-600 dark:text-green-500" },
  draft: { label: "Draft PR", icon: GitPullRequestDraftIcon, className: "text-muted-foreground" },
  merged: { label: "PR Merged", icon: GitMergeIcon, className: "text-violet-600 dark:text-violet-400" },
  closed: { label: "PR Closed", icon: GitPullRequestClosedIcon, className: "text-red-600 dark:text-red-500" },
};

export function PullRequestCard({ pr, className }: { pr: PullRequest; className?: string }) {
  const status = STATES[pr.state];
  const text = useMemo(() => (pr.body ? bodyText(pr.body) : ""), [pr.body]);
  const images = useMemo(() => (pr.body ? bodyImages(pr.body) : []), [pr.body]);
  const hasStats = pr.additions !== undefined || pr.deletions !== undefined;

  return (
    <article
      className={cn("w-full max-w-xl rounded-2xl border bg-card p-5 text-card-foreground shadow-sm", className)}
      aria-label={`Pull request #${pr.number}: ${pr.title}`}
    >
      <header className="flex items-center gap-1.5 text-xs">
        <status.icon className={cn("size-3.5 shrink-0", status.className)} aria-hidden />
        <span className={cn("font-medium", status.className)}>{status.label}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          · {pr.repo} #{pr.number}
        </span>
        <button
          type="button"
          onClick={() => void openUrl(pr.url)}
          title="Open on GitHub"
          aria-label="Open on GitHub"
          className="-mr-1.5 ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowUpRightIcon className="size-4" />
        </button>
      </header>

      <h3 className="mt-1 text-xl leading-snug font-semibold tracking-tight">
        <button type="button" onClick={() => void openUrl(pr.url)} className="text-left hover:underline">
          {pr.title}
        </button>
      </h3>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        {pr.author && (
          <span className="inline-flex items-center gap-1.5">
            <Avatar login={pr.author.login} src={pr.author.avatarUrl} />
            {pr.author.login}
          </span>
        )}
        {(pr.base || pr.head) && (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {pr.base && <Branch name={pr.base} />}
            {pr.base && pr.head && <ArrowLeftIcon className="size-3 shrink-0" aria-label="from" />}
            {pr.head && <Branch name={pr.head} />}
          </span>
        )}
        {pr.changedFiles !== undefined && (
          <span>
            {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"} changed
          </span>
        )}
        {hasStats && (
          <span className="font-medium tabular-nums">
            <span className="text-green-600 dark:text-green-500">+{pr.additions ?? 0}</span>{" "}
            <span className="text-red-600 dark:text-red-500">−{pr.deletions ?? 0}</span>
          </span>
        )}
      </div>

      <Description text={text} />

      {images.length > 0 && <Screenshots urls={images} />}
    </article>
  );
}

/** A GitHub user's avatar, or their initial when there's no picture to load. */
export function Avatar({ login, src, className }: { login: string; src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-foreground uppercase",
          className,
        )}
      >
        {login[0]}
      </span>
    );
  }
  return <img src={src} alt="" className={cn("size-4 shrink-0 rounded-full bg-muted", className)} onError={() => setFailed(true)} />;
}

function Branch({ name }: { name: string }) {
  return (
    <span title={name} className="max-w-40 truncate rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
      {name}
    </span>
  );
}

function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 4;
  return (
    <section className="mt-4">
      <h4 className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <TextIcon className="size-3.5" aria-hidden />
        Description
      </h4>
      {text ? (
        <>
          <p className={cn("mt-1.5 text-sm leading-relaxed whitespace-pre-line text-foreground/85", !expanded && "line-clamp-4")}>
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
      ) : (
        <p className="mt-1.5 text-sm text-muted-foreground italic">No description provided.</p>
      )}
    </section>
  );
}

function Screenshots({ urls }: { urls: string[] }) {
  // Attachments on private repos need a GitHub session; drop the ones that won't load.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const shown = urls.filter((u) => !failed.has(u));
  const [index, setIndex] = useState(0);
  if (shown.length === 0) return null;
  const at = Math.min(index, shown.length - 1);
  const go = (to: number) => setIndex((to + shown.length) % shown.length);

  return (
    <section className="mt-4 rounded-xl border bg-muted/40 p-3">
      <h4 className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ImageIcon className="size-3.5" aria-hidden />
        <span>Screenshots</span>
        <span className="ml-auto tabular-nums">
          {at + 1}/{shown.length}
        </span>
      </h4>

      <div className="group relative mt-2.5 aspect-video overflow-hidden rounded-lg bg-muted">
        <img
          key={shown[at]}
          src={shown[at]}
          alt={`Screenshot ${at + 1} of ${shown.length}`}
          className="size-full cursor-zoom-in object-contain"
          onClick={() => void openUrl(shown[at])}
          onError={() => setFailed((f) => new Set(f).add(shown[at]))}
        />
        {shown.length > 1 && (
          <>
            <CarouselButton side="left" onClick={() => go(at - 1)} />
            <CarouselButton side="right" onClick={() => go(at + 1)} />
          </>
        )}
      </div>

      {shown.length > 1 && (
        <div className="mt-3 flex gap-1" role="tablist" aria-label="Screenshots">
          {shown.map((u, i) => (
            <button
              key={u}
              type="button"
              role="tab"
              aria-selected={i === at}
              aria-label={`Screenshot ${i + 1}`}
              onClick={() => setIndex(i)}
              className="group/seg flex-1 py-1.5"
            >
              <span
                className={cn(
                  "block h-1 rounded-full transition-colors",
                  i <= at ? "bg-blue-500" : "bg-foreground/10 group-hover/seg:bg-foreground/20",
                )}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function CarouselButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous screenshot" : "Next screenshot"}
      className={cn(
        "absolute top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
