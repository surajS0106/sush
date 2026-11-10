// How the workflow tools (`lib/workflow-tools.ts`) show in a chat: listing as
// one line, starting a workflow as a card to approve (it may change things).

import type { DynamicToolUIPart } from "ai";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { ToolResultRow } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { runsWithoutApproval, type ToolResult } from "@/lib/agent";
import { startFromChat, WORKFLOW_LIST } from "@/lib/workflow-tools";
import { getWorkflows } from "@/lib/workflows";

const DECLINED = "The user chose not to start the workflow.";

export function WorkflowToolPart({
  part,
  canAnswer,
  onResult,
  running,
}: {
  part: DynamicToolUIPart;
  canAnswer: boolean;
  onResult: (result: ToolResult) => void;
  running: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const input = (part.input ?? {}) as { name?: string; input?: string };
  const row = (text: string, error?: boolean, detail?: string) => (
    <ToolResultRow
      error={error}
      detail={detail}
      label={
        <>
          <WorkflowIcon className="size-4 shrink-0" />
          <span className="line-clamp-1 text-left">{text}</span>
        </>
      }
    />
  );
  if (part.toolName === WORKFLOW_LIST) {
    if (part.state === "output-available") return row("Looked at your workflows", false, String(part.output));
    if (part.state === "output-error") return row("Couldn't list workflows", true, part.errorText);
    return <LoadingState label="Looking at your workflows" />;
  }
  if (part.state === "input-streaming") return <LoadingState label="Picking a workflow" />;
  if (part.state === "output-available") return row(`Started “${input.name}”`, false, String(part.output));
  if (part.state === "output-error") return row(part.errorText === DECLINED ? "Workflow not started" : "Couldn't start the workflow", part.errorText !== DECLINED, part.errorText);
  if (running || runsWithoutApproval(part.toolName)) return <LoadingState label="Starting the workflow" />;
  if (!canAnswer) return <p className="text-sm text-muted-foreground italic">Workflow wasn't started</p>;
  const known = getWorkflows().find((w) => w.name.toLowerCase() === (input.name ?? "").trim().toLowerCase());
  return (
    <div className="w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-sm" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="flex gap-3 p-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
          <WorkflowIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Start the workflow “{input.name}”?</p>
          {known?.description && <p className="mt-0.5 text-xs text-muted-foreground">{known.description}</p>}
          {input.input && <p className="mt-2 rounded-lg bg-muted/60 p-2 text-sm whitespace-pre-wrap">{input.input}</p>}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 border-t p-2">
        <Button variant="ghost" size="sm" className="rounded-full" disabled={busy} onClick={() => onResult({ errorText: DECLINED })}>
          Don't start
        </Button>
        <Button
          size="sm"
          className="rounded-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            onResult(await startFromChat(input as Record<string, unknown>));
          }}
        >
          Start it
        </Button>
      </div>
    </div>
  );
}
