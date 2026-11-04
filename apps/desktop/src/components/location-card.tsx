// The `location_get` card: nothing is read or sent until the user agrees. A saved
// address comes first, since a computer's own position can be far off.

import { LocateFixedIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { openSettings } from "@/lib/library";
import { readLocation, savedLocationOutput, useSavedLocation, type LocationOutput } from "@/lib/location";

export function LocationCard({ onShare, onDecline }: { onShare: (output: LocationOutput) => void; onDecline: () => void }) {
  const address = useSavedLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shareDevice = () => {
    setBusy(true);
    setError(null);
    readLocation().then(onShare, (e: Error) => {
      setBusy(false);
      setError(e.message);
    });
  };

  return (
    <div className="w-full max-w-xl">
      <div
        className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm"
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className="flex gap-3 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <LocateFixedIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Share your location?</div>
            {address && <p className="mt-0.5 truncate text-sm" title={address}>{address}</p>}
            <p className="mt-0.5 text-xs text-muted-foreground">
              It goes to this chat's model and is saved in the chat. A map of it also loads from Google.
            </p>
            {!address && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                A computer's position can be far off.{" "}
                <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => openSettings({ section: "maps" })}>
                  Save your address in Settings
                </Button>
              </p>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t p-2.5">
          <Button variant="ghost" size="sm" className="rounded-full" disabled={busy} onClick={onDecline}>
            {error ? "I'll type it" : "Not now"}
          </Button>
          <Button variant={address ? "outline" : "default"} size="sm" className="rounded-full" disabled={busy} onClick={shareDevice}>
            {busy ? "Finding you…" : error ? "Try again" : address ? "Use device location" : "Share device location"}
          </Button>
          {address && (
            <Button size="sm" className="rounded-full" disabled={busy} onClick={() => onShare(savedLocationOutput(address))}>
              Use saved address
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
