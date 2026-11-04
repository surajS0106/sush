// The `map_show` card: a live Google Map of a route or place, with its stops
// below, so nothing covers the map's own controls or attribution. A Google Maps
// key adds the travel time, distance, rating and whether the place is open.

import { openUrl } from "@tauri-apps/plugin-opener";
import { BikeIcon, CarIcon, ExternalLinkIcon, FootprintsIcon, MapPinIcon, MaximizeIcon, StarIcon, TrainFrontIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { isCoordinates, mapEmbedUrl, mapOpenUrl, type MapOutput, type TravelMode } from "@/lib/maps";
import { cn } from "@/lib/utils";

const MODES: Record<TravelMode, { label: string; icon: typeof CarIcon }> = {
  driving: { label: "Driving", icon: CarIcon },
  walking: { label: "Walking", icon: FootprintsIcon },
  bicycling: { label: "Cycling", icon: BikeIcon },
  transit: { label: "Transit", icon: TrainFrontIcon },
};

/** "Open now" only means something for a while after it was fetched; the card lives on in a saved chat. */
const OPEN_FRESH_MS = 60 * 60 * 1000;

/** Google's embed has no dark style, so a dark theme inverts it and turns the hues back. */
function MapFrame({ map, title, className }: { map: MapOutput; title: string; className?: string }) {
  return (
    <iframe
      src={mapEmbedUrl(map)}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      sandbox="allow-scripts allow-same-origin"
      className={cn("block border-0 dark:[filter:invert(0.92)_hue-rotate(180deg)]", className)}
    />
  );
}

function Stop({ marker, label, name, children }: { marker: ReactNode; label: string; name: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5 rounded-lg bg-muted/60 px-2.5 py-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-medium text-background">
        {marker}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate font-medium" title={name}>
          {name}
        </p>
        {children}
      </div>
    </div>
  );
}

/** ★ 4.1 (120) · Wedding venue · Open */
function PlaceFacts({ map }: { map: MapOutput }) {
  const place = map.details?.place;
  if (!place) return null;
  const fresh = map.fetchedAt !== undefined && Date.now() - map.fetchedAt < OPEN_FRESH_MS;
  const open = fresh ? place.openNow : null;
  if (place.rating === null && !place.kind && open === null) return null;
  return (
    <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
      {place.rating !== null && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <StarIcon className="size-3 fill-current" aria-hidden />
          {place.rating.toFixed(1)}
          {place.ratingCount !== null && ` (${place.ratingCount.toLocaleString()})`}
        </span>
      )}
      {place.kind && <span className="truncate">{place.rating !== null && "· "}{place.kind}</span>}
      {open !== null && (
        <span className={cn("shrink-0", open ? "text-emerald-500" : "text-destructive")}>
          {(place.rating !== null || place.kind) && "· "}
          {open ? "Open" : "Closed"}
        </span>
      )}
    </p>
  );
}

export function MapCard({ map }: { map: MapOutput }) {
  const [expanded, setExpanded] = useState(false);
  const start = map.origin && isCoordinates(map.origin) ? "Your location" : map.origin;
  const name = map.details?.place?.name ?? map.destination;
  const title = start ? `Directions from ${start} to ${name}` : `Map of ${name}`;
  const mode = MODES[map.mode] ?? MODES.driving;
  const route = map.details?.route;
  const trip = [mode.label, route?.duration, route?.distance].filter(Boolean).join(" · ");
  return (
    <figure className="w-full max-w-3xl overflow-hidden rounded-xl border bg-card text-sm">
      <MapFrame map={map} title={title} className="aspect-[16/10] w-full" />
      <figcaption className="flex flex-wrap items-center gap-2 p-2">
        {start ? (
          <>
            <Stop marker="1" label="Start" name={start} />
            <Stop marker="2" label={trip} name={name}>
              <PlaceFacts map={map} />
            </Stop>
          </>
        ) : (
          <Stop marker={<MapPinIcon className="size-3.5" />} label="Place" name={name}>
            <PlaceFacts map={map} />
          </Stop>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {start && <mode.icon className="mx-1.5 size-4 text-muted-foreground" aria-hidden />}
          <Button variant="ghost" size="icon-sm" aria-label="Expand map" title="Expand map" onClick={() => setExpanded(true)}>
            <MaximizeIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open in Google Maps"
            title="Open in Google Maps"
            onClick={() => void openUrl(mapOpenUrl(map))}
          >
            <ExternalLinkIcon />
          </Button>
        </div>
        {map.details?.error && (
          <p className="w-full px-1 text-xs text-muted-foreground" title={map.details.error}>
            Some details couldn't load. Check your key in Settings → Maps.
          </p>
        )}
      </figcaption>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent aria-describedby={undefined} className="h-[90vh] w-[90vw] max-w-none grid-rows-[auto_minmax(0,1fr)] sm:max-w-none">
          <DialogTitle className="truncate pr-8">{title}</DialogTitle>
          <MapFrame map={map} title={title} className="size-full rounded-md" />
        </DialogContent>
      </Dialog>
    </figure>
  );
}
