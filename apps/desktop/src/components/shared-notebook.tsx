// The Notebook tab of a guest's side panel, when the shared session is a
// notebook's chat: the notebook's sources (titles only) and its Studio
// outputs, and the passage a citation points at when the host shares
// sources. Every read is a request the host checks (`share.rs`,
// `policy::authorize`); the sources' text never arrives otherwise.

import { ArrowLeftIcon, CircleAlertIcon, LockIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AudioOverviewView } from "@/components/audio-overview";
import { KindIcon } from "@/components/notebook-sources";
import { FlashcardsView, MindMapView, QuizView } from "@/components/notebook-play";
import { NoteBody } from "@/components/notebook-studio";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { kindLabel } from "@/lib/notebook-studio";
import { closePassage, rememberGuestSources, useOpenPassage } from "@/lib/notebooks";
import {
  api,
  errorMessage,
  type FlashcardsData,
  type GuestNotebook,
  type GuestPassage,
  type MindMapData,
  type QuizData,
  type ShareView,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * The shared session's notebook, or null while unknown or if it isn't a
 * notebook's chat (the host refuses `get-notebook` then). Refreshed now and
 * then, so new Studio outputs show up.
 */
export function useGuestNotebook(share: ShareView): GuestNotebook | null {
  const [notebook, setNotebook] = useState<GuestNotebook | null>(null);
  const live = share.status === "live";
  useEffect(() => {
    if (!live) return;
    let on = true;
    const load = () =>
      api
        .shareRequest<GuestNotebook>(share.threadId, { kind: "get-notebook" })
        .then((n) => {
          if (!on) return;
          rememberGuestSources(n.sources);
          setNotebook(n);
        })
        .catch(() => on && setNotebook(null));
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [share.threadId, live]);
  return notebook;
}

export function SharedNotebookTab({ share, notebook }: { share: ShareView; notebook: GuestNotebook }) {
  const [outputId, setOutputId] = useState<string | null>(null);
  const passage = useOpenPassage();
  const output = notebook.outputs.find((o) => o.id === outputId);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
      {passage && passage.chunkId >= 0 ? (
        <PassageView share={share} url={`sushsrc:${passage.sourceId}/${passage.chunkId}`} at={passage.at} />
      ) : output ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <Button variant="ghost" size="icon-sm" aria-label="Back to the notebook" onClick={() => setOutputId(null)}>
              <ArrowLeftIcon />
            </Button>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{output.title}</p>
              <p className="text-xs text-muted-foreground">{kindLabel(output.kind)}</p>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <GuestOutput output={output} />
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <p className="flex items-center gap-2 font-medium">
            {notebook.emoji && <span aria-hidden>{notebook.emoji}</span>}
            <span className="truncate">{notebook.title}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            A notebook shared with you. Answers cite its sources; {share.policy.showSources ? "open a citation to read the passage." : "the host keeps the sources’ text to themselves."}
          </p>

          <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">Sources</h3>
          <ul className="flex flex-col">
            {notebook.sources.map((s) => (
              <li key={s.id} className={cn("flex items-center gap-2 py-1 text-sm", !s.checked && "text-muted-foreground")}>
                <KindIcon kind={s.kind} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{s.title}</span>
                {!s.checked && <span className="shrink-0 text-xs">not in use</span>}
              </li>
            ))}
          </ul>

          {notebook.outputs.length > 0 && (
            <>
              <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">Made in Studio</h3>
              <ul className="-mx-2 flex flex-col">
                {notebook.outputs.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => setOutputId(o.id)} className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-muted/60">
                      <span className="block truncate text-sm">{o.title}</span>
                      <span className="block text-xs text-muted-foreground">{kindLabel(o.kind)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function GuestOutput({ output }: { output: GuestNotebook["outputs"][number] }) {
  const notDriving = useCallback(() => toast("Ask it in the chat", { description: "Only whoever is driving can send messages." }), []);
  if (output.kind === "quiz" && output.data) return <QuizView data={output.data as QuizData} />;
  if (output.kind === "flashcards" && output.data) return <FlashcardsView data={output.data as FlashcardsData} />;
  if (output.kind === "mind-map" && output.data) return <MindMapView data={output.data as MindMapData} onAsk={notDriving} title={output.title} />;
  if (output.kind === "audio-overview" && output.data) return <AudioOverviewView note={{ id: output.id, data: output.data }} guest />;
  return <NoteBody body={output.body} id={output.id} />;
}

/** A cited passage, asked of the host. Refused unless the host shares sources. */
function PassageView({ share, url, at }: { share: ShareView; url: string; at: number }) {
  const [passage, setPassage] = useState<GuestPassage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let on = true;
    setPassage(null);
    setError(null);
    api
      .shareRequest<GuestPassage>(share.threadId, { kind: "get-passage", url })
      .then((p) => on && setPassage(p))
      .catch((e) => on && setError(errorMessage(e)));
    return () => {
      on = false;
    };
  }, [share.threadId, url, at, tries]);

  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        {passage && <KindIcon kind={passage.kind} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium">{passage?.sourceTitle ?? "Cited passage"}</p>
          {passage && (passage.page || passage.heading) && (
            <p className="text-xs text-muted-foreground">{[passage.page && `Page ${passage.page}`, passage.heading].filter(Boolean).join(" · ")}</p>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close the passage" onClick={closePassage}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <p className="flex items-start gap-2">
              {share.policy.showSources ? <CircleAlertIcon className="mt-0.5 size-4 shrink-0" /> : <LockIcon className="mt-0.5 size-4 shrink-0" />}
              {error}
            </p>
            {share.policy.showSources && (
              <Button variant="outline" size="sm" onClick={() => setTries((t) => t + 1)}>
                <RotateCcwIcon /> Try again
              </Button>
            )}
          </div>
        ) : !passage ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <p className="rounded-lg bg-brand/5 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ring-1 ring-brand/30">{passage.text}</p>
        )}
      </div>
    </>
  );
}
