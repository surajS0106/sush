// Where "Compact now" summarised a conversation (`lib/compact.ts`): a divider
// in the transcript that opens to the summary the model reads from here on.

import { ChevronRightIcon, ShrinkIcon } from "lucide-react";
import { useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import type { SushUIMessage } from "@/lib/transport";
import { formatTokens } from "@/lib/usage";
import { cn } from "@/lib/utils";

export function CompactionDivider({ message }: { message: SushUIMessage }) {
  const [open, setOpen] = useState(false);
  const meta = message.metadata?.compaction;
  if (!meta) return null;
  const summary = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border hover:text-foreground"
      >
        <ShrinkIcon className="size-3.5 shrink-0" />
        <span>
          Conversation compacted
          {meta.tokensBefore ? <span className="tabular-nums"> · {formatTokens(meta.tokensBefore)} tokens summarised</span> : null}
        </span>
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-2 rounded-lg border bg-muted/30 p-3">
          <p className="mb-2 text-xs text-muted-foreground">The model reads this summary in place of everything above it.</p>
          <MessageResponse className="transcript-prose text-sm">{summary}</MessageResponse>
        </div>
      )}
    </div>
  );
}
