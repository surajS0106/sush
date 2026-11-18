// The model's tools for the user's reports (`lib/reports.ts`): the Security, Review
// and Wiki pages' security reviews, code reviews and codebase wikis of a Cowork folder.
//
//   reports_list   runs at once: reports with status, summary and finding counts
//   reports_read   runs at once: a review's findings, or a wiki's pages (one page in full)
//   reports_start  starts a review or wiki (a read-only run of its own); asks with a card
//
// Named `reports_*` so they never clash with `report_findings`, the tool a report's own run records with.

import type { AppToolset, Args, PlanResult, ToolContext, ToolResult } from "@/lib/app-tool-kit";
import { clip, day, findBy, str } from "@/lib/app-tool-kit";
import { getReports, githubConnected, KIND_LABEL, startReport } from "@/lib/reports";
import { getConversations } from "@/lib/store";
import type { Report, ReportKind, ReportScope, Severity, ToolSpec } from "@/lib/tauri";
import { getWorkspaces, loadGitInfo } from "@/lib/workspaces";

export const REPORTS_LIST = "reports_list";
export const REPORTS_READ = "reports_read";
export const REPORTS_START = "reports_start";

const KINDS: ReportKind[] = ["security", "review", "wiki"];
const SCOPE_TYPES = ["project", "uncommitted", "branch", "pull-request"] as const;
/** Which scopes each kind offers, as on the Security, Review and Wiki pages. */
const SCOPES: Record<ReportKind, readonly string[]> = {
  security: ["project", "uncommitted", "branch"],
  review: ["uncommitted", "branch", "pull-request"],
  wiki: ["project"],
};
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

const listTool: ToolSpec = {
  name: REPORTS_LIST,
  description:
    "List the user's security reviews, code reviews and codebase wikis in Sush (the Security, Review and Wiki pages), each of a " +
    "Cowork folder, with status, summary and finding counts. Use it when they ask about a review's results or a wiki.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: KINDS },
      folder: { type: "string", description: "Only reports of this Cowork folder (its name)." },
    },
  },
};

const readTool: ToolSpec = {
  name: REPORTS_READ,
  description:
    "Read one report: a security or code review's summary and findings, or a wiki's page list. Pass `page` (a slug) to read a wiki page in full.",
  inputSchema: {
    type: "object",
    properties: {
      report: { type: "string", description: "Its id from reports_list." },
      severity: { type: "string", enum: SEVERITIES, description: "Only findings of this severity or worse." },
      page: { type: "string", description: "A wiki page's slug." },
    },
    required: ["report"],
  },
};

const startTool: ToolSpec = {
  name: REPORTS_START,
  description:
    "Start a security review, code review or codebase wiki of a Cowork folder. It runs on its own, read-only, and its results " +
    "appear on the Security, Review or Wiki page. Scopes: security (project, uncommitted, branch), review (uncommitted, branch, " +
    "pull-request), wiki (project). The user approves it.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: KINDS },
      folder: { type: "string", description: "The Cowork folder's name; defaults to this session's folder." },
      scope: { type: "string", enum: [...SCOPE_TYPES], description: "Defaults to the kind's first scope." },
      base: { type: "string", description: "For branch: the branch to compare with (defaults to main or master)." },
      pullRequest: { type: "string", description: "For pull-request: owner/repo#123 or its GitHub URL." },
    },
    required: ["kind"],
  },
};

const folderName = (id: string) => getWorkspaces().find((w) => w.id === id)?.name ?? "a removed folder";

function counts(r: Report) {
  const c: Partial<Record<Severity, number>> = {};
  for (const f of r.findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}

function brief(r: Report) {
  return {
    id: r.id,
    kind: KIND_LABEL[r.kind],
    title: r.title,
    folder: folderName(r.workspaceId),
    status: r.status,
    updated: day(r.updatedAt),
    ...(r.summary ? { summary: clip(r.summary, 400) } : {}),
    ...(r.kind === "wiki" ? { pages: r.pages.length } : { findings: counts(r) }),
    ...(r.error ? { error: r.error } : {}),
  };
}

async function read(name: string, args: Args): Promise<ToolResult> {
  const all = getReports();
  if (name === REPORTS_LIST) {
    const kind = str(args.kind) as ReportKind | undefined;
    const folder = str(args.folder)?.toLowerCase();
    const found = all
      .filter((r) => !kind || r.kind === kind)
      .filter((r) => !folder || folderName(r.workspaceId).toLowerCase() === folder)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { output: JSON.stringify({ reports: found.slice(0, 40).map(brief), ...(found.length === 0 ? { note: "No reports match. Start one with reports_start." } : {}) }) };
  }
  const found = findBy(all, str(args.report), (r) => r.title, "report", REPORTS_LIST);
  if (!found.ok) return { errorText: found.error };
  const r = found.item;
  if (r.kind === "wiki") {
    const slug = str(args.page);
    if (slug) {
      const page = r.pages.find((p) => p.slug === slug || p.title.toLowerCase() === slug.toLowerCase());
      if (!page) return { errorText: `No page "${slug}". Pages: ${r.pages.map((p) => p.slug).join(", ")}.` };
      return { output: `# ${page.title}\n\n${clip(page.content, 20000)}` };
    }
    return { output: JSON.stringify({ ...brief(r), pages: r.pages.map((p) => ({ slug: p.slug, title: p.title })) }) };
  }
  const worst = str(args.severity) as Severity | undefined;
  const cut = worst ? SEVERITIES.indexOf(worst) : SEVERITIES.length - 1;
  const findings = r.findings.filter((f) => SEVERITIES.indexOf(f.severity) <= cut).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return {
    output: JSON.stringify({
      ...brief(r),
      summary: r.summary,
      findings: findings.slice(0, 50).map((f) => ({
        severity: f.severity,
        title: f.title,
        ...(f.file ? { where: f.line ? `${f.file}:${f.line}` : f.file } : {}),
        description: clip(f.description, 1200),
        ...(f.suggestion ? { suggestion: clip(f.suggestion, 800) } : {}),
      })),
      ...(findings.length > 50 ? { more: findings.length - 50 } : {}),
    }),
  };
}

function parsePullRequest(text: string): { repo: string; number: number } | null {
  const t = text.trim();
  const m = t.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) ?? t.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

async function plan(_name: string, args: Args, ctx: ToolContext): Promise<PlanResult> {
  const kind = str(args.kind) as ReportKind;
  if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}.` };
  const folders = getWorkspaces();
  const ref = str(args.folder);
  const here = ctx.threadId ? getConversations().find((c) => c.id === ctx.threadId)?.workspaceId : undefined;
  const folder = ref
    ? folders.find((w) => w.name.toLowerCase() === ref.toLowerCase() || w.id === ref)
    : folders.find((w) => w.id === here);
  if (!folder) {
    return { error: `${ref ? `No Cowork folder "${ref}".` : "Say which Cowork folder."} Folders: ${folders.map((w) => w.name).join(", ") || "none; the user adds one from the folder chip"}.` };
  }
  const type = str(args.scope) ?? SCOPES[kind][0];
  if (!SCOPES[kind].includes(type)) return { error: `A ${KIND_LABEL[kind].toLowerCase()} covers ${SCOPES[kind].join(", ")}, not ${type}.` };

  let scope: ReportScope;
  let covers: string;
  if (type === "project") {
    scope = { type: "project" };
    covers = "The whole project";
  } else if (type === "pull-request") {
    if (!githubConnected()) return { error: "Reviewing a pull request needs the GitHub connector; ask the user to connect it in Settings → Connectors." };
    const pr = parsePullRequest(str(args.pullRequest) ?? "");
    if (!pr) return { error: "Pass `pullRequest` as owner/repo#123 or its GitHub URL." };
    scope = { type: "pull-request", ...pr };
    covers = `Pull request ${pr.repo}#${pr.number}`;
  } else {
    const git = await loadGitInfo(folder.id);
    if (!git) return { error: `"${folder.name}" isn't a git repository, so only the whole project can be reviewed.` };
    if (type === "uncommitted") {
      scope = { type: "uncommitted" };
      covers = "Uncommitted changes";
    } else {
      const others = git.branches.filter((b) => b !== git.branch);
      const base = str(args.base) ?? others.find((b) => b === "main" || b === "master") ?? others[0];
      if (!base || !others.includes(base)) return { error: `No branch "${base ?? ""}" to compare with. Branches: ${others.join(", ") || "none"}.` };
      scope = { type: "branch", base };
      covers = `${git.branch ?? "This branch"} since ${base}`;
    }
  }

  return {
    title: `Start a ${KIND_LABEL[kind].toLowerCase()} of “${folder.name}”?`,
    rows: [
      { label: "Covers", value: covers },
      { label: "Runs", value: "Read-only, on its own; it uses your model" },
    ],
    confirm: "Start",
    apply: async () => {
      const report = await startReport(kind, folder.id, scope);
      if (!report) return { errorText: "It couldn't start; the app showed the user why." };
      const page = kind === "security" ? "Security" : kind === "review" ? "Review" : "Wiki";
      return { output: `Started a ${KIND_LABEL[kind].toLowerCase()} of "${folder.name}" (report ${report.id}). It runs on its own; results appear on the ${page} page, and reports_read reads them once it's done.` };
    },
  };
}

export const reportToolset: AppToolset = {
  id: "reports",
  noun: "your reviews and wikis",
  specs: [listTool, readTool, startTool],
  reads: new Set([REPORTS_LIST, REPORTS_READ]),
  read,
  plan,
};
