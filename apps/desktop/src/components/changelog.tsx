// What's new: release notes as a timeline (Settings → What's new), and a dialog
// shown once after an update with the releases since the last one seen.

import { ConfettiIcon } from "@phosphor-icons/react";
import { DownloadIcon } from "lucide-react";

import { Page, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  dismissWhatsNew,
  releasedUpTo,
  useAppVersion,
  useWhatsNew,
  type ChangeKind,
  type Release,
} from "@/lib/changelog";
import { openSettings } from "@/lib/library";
import { checkForUpdate, upgradeNow, useUpdate } from "@/lib/updater";
import { cn } from "@/lib/utils";

const KINDS: { kind: ChangeKind; label: string; className: string }[] = [
  { kind: "new", label: "New", className: "bg-brand/10 text-brand" },
  { kind: "improved", label: "Improved", className: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  { kind: "fixed", label: "Fixed", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
];

const formatDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" });

/** One release: version and date, its summary, then its changes grouped as New, Improved, Fixed. */
function ReleaseNotes({ release, current, last }: { release: Release; current: boolean; last: boolean }) {
  return (
    <article className={cn("relative pl-6", !last && "pb-8")}>
      {/* The timeline: a dot per release on a line that runs down to the next. */}
      {!last && <span className="absolute top-2 bottom-0 left-[5px] w-px bg-border" aria-hidden />}
      <span
        className={cn(
          "absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-background ring-1",
          current ? "bg-brand ring-brand" : "bg-muted ring-foreground/20",
        )}
        aria-hidden
      />
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-base font-semibold">v{release.version}</h3>
        <time dateTime={release.date} className="text-sm text-muted-foreground">
          {formatDate(release.date)}
        </time>
        {current && <span className="rounded-full bg-brand/10 px-2 text-xs font-medium leading-5 text-brand">Installed</span>}
      </header>
      {release.summary && <p className="mt-1 text-sm text-muted-foreground">{release.summary}</p>}
      <div className="mt-3 flex flex-col gap-3">
        {KINDS.map(({ kind, label, className }) => {
          const changes = release.changes.filter((c) => c.kind === kind);
          if (!changes.length) return null;
          return (
            <section key={kind} className="flex flex-col gap-1.5">
              <span className={cn("w-fit rounded-md px-1.5 text-xs font-medium leading-5", className)}>{label}</span>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground/60">
                {changes.map((c) => (
                  <li key={c.text}>{c.text}</li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </article>
  );
}

function Timeline({ releases, current }: { releases: Release[]; current: string | null }) {
  return (
    <div className="flex flex-col">
      {releases.map((r, i) => (
        <ReleaseNotes key={r.version} release={r} current={r.version === current} last={i === releases.length - 1} />
      ))}
    </div>
  );
}

/** The version row: what's installed, and checking for (or installing) a newer one. */
function VersionRow({ version }: { version: string | null }) {
  const update = useUpdate();
  const action =
    update.status === "available" ? (
      <Button size="sm" onClick={() => void upgradeNow()}>
        <DownloadIcon /> Upgrade to v{update.version}
      </Button>
    ) : update.status === "downloading" || update.status === "installing" ? (
      <Button size="sm" disabled>
        {update.status === "installing" ? "Installing…" : `Downloading${update.percent === null ? "…" : ` ${update.percent}%`}`}
      </Button>
    ) : (
      <Button variant="outline" size="sm" disabled={update.status === "checking"} onClick={() => void checkForUpdate()}>
        {update.status === "checking" ? "Checking…" : "Check for updates"}
      </Button>
    );
  return (
    <Setting title="Version" description={version ? `Sush v${version} is installed.` : undefined}>
      {action}
    </Setting>
  );
}

/** Settings → What's new. */
export function ChangelogSection() {
  const version = useAppVersion();
  return (
    <Page>
      <section>
        <h2 className="pb-2 text-base font-semibold">What's new</h2>
        <div className="border-b">
          <VersionRow version={version} />
        </div>
      </section>
      <Timeline releases={releasedUpTo(version)} current={version} />
    </Page>
  );
}

/** Shown once after an update moves to a newer version (`checkWhatsNew`). */
export function WhatsNewDialog() {
  const releases = useWhatsNew();
  const version = useAppVersion();
  return (
    <Dialog open={releases !== null} onOpenChange={(open) => !open && dismissWhatsNew()}>
      <DialogContent className="flex max-h-[min(640px,85vh)] flex-col gap-0 p-0 sm:max-w-lg">
        <div className="flex items-center gap-3 border-b px-6 pt-6 pb-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
            <ConfettiIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <DialogTitle>What's new in Sush{version ? ` v${version}` : ""}</DialogTitle>
            <DialogDescription>
              {releases && releases.length > 1 ? `${releases.length} releases since you last looked.` : "Here's what changed in this update."}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {releases && <Timeline releases={releases} current={version} />}
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dismissWhatsNew();
              openSettings({ section: "changelog" });
            }}
          >
            All releases
          </Button>
          <Button size="sm" onClick={dismissWhatsNew}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
