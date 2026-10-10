// Recognising a pull request in a connector's tool output, so the chat can show it as a card
// instead of raw JSON. Works with the GitHub MCP server's get/create/update results.

export type PullRequestState = "open" | "draft" | "merged" | "closed";

export interface PullRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  body?: string;
  state: PullRequestState;
  url: string;
  author?: { login: string; avatarUrl?: string };
  base?: string;
  head?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}

const PR_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;
const API_PR_URL = /api\.github\.com\/repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)/;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A single pull request in `output`, or null when it isn't one. `input` fills gaps: create calls
 * often answer with just `{ id, url }`, while the title, body and branches are in the arguments.
 */
export function parsePullRequest(output: unknown, input?: unknown): PullRequest | null {
  let data: unknown = output;
  if (typeof output === "string") {
    try {
      data = JSON.parse(output.trim());
    } catch {
      return null;
    }
  }
  if (!isObject(data)) return null;
  const args = isObject(input) ? input : {};

  const link = [data.html_url, data.url].map(str).find((u) => u && (PR_URL.test(u) || API_PR_URL.test(u)));
  const match = link && (link.match(PR_URL) ?? link.match(API_PR_URL));
  if (!match) return null;
  const [, repo, number] = match;

  const title = str(data.title) ?? str(args.title);
  if (!title) return null;

  const base = isObject(data.base) ? str(data.base.ref) : undefined;
  const head = isObject(data.head) ? str(data.head.ref) : undefined;
  const user = isObject(data.user) ? data.user : undefined;
  const login = user && str(user.login);

  return {
    repo,
    number: Number(number),
    title,
    body: typeof data.body === "string" ? data.body : str(args.body),
    state: stateOf(data, args),
    url: link.includes("api.github.com") ? `https://github.com/${repo}/pull/${number}` : link,
    author: login ? { login, avatarUrl: str(user.avatar_url) } : undefined,
    base: base ?? str(args.base),
    head: head ?? str(args.head),
    changedFiles: num(data.changed_files),
    additions: num(data.additions),
    deletions: num(data.deletions),
  };
}

function stateOf(data: Json, args: Json): PullRequestState {
  if (data.merged === true || str(data.merged_at)) return "merged";
  if (data.state === "closed") return "closed";
  if (data.draft === true || (data.draft === undefined && args.draft === true)) return "draft";
  return "open";
}

/** Image URLs embedded in a PR description (markdown or `<img>`), in order, deduplicated. */
export function bodyImages(body: string): string[] {
  const urls = [
    ...[...body.matchAll(/!\[[^\]]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?[^)]*\)/g)].map((m) => ({ at: m.index ?? 0, url: m[1] })),
    ...[...body.matchAll(/<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi)].map((m) => ({ at: m.index ?? 0, url: m[1] })),
  ];
  return [...new Set(urls.sort((a, b) => a.at - b.at).map((u) => u.url))];
}

/** A PR description as readable plain text: no images, comments, tags or markdown syntax. */
export function bodyText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "• ")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^[ \t]+$/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CommitFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

export interface Commit {
  sha: string;
  url?: string;
  subject: string;
  body?: string;
  author?: { name: string; login?: string; avatarUrl?: string };
  date?: string;
  additions?: number;
  deletions?: number;
  files?: CommitFile[];
}

export interface CommitSet {
  /** `owner/name`, when the output or the call's arguments say. */
  repo?: string;
  commits: Commit[];
}

const COMMIT_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/commit\/[0-9a-f]+/;

/** The commits in `output` (one from get_commit, several from list_commits), or null when it has none. */
export function parseCommits(output: unknown, input?: unknown): CommitSet | null {
  let data: unknown = output;
  if (typeof output === "string") {
    try {
      data = JSON.parse(output.trim());
    } catch {
      return null;
    }
  }
  const items = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.commits) ? data.commits : [data];
  const commits = items.map(toCommit).filter((c): c is Commit => c !== null);
  if (commits.length === 0 || commits.length !== items.length) return null;

  const args = isObject(input) ? input : {};
  const fromUrl = commits.map((c) => c.url?.match(COMMIT_URL)?.[1]).find(Boolean);
  const fromArgs = str(args.owner) && str(args.repo) ? `${args.owner}/${args.repo}` : undefined;
  return { repo: fromUrl ?? fromArgs, commits };
}

function toCommit(item: unknown): Commit | null {
  if (!isObject(item)) return null;
  const sha = str(item.sha);
  const meta = isObject(item.commit) ? item.commit : item;
  const message = str(meta.message);
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha) || !message) return null;

  const [subject, ...rest] = message.trim().split("\n");
  const gitAuthor = isObject(meta.author) ? meta.author : {};
  const user = isObject(item.author) ? item.author : {};
  const name = str(gitAuthor.name) ?? str(user.login);
  const stats = isObject(item.stats) ? item.stats : {};

  return {
    sha,
    url: str(item.html_url),
    subject: subject.trim(),
    body: rest.join("\n").trim() || undefined,
    author: name ? { name, login: str(user.login), avatarUrl: str(user.avatar_url) } : undefined,
    date: str(gitAuthor.date) ?? (isObject(meta.committer) ? str(meta.committer.date) : undefined),
    additions: num(stats.additions),
    deletions: num(stats.deletions),
    files: Array.isArray(item.files)
      ? item.files.filter(isObject).flatMap((f) => {
          const path = str(f.filename);
          return path ? [{ path, status: str(f.status), additions: num(f.additions), deletions: num(f.deletions) }] : [];
        })
      : undefined,
  };
}

/** "3h ago", "2d ago", or the date when it's older than a month. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const s = Math.round((now - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
