// Shown when dictation would go to Yammer but it isn't installed or set up
// yet: walks through getting it, notices by itself once it's ready, and
// offers Sush's own dictation instead.

import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckIcon, DownloadIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hotkeyLabel, setSpeechSettings, YAMMER_DOWNLOAD_URL } from "@/lib/speech";
import { api, errorMessage, type YammerStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** How often to look for Yammer while the dialog waits for it. */
const POLL_MS = 2000;

/** Re-read Yammer's status every few seconds while `active`. */
export function useYammerStatus(active: boolean, initial: YammerStatus | null = null) {
  const [status, setStatus] = useState<YammerStatus | null>(initial);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const check = () => api.yammerStatus().then((s) => live && setStatus(s)).catch(() => {});
    void check();
    const id = setInterval(check, POLL_MS);
    window.addEventListener("focus", check);
    return () => {
      live = false;
      clearInterval(id);
      window.removeEventListener("focus", check);
    };
  }, [active]);
  return status;
}

export const openYammer = () => api.yammerOpen().catch((e) => toast.error(errorMessage(e)));

function Step({ n, done, active, title, children }: { n: number; done: boolean; active: boolean; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
          done ? "border-brand bg-brand text-brand-foreground" : active ? "border-brand text-brand" : "text-muted-foreground",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div className={cn("min-w-0 flex-1", !done && !active && "text-muted-foreground")}>
        <p className="text-sm font-medium">{title}</p>
        {active && children && <div className="mt-1.5 text-sm text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

interface YammerSetupDialogProps {
  /** Yammer's status when dictation was asked for; null keeps the dialog closed. */
  status: YammerStatus | null;
  /** `dictate`: go on to dictate now. */
  onClose: (dictate?: boolean) => void;
}

export function YammerSetupDialog({ status: initial, onClose }: YammerSetupDialogProps) {
  const open = initial !== null;
  const status = useYammerStatus(open, initial) ?? initial;
  const installed = !!status?.installed;
  const ready = installed && !!status?.onboarded;

  const useSush = () => {
    setSpeechSettings({ engine: "sush" });
    onClose(true);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ready ? "Yammer is ready" : "Dictate with Yammer"}</DialogTitle>
          <DialogDescription>
            Yammer is Sush's dictation app. It transcribes on your computer, tidies up the "um"s, and works in every
            app, not only here. Sush's mic button and Ctrl+D hand off to it.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-4 py-1">
          <Step n={1} done={installed} active={!installed} title="Download and install Yammer">
            <p>Free for Windows, macOS and Linux.</p>
            <Button size="sm" className="mt-2" onClick={() => void openUrl(YAMMER_DOWNLOAD_URL)}>
              <DownloadIcon /> Download Yammer
            </Button>
          </Step>
          <Step n={2} done={ready} active={installed && !ready} title="Finish Yammer's setup">
            <p>Pick a speech model (Base is a good start) and allow the microphone{navigator.userAgent.includes("Mac") ? " and Accessibility, which Yammer needs to paste" : ""}.</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void openYammer()}>
              <ExternalLinkIcon /> Open Yammer
            </Button>
          </Step>
          <Step n={3} done={false} active={ready} title="Dictate">
            <p>
              Press the mic or Ctrl+D here, or {hotkeyLabel(status?.hotkey)} in any app. Yammer types what you say
              where your cursor is.
            </p>
          </Step>
        </ol>
        {!ready && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            {installed ? "Waiting for Yammer's setup to finish…" : "Waiting for Yammer to be installed…"}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={useSush} className="sm:mr-auto">
            Use Sush's built-in dictation
          </Button>
          {ready ? (
            <Button onClick={() => onClose(true)}>Start dictating</Button>
          ) : (
            <Button variant="outline" onClick={() => onClose()}>
              Not now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
