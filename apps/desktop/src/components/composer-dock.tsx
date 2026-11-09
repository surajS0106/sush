// The strip tucked under the composer: the connected apps on the right (or a nudge to connect
// some), and, in an untouched plain chat, a way to start working in a folder on the left.

import { ChevronDownIcon, FolderIcon } from "lucide-react";

import { ConnectorMark } from "@/components/composer-menu";
import { FolderMenu } from "@/components/session-options";
import { availableConnectors, openSettings, useConnectors } from "@/lib/library";
import { useWorkspaces } from "@/lib/workspaces";
import { cn } from "@/lib/utils";

/** Shown as examples while nothing is connected. */
const SUGGESTED = ["notion", "github", "linear", "clickup"];
const SHOWN = 4;

const CHIP =
  "flex h-6 max-w-56 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-foreground/80 cursor-pointer transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-white/10";

export function ComposerDock({
  conversationId,
  workspaceId,
  started,
}: {
  conversationId?: string;
  workspaceId?: string;
  /** Once a session has messages its folder is fixed. */
  started: boolean;
}) {
  const workspaces = useWorkspaces();
  useConnectors();
  const current = workspaces.find((w) => w.id === workspaceId);
  const connected = availableConnectors().filter((c) => c.enabled);
  // Cowork already shows its folder above the composer; only a plain, untouched chat offers to pick one.
  const showFolder = !!conversationId && !current && !started;
  const marks = connected.length > 0 ? connected.slice(0, SHOWN).map((c) => ({ key: c.id, item: c })) : SUGGESTED.map((id) => ({ key: id, item: { id } }));

  return (
    <div className="relative -mt-3 mr-1 ml-1 flex items-center justify-between gap-3 rounded-b-2xl border border-t-0 border-foreground/15 bg-card px-2 pt-4 pb-1.5 dark:border-white/15 dark:bg-card">
      {showFolder && (
        <FolderMenu conversationId={conversationId} workspaceId={workspaceId}>
          <button type="button" className={CHIP}>
            <FolderIcon className="size-3.5 shrink-0 text-sky-500" />
            <span className="truncate">Work in a folder</span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </button>
        </FolderMenu>
      )}
      <button type="button" className={cn(CHIP, "ml-auto gap-2")} onClick={() => openSettings({ section: "connectors" })}>
        <span>{connected.length > 0 ? `${connected.length} connected` : "Connect apps"}</span>
        <span className="flex items-center gap-1.5 text-foreground">
          {marks.map((m) => (
            <ConnectorMark key={m.key} connector={m.item} className="size-3.5" />
          ))}
        </span>
      </button>
    </div>
  );
}
