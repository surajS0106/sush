// The Wiki page: a wiki of a Cowork folder's codebase that Sush writes by
// reading it (overview, architecture, modules, key flows, how to run it),
// browsable page by page, regenerated when the code changes, with questions
// about the code answered below it (`lib/reports.ts`).

import { BookOpenIcon, CircleAlertIcon, CircleStopIcon, MessageSquareTextIcon, MoreHorizontalIcon, RotateCcwIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { CODE_LINKS, openCodeLinks, ReportsLayout, RunProgress, StateLabel, useReportWorkspace } from "@/components/reports-page";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatWhen } from "@/lib/automations";
import {
  askWiki,
  clearWikiQuestions,
  deleteReport,
  regenerateWiki,
  startReport,
  stopReport,
  useReportActivity,
  useReports,
  useReportState,
} from "@/lib/reports";
import { useSessionStatus, useThread } from "@/lib/sessions";
import type { Report, WikiPage as Page } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export function WikiPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [workspace, choose] = useReportWorkspace();
  // One wiki per folder; the newest if there were ever more.
  const wiki = useReports().find((r) => r.kind === "wiki" && r.workspaceId === workspace?.id);
  const [starting, setStarting] = useState(false);

  return (
    <ReportsLayout
      title="Wiki"
      description="A guide to a folder's codebase, written by reading it. Ask about the code below it."
      workspace={workspace}
      onChoose={choose}
      wide
    >
      {workspace &&
        (wiki ? (
          <Wiki key={wiki.id} report={wiki} onOpenSession={onOpenSession} />
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl border bg-card">
              <BookOpenIcon className="size-5 text-muted-foreground" />
            </span>
            <div>
              <p className="font-medium">No wiki for {workspace.name} yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Sush reads the code and writes an overview, the architecture, a page per module, the key flows and how to run
                it, citing the files. It doesn't change anything.
              </p>
            </div>
            <Button
              className="mt-1"
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                await startReport("wiki", workspace.id, { type: "project" });
                setStarting(false);
              }}
            >
              {starting ? <Spinner /> : <BookOpenIcon />} Generate wiki
            </Button>
          </div>
        ))}
    </ReportsLayout>
  );
}

/** The `##`/`###` headings of a page's markdown, outside code blocks, for its table of contents. */
function headings(markdown: string): { level: number; text: string }[] {
  let fenced = false;
  const out: { level: number; text: string }[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[`*_]/g, "") });
  }
  return out;
}

/** A page's markdown without a leading heading that repeats its title (shown above it already). */
function withoutTitle(page: Page): string {
  const norm = (s: string) => s.replace(/[`*_]/g, "").trim().toLowerCase();
  const m = page.content.match(/^\s*#{1,3}\s+(.+?)\s*#*\s*(?:\n|$)/);
  return m && norm(m[1]) === norm(page.title) ? page.content.slice(m[0].length) : page.content;
}

function Wiki({ report, onOpenSession }: { report: Report; onOpenSession: (id: string) => void }) {
  const state = useReportState(report);
  const busy = state === "running" || state === "needs-input";
  const [slug, setSlug] = useState<string | null>(null);
  const page: Page | undefined = report.pages.find((p) => p.slug === slug) ?? report.pages[0];
  const body = useRef<HTMLDivElement>(null);
  const links = openCodeLinks(report.workspaceId, onOpenSession);

  const show = (next: string) => {
    setSlug(next);
    body.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const jumpTo = (text: string) => {
    const el = [...(body.current?.querySelectorAll("h2, h3") ?? [])].find((h) => h.textContent?.trim() === text);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {report.pages.length > 0 && (
            <span>
              {busy ? "Last generated" : "Generated"} {formatWhen(new Date(busy ? report.runStartedAt : report.updatedAt))}
            </span>
          )}
          {report.commit && <span className="font-mono text-xs">{report.commit.slice(0, 7)}</span>}
          <StateLabel state={state} className={cn(state === "done" && "sr-only")} />
        </p>
        {busy ? (
          <Button variant="outline" size="sm" onClick={() => stopReport(report)}>
            <CircleStopIcon /> Stop
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void regenerateWiki(report)}>
            <RotateCcwIcon /> Regenerate
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Wiki options">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => onOpenSession(report.threadId)}>
              <MessageSquareTextIcon /> View transcript
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void deleteReport(report)}>
              <Trash2Icon /> Delete wiki
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-4 grid gap-4">
        <RunProgress report={report} state={state} onOpenSession={onOpenSession} />
        {state === "failed" && (
          <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" /> {report.error ?? "Generating the wiki stopped with an error."}
          </p>
        )}
        {!busy && report.pages.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No pages were written. Regenerate it, or open its transcript to see how far it got.
          </p>
        )}
      </div>

      {page && (
        <div className="mt-6 grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
          <nav aria-label="Wiki pages" className="min-w-0 md:sticky md:top-4 md:self-start">
            <ul className="flex flex-col gap-0.5 text-sm">
              {report.pages.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    onClick={() => show(p.slug)}
                    aria-current={p.slug === page.slug ? "page" : undefined}
                    title={p.title}
                    className={cn(
                      "w-full truncate rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                      p.slug === page.slug ? "bg-muted font-medium" : "text-muted-foreground",
                    )}
                  >
                    {p.title}
                  </button>
                  {p.slug === page.slug && (
                    <ul className="my-1 ml-2 flex flex-col border-l pl-2">
                      {headings(withoutTitle(p)).map((h, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            onClick={() => jumpTo(h.text)}
                            title={h.text}
                            className={cn(
                              "w-full truncate rounded px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground",
                              h.level === 3 && "pl-4",
                            )}
                          >
                            {h.text}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </nav>
          <article ref={body} className="min-w-0 scroll-mt-4">
            <h2 className="text-2xl font-semibold tracking-tight">{page.title}</h2>
            <div className={cn("mt-4 text-[15px] leading-relaxed", CODE_LINKS)} onClick={links}>
              <MessageResponse>{withoutTitle(page)}</MessageResponse>
            </div>
          </article>
        </div>
      )}

      {report.pages.length > 0 && <Questions report={report} onOpenSession={onOpenSession} />}
    </div>
  );
}

/** Ask about the codebase; answers read the code and cite files, which open in the viewer. */
function Questions({ report, onOpenSession }: { report: Report; onOpenSession: (id: string) => void }) {
  const threadId = report.askThreadId ?? "";
  const { messages, error } = useThread(threadId);
  const status = useSessionStatus(threadId);
  const { now } = useReportActivity(threadId);
  const [draft, setDraft] = useState("");
  const links = openCodeLinks(report.workspaceId, onOpenSession);
  const working = !!report.askThreadId && status === "working";

  const ask = () => {
    const q = draft.trim();
    if (!q || working) return;
    setDraft("");
    void askWiki(report, q);
  };

  return (
    <section aria-labelledby="wiki-questions" className="mt-12 border-t pt-8">
      <div className="flex items-center gap-2">
        <h2 id="wiki-questions" className="flex-1 font-medium">
          Ask about the code
        </h2>
        {report.askThreadId && (
          <>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onOpenSession(threadId)}>
              Open as a session
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={working} onClick={() => void clearWikiQuestions(report)}>
              Clear
            </Button>
          </>
        )}
      </div>
      <div className="mt-4 grid gap-5">
        {messages.map((m) => {
          const text = m.parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n\n");
          if (!text) return null;
          return m.role === "user" ? (
            <p key={m.id} className="ml-auto max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-sm whitespace-pre-wrap">
              {text}
            </p>
          ) : (
            <div key={m.id} className={cn("text-sm", CODE_LINKS)} onClick={links}>
              <MessageResponse>{text}</MessageResponse>
            </div>
          );
        })}
        {working && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner /> {now}
          </p>
        )}
        {status === "needs-input" && (
          <p className="text-sm text-muted-foreground">
            It's waiting for your approval to read a file.{" "}
            <button type="button" className="underline" onClick={() => onOpenSession(threadId)}>
              Review the request
            </button>
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <form
        className="relative mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder="Where is authentication handled? How does a request reach the database?"
          aria-label="Ask about the code"
          className="min-h-20 resize-none pr-12"
        />
        <Button type="submit" size="icon-sm" className="absolute right-2 bottom-2" aria-label="Ask" disabled={!draft.trim() || working}>
          <SendIcon />
        </Button>
      </form>
    </section>
  );
}
