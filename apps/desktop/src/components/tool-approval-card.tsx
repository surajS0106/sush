// Approve or deny a connector tool call before it runs, or review a skill Sush
// drafted before it's saved. Same card language as AskUserCard: one card, the
// request as the heading, pill actions in the footer.

import { ChevronRightIcon, PlugIcon, ScrollTextIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ToolApprovalCardProps {
  connector: string;
  tool: string;
  description?: string | null;
  input: unknown;
  onAllow: (always: boolean) => void;
  onDeny: () => void;
}

export function ToolApprovalCard({ connector, tool, description, input, onAllow, onDeny }: ToolApprovalCardProps) {
  const args = Object.entries((input ?? {}) as Record<string, unknown>);
  return (
    <div className="w-full max-w-md">
      <div
        className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm"
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className="flex gap-3 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <PlugIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              Allow {connector} to run <code className="rounded bg-muted px-1 py-0.5 text-[13px]">{tool}</code>?
            </div>
            {description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>}
            {args.length > 0 && (
              <dl className="mt-2.5 space-y-1 rounded-lg bg-muted/60 p-2 font-mono text-xs">
                {args.map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-all whitespace-pre-wrap">
                      {truncate(typeof v === "string" ? v : JSON.stringify(v), 600)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 border-t p-2.5">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onDeny}>
            Deny
          </Button>
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => onAllow(true)}>
            Always allow
          </Button>
          <Button size="sm" className="rounded-full" onClick={() => onAllow(false)}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}

interface SkillSaveCardProps {
  name: string;
  command: string;
  description: string;
  instructions: string;
  /** Name of the skill this overwrites, if any. */
  replaces?: string;
  onSave: () => void;
  onDiscard: () => void;
}

export function SkillSaveCard({ name, command, description, instructions, replaces, onSave, onDiscard }: SkillSaveCardProps) {
  return (
    <div className="w-full max-w-xl">
      <div
        className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm"
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className="flex gap-3 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ScrollTextIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {replaces ? `Update the skill “${replaces}”?` : "Save this skill?"}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{name}</span> ·{" "}
              <code className="rounded bg-muted px-1 py-0.5">/{command}</code>
              {description && ` · ${description}`}
            </p>
            <pre className="mt-2.5 max-h-72 overflow-auto rounded-lg bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap">
              {instructions}
            </pre>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 border-t p-2.5">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" className="rounded-full" onClick={onSave}>
            {replaces ? "Update skill" : "Save skill"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A finished tool call: one line, expandable to the result. */
export function ToolResultRow({
  label,
  detail,
  error,
}: {
  label: React.ReactNode;
  detail?: string;
  error?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm">
      <button
        type="button"
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground transition-colors enabled:hover:text-foreground",
          error && "text-destructive enabled:hover:text-destructive",
        )}
      >
        {label}
        {detail && <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />}
      </button>
      {open && detail && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted/60 p-2.5 text-xs whitespace-pre-wrap">
          {truncate(detail, 8000)}
        </pre>
      )}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
