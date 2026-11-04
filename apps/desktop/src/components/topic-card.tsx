// The `topic_lookup` card: up to three photos, the rest a click away in a viewer, and a
// strip of the articles to read. `TopicPhotos` is also what the model places between
// the sections of its reply. A photo that won't load drops out of both views.

import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeftIcon, ChevronRightIcon, ImagesIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { hostname } from "@/lib/citations";
import type { TopicImage } from "@/lib/tauri";
import { PHOTOS_ON_CARD, type TopicOutput } from "@/lib/topic";
import { cn } from "@/lib/utils";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

function PhotoViewer({ images, title, at, onAt }: { images: TopicImage[]; title: string; at: number | null; onAt: (at: number | null) => void }) {
  const image = at === null ? undefined : images[at];
  const step = (by: number) => at !== null && onAt((at + by + images.length) % images.length);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  };
  return (
    <Dialog open={!!image} onOpenChange={(open) => !open && onAt(null)}>
      <DialogContent className="gap-3 sm:max-w-3xl" aria-describedby={undefined} onKeyDown={onKeyDown}>
        <DialogTitle className="pr-8">{title}</DialogTitle>
        {image && (
          <>
            <img src={image.full} alt={image.caption ?? `Photo of ${title}`} referrerPolicy="no-referrer" className="max-h-[64vh] w-full rounded-lg object-contain" />
            {image.caption && <p className="text-sm text-muted-foreground">{image.caption}</p>}
            <div className="flex items-center gap-2">
              <button type="button" className={cn("text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground", FOCUS_RING)} onClick={() => void openUrl(image.page)}>
                Credit and licence on Wikimedia
              </button>
              {images.length > 1 && (
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="icon" aria-label="Previous photo" onClick={() => step(-1)}>
                    <ChevronLeftIcon />
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                    {at! + 1} of {images.length}
                  </span>
                  <Button variant="ghost" size="icon" aria-label="Next photo" onClick={() => step(1)}>
                    <ChevronRightIcon />
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Up to three photos, opening a viewer of all of them. A lone photo shows its caption. */
export function TopicPhotos({ images, title }: { images: TopicImage[]; title: string }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [at, setAt] = useState<number | null>(null);
  const working = images.filter((image) => !failed.has(image.thumb));
  if (working.length === 0) return null;
  const shown = working.slice(0, PHOTOS_ON_CARD);
  const hidden = working.length - shown.length;
  const caption = working.length === 1 ? working[0].caption : null;
  return (
    <figure className="flex max-w-2xl flex-col gap-2">
      <div className={cn("grid h-72 grid-rows-2 gap-1 overflow-hidden rounded-xl", shown.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
        {shown.map((image, i) => (
          <button
            key={image.thumb}
            type="button"
            aria-label={hidden > 0 && i === shown.length - 1 ? `View ${working.length} photos of ${title}` : `View photo: ${image.caption ?? title}`}
            title={image.caption ?? undefined}
            onClick={() => setAt(i)}
            className={cn("group relative min-h-0 overflow-hidden bg-muted", shown.length < 3 || i === 0 ? "row-span-2" : "", "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand")}
          >
            <img
              src={image.thumb}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setFailed((prev) => new Set(prev).add(image.thumb))}
              className="absolute inset-0 size-full object-cover object-top transition-opacity group-hover:opacity-90"
            />
            {hidden > 0 && i === shown.length - 1 && (
              <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-xs font-medium text-white">
                <ImagesIcon className="size-3" aria-hidden />+{hidden}
              </span>
            )}
          </button>
        ))}
      </div>
      {caption && <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>}
      <PhotoViewer images={working} title={title} at={at} onAt={setAt} />
    </figure>
  );
}

function ArticleLink({ source, title, url }: { source: string; title: string; url: string }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(url)}
      className={cn("flex w-52 shrink-0 flex-col gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent", FOCUS_RING)}
    >
      <span className="truncate text-xs text-muted-foreground">{source}</span>
      <span className="line-clamp-2 text-sm leading-snug text-foreground">{title}</span>
    </button>
  );
}

export function TopicCard({ topic }: { topic: TopicOutput }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <TopicPhotos images={topic.cardOnly?.images ?? []} title={topic.title} />
      <div role="group" aria-label={`Articles about ${topic.title}`} className="flex gap-2 overflow-x-auto pb-1">
        <ArticleLink source="Wikipedia" title={topic.title} url={topic.url} />
        {topic.references.map((r) => (
          <ArticleLink key={r.url} source={r.publisher ?? hostname(r.url)} title={r.title} url={r.url} />
        ))}
      </div>
    </div>
  );
}
