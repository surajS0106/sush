// The `map_show` tool: a Google Map in the chat, of a route or a place. The map
// itself needs no key: the card (`components/map-card.tsx`) loads it in an iframe,
// so it reaches Google only once the card is on screen. With the user's own key
// (Settings → Maps), Rust also fetches the trip and the place (`sush_core::maps`),
// for the card and the model. Without one, the model gets no route data.

import { api, errorMessage, type MapDetails, type ToolSpec, type TravelMode } from "@/lib/tauri";

export const MAP_SHOW = "map_show";

export type { TravelMode };

/** Google's old-style `dirflg` value for each mode. */
const DIRFLG: Record<TravelMode, string> = { driving: "d", walking: "w", bicycling: "b", transit: "r" };

const MAX_PLACE = 200;

export const mapTool: ToolSpec = {
  name: MAP_SHOW,
  description:
    "Show the user an interactive Google Map in the chat: a route between two places, or one place. Use it whenever " +
    "the user asks for directions, a route, how to get somewhere, where a place is, or to see a map. If they want " +
    "directions from where they are, get the start with location_get; if you don't know the start, ask; don't guess. " +
    "The map is shown right under the call. The result may hold `details` from Google (travel time, distance, rating, " +
    "open now). If it doesn't, you have no such figures, so don't state them as fact: call any figure a rough estimate " +
    "and point them to the map for the real one. Don't link to the map; the card has a link.",
  inputSchema: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "Where to go, or the place to show. Name it fully enough to be found, e.g. 'Adyar, Chennai'.",
      },
      origin: {
        type: "string",
        description: "Where the route starts, named the same way, or location_get's `place`. Leave it out to show just the destination.",
      },
      mode: {
        type: "string",
        enum: ["driving", "walking", "bicycling", "transit"],
        description: "How the user is travelling, for a route. Defaults to driving.",
      },
    },
    required: ["destination"],
  },
};

/** What the tool's output holds; the card renders it. */
export interface MapOutput {
  destination: string;
  origin?: string;
  mode: TravelMode;
  note: string;
  /** With a Google Maps key. */
  details?: MapDetails;
  /** When `details` was fetched, in ms: it goes stale in a saved chat. */
  fetchedAt?: number;
}

const NO_DETAILS = "The map is shown to the user. It gives you no distance, time or steps.";

function detailsNote(details: MapDetails) {
  const shown =
    "The map and these details are on the card the user sees, so don't repeat them at length. If `details.place` " +
    "isn't the place they meant, call map_show again with a fuller name.";
  return details.error ? `${shown} Some details are missing: ${details.error}` : shown;
}

export async function runMapShow(input: unknown): Promise<{ output: MapOutput } | { errorText: string }> {
  const { destination, origin, mode } = (input ?? {}) as { destination?: unknown; origin?: unknown; mode?: unknown };
  if (typeof destination !== "string" || !destination.trim()) return { errorText: "map_show needs a `destination`." };
  if (origin !== undefined && origin !== null && typeof origin !== "string") {
    return { errorText: "`origin` must be a place name, or left out." };
  }
  if (mode !== undefined && mode !== null && !Object.keys(DIRFLG).includes(mode as string)) {
    return { errorText: "`mode` must be driving, walking, bicycling or transit, or left out." };
  }
  const from = typeof origin === "string" ? origin.trim() || undefined : undefined;
  const to = destination.trim();
  if (to.length > MAX_PLACE || (from?.length ?? 0) > MAX_PLACE) {
    return { errorText: `Place names must be ${MAX_PLACE} characters or fewer.` };
  }
  const travel = (mode as TravelMode | null | undefined) ?? "driving";
  const map: MapOutput = { destination: to, origin: from, mode: travel, note: NO_DETAILS };
  // The map still works if the details don't.
  try {
    const details = await api.mapsDetails(from ?? null, to, travel);
    if (details) return { output: { ...map, details, fetchedAt: Date.now(), note: detailsNote(details) } };
  } catch (e) {
    return { output: { ...map, note: `${NO_DETAILS} Live details failed: ${errorMessage(e)}` } };
  }
  return { output: map };
}

/** A `latitude,longitude` place, as `location_get` gives it. */
export const isCoordinates = (place: string) => /^\s*-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?\s*$/.test(place);

/** The address Google matched, so the map shows the place the details are about. */
const target = (map: MapOutput) => map.details?.place?.address ?? map.destination;

/** The map for the iframe. Needs no API key; Google redirects it to its `/maps/embed` page. */
export function mapEmbedUrl(map: MapOutput) {
  const params: Record<string, string> = map.origin
    ? { saddr: map.origin, daddr: target(map), dirflg: DIRFLG[map.mode] ?? "d", output: "embed" }
    : { q: target(map), output: "embed" };
  return `https://www.google.com/maps?${new URLSearchParams(params)}`;
}

/** The same route or place in Google Maps itself (https://developers.google.com/maps/documentation/urls). */
export function mapOpenUrl(map: MapOutput) {
  return map.origin
    ? `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: map.origin, destination: target(map), travelmode: map.mode })}`
    : `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: target(map) })}`;
}
