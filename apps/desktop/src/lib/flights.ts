// The `flights_search` tool: a flight card in the chat, for finding and booking a
// flight. A ticket is always bought on the seller's site, never in the app or by the
// model. The card links to the search on Google Flights and Kayak with no key. The
// user's own Ignav key (Settings → Flights) adds live fares and, when they press
// Book, links to the sellers of that fare (`sush_core::flights`).

import { api, errorMessage, type Cabin, type DayWeather, type Fare, type FlightLeg, type GeoPoint, type ToolSpec } from "@/lib/tauri";

export const FLIGHTS_SEARCH = "flights_search";

export type { Cabin };

export const CABINS: Record<Cabin, string> = {
  economy: "Economy",
  "premium-economy": "Premium economy",
  business: "Business",
  first: "First",
};

const MAX_PASSENGERS = 9;

export const flightsTool: ToolSpec = {
  name: FLIGHTS_SEARCH,
  description:
    "Show the user a flight card in the chat, to find and book a flight. Use it whenever they want to fly somewhere, " +
    "compare flights or book a ticket. You need where from, where to and the date: if you don't know one, ask; don't " +
    "guess. Neither you nor the app can buy a ticket or hold a seat: the user books on the seller's site from the card, " +
    "so never say a flight is booked. The result may hold `fares`, which are on the card. If it doesn't, you have no " +
    "prices or schedules, so don't state any as fact. Don't link to the card's sites; it has its own links.",
  inputSchema: {
    type: "object",
    properties: {
      origin: { type: "string", description: "3-letter IATA airport or city code, e.g. BLR, or LON for all of London." },
      destination: { type: "string", description: "3-letter IATA airport or city code." },
      originCity: { type: "string", description: "The origin's city name in English, e.g. Chennai for MAA. Always give it, for the card." },
      destinationCity: {
        type: "string",
        description: "The destination's city name in English, e.g. Mumbai for BOM. Always give it: the card's weather tile looks it up by this name.",
      },
      departureDate: { type: "string", description: "YYYY-MM-DD." },
      returnDate: { type: "string", description: "YYYY-MM-DD. Leave it out for a one-way trip." },
      adults: { type: "integer", description: "Defaults to 1." },
      children: { type: "integer", description: "Passengers aged 2 to 11. Defaults to 0." },
      cabin: { type: "string", enum: Object.keys(CABINS), description: "Defaults to economy." },
      maxStops: { type: "integer", description: "0 for nonstop only, up to 2. Leave it out for any number of stops." },
      market: {
        type: "string",
        description: "Two-letter country the user is buying from, which sets the currency. Leave it out unless they say.",
      },
    },
    required: ["origin", "destination", "originCity", "destinationCity", "departureDate"],
  },
};

/** What the tool's output holds; the card renders it. */
export interface FlightsOutput {
  origin: string;
  destination: string;
  originCity?: string;
  destinationCity?: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  children: number;
  cabin: Cabin;
  maxStops?: number;
  /** Absent on cards saved before price alerts. */
  market?: string;
  note: string;
  /** The destination's weather on the departure date, when `destinationCity` was given. */
  weather?: DayWeather;
  /** Where the cities are, for the globe. A card without both shows a plain route. */
  originPoint?: GeoPoint;
  destinationPoint?: GeoPoint;
  /** With an Ignav key, when the search worked. */
  fares?: Fare[];
  /** How many fares were found, of which `fares` is the best few. */
  total?: number;
  /** When the fares were fetched, in ms: they go stale in a saved chat. */
  fetchedAt?: number;
  /** Why there are no fares, when a search with a key failed. */
  error?: string;
}

const NO_FARES =
  "The card is shown to the user, with links to search this trip on Google Flights and Kayak. It gives you no prices, " +
  "airlines or times.";

const code = (value: unknown) => (typeof value === "string" ? value.trim().toUpperCase() : "");
const isCode = (value: string) => /^[A-Z]{3}$/.test(value);
/** A city name for the card, which can do without one. */
const city = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 60) || undefined : undefined);

/** Today where the user is, as `YYYY-MM-DD`. */
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // `Date` rolls 2026-02-31 over to March, so it only passes if it comes back the same.
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** The country in the user's language setting, which the model can override. */
export function defaultMarket() {
  try {
    return new Intl.Locale(navigator.language).region ?? "US";
  } catch {
    return "US";
  }
}

export async function runFlightsSearch(input: unknown): Promise<{ output: FlightsOutput } | { errorText: string }> {
  const args = (input ?? {}) as Record<string, unknown>;
  const origin = code(args.origin);
  const destination = code(args.destination);
  if (!isCode(origin) || !isCode(destination)) {
    return { errorText: "`origin` and `destination` must be 3-letter IATA airport or city codes." };
  }
  if (origin === destination) return { errorText: "`origin` and `destination` must be different." };
  // Not looked up from the codes: the weather service reads BOM as Boma and LON as Loni.
  const originCity = city(args.originCity);
  const destinationCity = city(args.destinationCity);
  if (!originCity || !destinationCity) {
    return { errorText: `Call again with \`originCity\` and \`destinationCity\`, the English city names for ${origin} and ${destination}.` };
  }
  if (!isDate(args.departureDate)) return { errorText: "`departureDate` must be a real date, as YYYY-MM-DD." };
  const departureDate = args.departureDate;
  if (departureDate < today()) return { errorText: `\`departureDate\` is in the past; today is ${today()}.` };
  const rawReturn = args.returnDate;
  let returnDate: string | undefined;
  if (rawReturn !== undefined && rawReturn !== null) {
    if (!isDate(rawReturn)) return { errorText: "`returnDate` must be a real date as YYYY-MM-DD, or left out." };
    if (rawReturn < departureDate) return { errorText: "`returnDate` is before `departureDate`." };
    returnDate = rawReturn;
  }
  const adults = Number(args.adults ?? 1);
  const children = Number(args.children ?? 0);
  if (!Number.isInteger(adults) || !Number.isInteger(children) || adults < 1 || children < 0) {
    return { errorText: "`adults` must be at least 1 and `children` at least 0, as whole numbers." };
  }
  if (adults + children > MAX_PASSENGERS) return { errorText: `A search can have at most ${MAX_PASSENGERS} passengers.` };
  const cabin = (args.cabin ?? "economy") as Cabin;
  if (!Object.keys(CABINS).includes(cabin)) return { errorText: `\`cabin\` must be one of ${Object.keys(CABINS).join(", ")}, or left out.` };
  const maxStops = args.maxStops === undefined || args.maxStops === null ? undefined : Number(args.maxStops);
  if (maxStops !== undefined && (!Number.isInteger(maxStops) || maxStops < 0 || maxStops > 2)) {
    return { errorText: "`maxStops` must be 0, 1 or 2, or left out." };
  }
  const market = args.market === undefined || args.market === null ? defaultMarket() : code(args.market);
  if (!/^[A-Z]{2}$/.test(market)) return { errorText: "`market` must be a two-letter country code, or left out." };

  const trip: FlightsOutput = {
    origin,
    destination,
    originCity,
    destinationCity,
    departureDate,
    returnDate,
    adults,
    children,
    cabin,
    maxStops,
    market,
    note: NO_FARES,
  };
  // Each runs on its own, and the card's links still work if both fail.
  const fares = api
    .flightsSearch({ origin, destination, departureDate, returnDate: returnDate ?? null, adults, children, cabin, maxStops: maxStops ?? null, market })
    .then(
      (results) => ({ results, error: undefined }),
      (e: unknown) => ({ results: null, error: errorMessage(e) }),
    );
  const forecast = api.flightsWeather(destinationCity, departureDate).catch(() => null);
  const locate = (name: string) => api.flightsLocate(name).catch(() => null);
  const [{ results, error }, weather, from, to] = await Promise.all([fares, forecast, locate(originCity), locate(destinationCity)]);
  const withWeather: FlightsOutput = { ...trip, weather: weather ?? undefined, originPoint: from ?? undefined, destinationPoint: to ?? undefined };
  const weatherNote = weather ? ` \`weather\` is on the card too${weather.lastYear ? "; it's last year's for this date, not a forecast" : ""}.` : "";
  if (error) return { output: { ...withWeather, error, note: `${NO_FARES} Live fares failed: ${error}.${weatherNote}` } };
  if (!results) return { output: { ...withWeather, note: `${NO_FARES}${weatherNote}` } };
  return {
    output: {
      ...withWeather,
      fares: results.fares,
      total: results.total,
      fetchedAt: Date.now(),
      note:
        (results.fares.length > 0
          ? "The fares are on the card, so don't repeat them all. The user books with its Book buttons, on the seller's " +
            "site, and can turn on a price alert there; you can't. Prices can change until then."
          : "Ignav found no fares for this trip. Suggest other dates or airports. The card links to Google Flights and Kayak.") + weatherNote,
    },
  };
}

/** A leg's airline, from its first flight number ("EK 225"). Worked out here so saved cards get logos too. */
export function airlineCode(leg: FlightLeg) {
  const code = leg.flights[0]?.split(" ")[0]?.toUpperCase();
  return code && /^[A-Z0-9]{2}$/.test(code) ? code : null;
}

/**
 * An airline's logo, from the files Google Flights uses. It's not a documented API.
 * An airline Google doesn't know gets a plain grey tail fin. Allowed by `img-src` in
 * both Tauri configs.
 */
export const airlineLogoUrl = (code: string) => `https://www.gstatic.com/flights/airline_logos/70px/${code}.png`;

/**
 * Opens the trip on Google Flights. Its `q` link isn't documented, so it's kept to
 * words tested to work: mentioning premium economy sends it to the bare home page,
 * so that cabin is left for the user to pick there.
 */
export function googleFlightsUrl(trip: FlightsOutput) {
  const dates = trip.returnDate ? `${trip.departureDate} through ${trip.returnDate}` : `${trip.departureDate} one way`;
  const cabin = trip.cabin === "business" || trip.cabin === "first" ? ` ${trip.cabin} class` : "";
  return `https://www.google.com/travel/flights?${new URLSearchParams({ q: `Flights from ${trip.origin} to ${trip.destination} on ${dates}${cabin}` })}`;
}

const KAYAK_CABIN: Record<Cabin, string> = { economy: "", "premium-economy": "/premium", business: "/business", first: "/first" };

/** Opens the trip on Kayak, passengers and cabin included. It takes each child's age, so they go in as 11. */
export function kayakUrl(trip: FlightsOutput) {
  const dates = [trip.departureDate, trip.returnDate].filter(Boolean).join("/");
  const children = trip.children > 0 ? `/children-${Array(trip.children).fill("11").join("-")}` : "";
  return `https://www.kayak.com/flights/${trip.origin}-${trip.destination}/${dates}/${trip.adults}adults${children}${KAYAK_CABIN[trip.cabin]}?sort=bestflight_a`;
}
