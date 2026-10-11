// The file viewer in Cowork's side panel, editable. A transparent textarea
// lies exactly over the highlighted code, so typing, selection and undo are
// the browser's own while shiki draws the colours underneath. Ctrl+S saves.
//
// Unsaved text lives in the drafts store (`workspaces.ts`), so it survives
// switching tabs; if the file changes on disk meanwhile (Sush edited it), a
// bar offers to reload.

import { CircleAlertIcon, FileIcon, SaveIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, errorMessage, type FileView } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { hasDraft, notifyWorkspaceChanged, setDraft, useDraft, useFilesVersion } from "@/lib/workspaces";

/** Shiki language ids by file extension (or whole file name). */
const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json",
  md: "markdown", rs: "rust", py: "python", go: "go", tf: "terraform", tfvars: "terraform", hcl: "hcl",
  yml: "yaml", yaml: "yaml", toml: "toml", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ps1: "powershell", psm1: "powershell", sql: "sql",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby",
  php: "php", lua: "lua", xml: "xml", graphql: "graphql", dockerfile: "dockerfile", makefile: "makefile",
};

export function langFor(path: string) {
  const name = path.split("/").pop()!.toLowerCase();
  return LANGS[name] ?? LANGS[name.split(".").pop() ?? ""] ?? "text";
}

/** Past this, the text is shown plain: highlighting runs on every keystroke. */
const HIGHLIGHT_LIMIT = 80_000;

type Highlighter = Awaited<ReturnType<(typeof import("shiki"))["createHighlighter"]>>;
let highlighter: Promise<Highlighter> | null = null;
const languages = new Map<string, Promise<void>>();

/** Shiki with `lang` loaded, or null if it doesn't know the language. */
async function highlighterFor(lang: string): Promise<Highlighter | null> {
  highlighter ??= import("shiki").then((s) => s.createHighlighter({ themes: ["github-light", "github-dark"], langs: [] }));
  const h = await highlighter;
  if (lang === "text" || h.getLoadedLanguages().includes(lang)) return h;
  if (!languages.has(lang)) languages.set(lang, h.loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0]));
  try {
    await languages.get(lang);
    return h;
  } catch {
    return null;
  }
}

/** Insert at the caret the way typing does, so the textarea's undo keeps working. */
function insert(text: string) {
  document.execCommand("insertText", false, text);
}

export function CodeEditor({ workspaceId, path }: { workspaceId: string; path: string }) {
  const version = useFilesVersion(workspaceId);
  const draft = useDraft(workspaceId, path);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caret, setCaret] = useState({ line: 1, col: 1 });
  const lastDisk = useRef<{ path: string; text: string | null } | null>(null);

  useEffect(() => {
    setFile(null);
    setChangedOnDisk(false);
    lastDisk.current = null;
    setCaret({ line: 1, col: 1 });
  }, [workspaceId, path]);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .workspaceReadFile(workspaceId, path)
      .then((f) => {
        if (!live) return;
        const prev = lastDisk.current;
        if (prev && prev.text !== f.text && hasDraft(workspaceId, path)) setChangedOnDisk(true);
        lastDisk.current = { path, text: f.text };
        setFile(f);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, path, version]);

  // A textarea's value always uses \n; keep the file's own line endings on save.
  const disk = useMemo(() => file?.text?.replace(/\r\n/g, "\n") ?? null, [file]);
  const eol = file?.text?.includes("\r\n") ? "\r\n" : "\n";
  const indent = useMemo(() => (disk && /^\t/m.test(disk) && !/^ {2}/m.test(disk) ? "\t" : "  "), [disk]);
  const editable = disk != null && !file?.truncated;
  const text = draft ?? disk ?? "";
  const dirty = draft !== undefined && disk != null && draft !== disk;

  // Typing back to what's on disk isn't an edit.
  useEffect(() => {
    if (draft !== undefined && disk != null && draft === disk) setDraft(workspaceId, path, undefined);
  }, [draft, disk, workspaceId, path]);

  const lang = langFor(path);
  const [hl, setHl] = useState<{ lang: string; h: Highlighter } | null>(null);
  useEffect(() => {
    let live = true;
    highlighterFor(lang)
      .then((h) => live && setHl(h ? { lang, h } : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lang]);

  const html = useMemo(() => {
    if (!hl || hl.lang !== lang || text.length > HIGHLIGHT_LIMIT) return null;
    try {
      return hl.h.codeToHtml(text, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: "light" });
    } catch {
      return null;
    }
  }, [hl, lang, text]);

  const save = async () => {
    if (!file || !dirty || saving) return;
    const saved = text;
    setSaving(true);
    try {
      const out = eol === "\n" ? saved : saved.replace(/\n/g, eol);
      await api.workspaceWriteFile(workspaceId, path, out);
      lastDisk.current = { path, text: out };
      setFile({ ...file, text: out, size: new TextEncoder().encode(out).length });
      setChangedOnDisk(false);
      notifyWorkspaceChanged(workspaceId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };

  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!e.shiftKey) {
        insert(indent);
        return;
      }
      // Shift+Tab: take one indent off the caret's line.
      const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const lead = ta.value.slice(start).match(/^(\t| {1,2})/)?.[0];
      if (!lead) return;
      const [s, end] = [ta.selectionStart, ta.selectionEnd];
      ta.setSelectionRange(start, start + lead.length);
      document.execCommand("delete");
      ta.setSelectionRange(Math.max(start, s - lead.length), Math.max(start, end - lead.length));
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
      // Keep the line's indentation.
      e.preventDefault();
      const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const lead = ta.value.slice(start, ta.selectionStart).match(/^[\t ]*/)![0];
      insert("\n" + lead);
    }
  };

  const trackCaret = (ta: HTMLTextAreaElement) => {
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split("\n").length;
    setCaret({ line, col: ta.selectionStart - before.lastIndexOf("\n") });
  };

  const crumbs = path.split("/");
  const plainLines = useMemo(() => (html ? [] : text.split("\n")), [html, text]);

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center truncate">
          {crumbs.map((c, i) => (
            <span key={i} className={cn("truncate", i === crumbs.length - 1 && "text-foreground")}>
              {i > 0 && <span className="mx-1 opacity-60">/</span>}
              {c}
            </span>
          ))}
        </div>
        {dirty && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => void save()} disabled={saving}>
            <SaveIcon className="size-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {changedOnDisk && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          <span className="flex-1">This file changed on disk while you were editing it.</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setDraft(workspaceId, path, undefined);
              setChangedOnDisk(false);
            }}
          >
            Reload
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setChangedOnDisk(false)}>
            Keep mine
          </Button>
        </div>
      )}
      <div className="code-view min-h-0 flex-1 overflow-auto text-[12.5px] leading-[1.55]">
        {error ? (
          <p className="p-4 font-sans text-sm text-destructive">{error}</p>
        ) : !file ? (
          <p className="p-4 font-sans text-sm text-muted-foreground">Loading…</p>
        ) : disk == null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 font-sans text-muted-foreground">
            <FileIcon className="size-7" />
            <p className="text-sm">Binary file · {file.size.toLocaleString()} bytes</p>
          </div>
        ) : (
          <div className="code-editor relative min-h-full w-max min-w-full">
            {html ? (
              <div aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <pre className="shiki" aria-hidden>
                <code>
                  {plainLines.map((line, i) => (
                    <span key={i}>
                      {i > 0 && "\n"}
                      <span className="line">{line}</span>
                    </span>
                  ))}
                </code>
              </pre>
            )}
            {editable && (
              <textarea
                value={text}
                onChange={(e) => {
                  setDraft(workspaceId, path, e.target.value);
                  trackCaret(e.target);
                }}
                onKeyDown={onEditorKey}
                onSelect={(e) => trackCaret(e.currentTarget)}
                aria-label={`Edit ${path}`}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                data-gramm="false"
              />
            )}
          </div>
        )}
      </div>
      {file && disk != null && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
          {file.truncated ? (
            <span>Read only: only the first 1 MB is shown</span>
          ) : (
            <span>
              Ln {caret.line}, Col {caret.col}
            </span>
          )}
          <span className="ml-auto">{indent === "\t" ? "Tabs" : "Spaces: 2"}</span>
          <span>{eol === "\r\n" ? "CRLF" : "LF"}</span>
          <span className="capitalize">{lang === "text" ? "Plain text" : lang}</span>
          <span className={cn(dirty && "text-amber-700 dark:text-amber-400")}>{dirty ? "Unsaved · Ctrl+S" : "Saved"}</span>
        </div>
      )}
    </div>
  );
}
