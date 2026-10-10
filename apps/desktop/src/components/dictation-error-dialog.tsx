// Shown when dictation can't transcribe: says why, and lets the user switch
// the speech provider/model and retry the same recording.

import { CircleAlertIcon } from "lucide-react";

import { SpeechFields } from "@/components/speech-section";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DictationFailure } from "@/hooks/use-dictation";
import { resolveSpeechTarget, useSpeechSettings } from "@/lib/speech";
import type { ProviderView } from "@/lib/tauri";

interface DictationErrorDialogProps {
  failure: DictationFailure | null;
  providers: ProviderView[];
  onRetry: () => void;
  onDismiss: () => void;
}

export function DictationErrorDialog({ failure, providers, onRetry, onDismiss }: DictationErrorDialogProps) {
  const settings = useSpeechSettings();
  const ready = resolveSpeechTarget(settings, providers) !== null;
  const hasAudio = !!failure?.audio;

  return (
    <Dialog open={failure !== null} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{hasAudio ? "Couldn't transcribe your recording" : "Set up dictation"}</DialogTitle>
          <DialogDescription>
            {hasAudio
              ? "Switch to a different speech model and try again. Your recording is kept, so you won't need to say it again."
              : "Choose the model that turns your speech into text."}
          </DialogDescription>
        </DialogHeader>
        {failure && (
          <div
            role="alert"
            className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words">{failure.message}</p>
          </div>
        )}
        <SpeechFields providers={providers} />
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            {hasAudio ? "Discard recording" : "Cancel"}
          </Button>
          <Button onClick={onRetry} disabled={!ready}>
            {hasAudio ? "Try again" : "Start dictating"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
