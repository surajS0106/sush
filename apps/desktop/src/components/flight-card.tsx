// The `flights_search` card, as a set of tiles that follow the app's theme and
// the user's accent color: the trip on top, with a plane flying its route, a portrait tile per top fare
// with the airline's logo, and the other airlines' fares listed below. Book looks up
// who sells a fare and lists them; each opens the seller's site in the browser, where
// the user checks the price and pays.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BellIcon,
  BellRingIcon,
  ChevronUpIcon,
  CloudFogIcon,
  CloudIcon,
  CloudLightningIcon,
  CloudRainIcon,
  CloudSnowIcon,
  CloudSunIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PlaneIcon,
  PlaneLandingIcon,
  PlaneTakeoffIcon,
  SunIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  type LucideIcon,
} from "lucide-react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { CurrencySelect } from "@/components/currency-select";
import { Segmented } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { airportStops, type AirportStop } from "@/lib/airports";
import { useMoney } from "@/lib/currency";
import { airlineCode, airlineLogoUrl, CABINS, googleFlightsUrl, kayakUrl, type FlightsOutput } from "@/lib/flights";
import { openSettings } from "@/lib/library";
import { addPriceAlert, MAX_PRICE_ALERTS, priceChange, removePriceAlert, usePriceAlerts, useTripAlert } from "@/lib/price-alerts";
import { api, errorMessage, type BookingLink, type DayWeather, type Fare, type FlightLeg } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { degrees, setTemperatureUnit, TEMPERATURE_UNITS, useTemperatureUnit } from "@/lib/weather";

/** With its world map, it's only worth loading once a card has a route to fly. */
const FlightGlobe = lazy(() => import("@/components/flight-globe").then((m) => ({ default: m.FlightGlobe })));

const TILE = "rounded-3xl border border-border bg-card text-foreground";
const LABEL = "text-xs font-medium tracking-wide text-muted-foreground uppercase";
const ACCENT_TEXT = "text-brand";
/** Filled with the user's accent. Accents are light in dark mode, so its text is near black there. */
const ACCENT_FILL = "bg-brand text-brand-foreground dark:text-neutral-950";
const ACCENT_BUTTON = cn(ACCENT_FILL, "rounded-xl transition-transform hover:bg-brand/90 active:scale-[0.97]");
/** Book on every fare but the cheapest, so the one filled button is the cheapest's. */
const QUIET_BUTTON = "rounded-xl bg-brand/15 text-foreground transition-transform hover:bg-brand/25 active:scale-[0.97]";
/** The cheapest fare's tile. */
const FEATURED_TILE = "border-brand/40 bg-linear-to-b from-brand/20 to-brand/5 shadow-lg shadow-brand/20";
/** The tile on the globe. A ring thickens the border without moving what's inside out of line with its neighbours. */
const PICKED_TILE = "border-brand ring-1 ring-brand";

/** A click on the tile or row picks it, unless it was on something with its own job. */
const pickOnClick = (onPick?: () => void) => (e: MouseEvent) => {
  if (!(e.target as Element).closest("button, a")) onPick?.();
};

/** The way to pick a flight from the keyboard, and what says which one is picked. */
function GlobeButton({ picked, onPick }: { picked: boolean; onPick: () => void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-pressed={picked}
      aria-label="Show this flight's route on the globe"
      title="Show this flight's route on the globe"
      className={cn("rounded-xl", picked && ACCENT_TEXT)}
      onClick={onPick}
    >
      <GlobeIcon />
    </Button>
  );
}

const dayOf = (date: string) => new Date(`${date}T00:00:00`);

const day = (date: string) => dayOf(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "Today" and "Tomorrow" while they're true, since a saved chat outlives them. */
function nearDay(date: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((dayOf(date).getTime() - today) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : day(date);
}

const figure = (amount: number) => amount.toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * A figure with its currency code small beside it: 6,244 AED. In a currency the seller
 * didn't quote it's an estimate, so it says so, with the quoted price on hover.
 */
function Price({ amount, currency, className }: { amount: number; currency: string; className?: string }) {
  const money = useMoney()(amount, currency);
  return (
    <span className={cn("tabular-nums", className)} title={money.quoted ? `${figure(money.quoted.amount)} ${money.quoted.currency} as quoted` : undefined}>
      {money.quoted && (
        <>
          <span aria-hidden>≈ </span>
          <span className="sr-only">About </span>
        </>
      )}
      {figure(money.amount)}
      <span className="ml-1 text-[0.65em] text-muted-foreground">{money.currency}</span>
    </span>
  );
}

/**
 * A time at its airport, with AM or PM small where the user's locale uses them. The
 * text has no time zone, so `Date` reads it as local and it prints back unchanged.
 */
function Time({ at }: { at: string }) {
  let time = at.slice(11, 16);
  let period = "";
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatToParts(new Date(at));
    time = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    period = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  } catch {
    // Not a date we can read: the time as written will do.
  }
  return (
    <span className="tabular-nums">
      {time}
      {period && <span className="ml-0.5 text-[0.8em] uppercase">{period}</span>}
    </span>
  );
}

/** "+1" when a leg lands on a later date than it left. */
function daysLater(leg: FlightLeg) {
  const days = Math.round((Date.parse(leg.arrivesAt.slice(0, 10)) - Date.parse(leg.departsAt.slice(0, 10))) / 86_400_000);
  return days > 0 ? `+${days}` : null;
}

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const stopsLabel = (stops: number) => (stops === 0 ? "Nonstop" : stops === 1 ? "1 stop" : `${stops} stops`);

/** Where a fare's plane comes to rest. It's decoration: the flight isn't in the air. */
const REST = "72%";

/**
 * The route: a dashed line with a blue trail behind a plane. `loop` keeps flying it
 * end to end; otherwise the plane flies out once, when first on screen. Stops are
 * dots along the way. It only moves while on screen and not with reduced motion.
 */
function FlightPath({ loop = false, stops = 0, delay = 0 }: { loop?: boolean; stops?: number; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: !loop });
  const reduced = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const flying = inView && !reduced;
  const path = reduced ? REST : !flying ? "0%" : loop ? ["0%", "100%"] : ["0%", REST];
  const flight = !flying
    ? { duration: 0 }
    : loop
      ? { duration: 6, ease: "easeInOut" as const, repeat: Infinity, repeatDelay: 0.5 }
      : { duration: 1.6, ease: [0.22, 1, 0.36, 1] as const, delay };
  return (
    <div ref={ref} className="relative mx-2.5 h-5" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-muted-foreground/40" />
      {Array.from({ length: stops }, (_, i) => (
        <span
          key={i}
          className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground"
          style={{ left: `${((i + 1) / (stops + 1)) * 100}%` }}
        />
      ))}
      {/* Looping, it fades at each end, so going back to the start doesn't show. */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ opacity: flying && loop ? [0, 1, 1, 0] : 1 }}
        transition={flying && loop ? { ...flight, times: [0, 0.08, 0.92, 1], ease: "linear" } : { duration: 0 }}
      >
        <motion.div
          className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full bg-brand"
          initial={{ width: reduced ? REST : "0%" }}
          animate={{ width: path }}
          transition={flight}
        />
        <motion.div
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
          initial={{ left: reduced ? REST : "0%" }}
          animate={{ left: path }}
          transition={flight}
        >
          <PlaneIcon className="size-4 rotate-45 fill-current text-foreground" />
        </motion.div>
      </motion.div>
    </div>
  );
}

const Dot = () => <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />;

/** The trip's tile: labels, airports and the plane between them, a pill, and a footer. */
function Route({ globe, origin, destination, originCity, destinationCity, topLeft, topRight, pill, footer }: {
  globe?: ReactNode;
  origin: string;
  destination: string;
  originCity?: string;
  destinationCity?: string;
  topLeft?: string;
  topRight?: string;
  pill?: [string, string];
  footer: ReactNode;
}) {
  return (
    <section className={cn(TILE, "flex flex-col gap-3 p-5")}>
      {globe && <div className="-mx-5 -mt-5 h-64 overflow-hidden rounded-t-3xl bg-linear-to-b from-brand/15 to-transparent">{globe}</div>}
      <div>
        {(topLeft || topRight) && (
          <p className={cn(LABEL, "flex justify-between gap-3")}>
            <span className="truncate">{topLeft}</span>
            <span className="truncate text-right">{topRight}</span>
          </p>
        )}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
          <p className="text-4xl leading-tight font-medium tracking-wide">{origin}</p>
          <div className="flex min-w-0 items-center">
            <Dot />
            <div className="min-w-0 flex-1">
              {/* The plane flies on the globe when there is one, not twice over. */}
              {globe ? <div className="mx-2.5 border-t border-dashed border-muted-foreground/40" /> : <FlightPath loop />}
            </div>
            <Dot />
          </div>
          <p className="text-4xl leading-tight font-medium tracking-wide">{destination}</p>
        </div>
        {(originCity || destinationCity) && (
          <p className={cn(LABEL, "flex justify-between gap-3")}>
            <span className="truncate" title={originCity}>
              {originCity}
            </span>
            <span className="truncate text-right" title={destinationCity}>
              {destinationCity}
            </span>
          </p>
        )}
      </div>
      {pill && (
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <p className={cn(ACCENT_FILL, "flex shrink-0 divide-x divide-current/25 rounded-xl py-1.5")}>
            {pill.map((text) => (
              <span key={text} className="px-3 tabular-nums">
                {text}
              </span>
            ))}
          </p>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">{footer}</div>
    </section>
  );
}

/** The airline's own logo, on white because many are dark or see-through. */
function AirlineLogo({ leg }: { leg: FlightLeg }) {
  const [failed, setFailed] = useState(false);
  const code = airlineCode(leg);
  const tile = "flex size-10 shrink-0 items-center justify-center rounded-xl border border-neutral-200 bg-white dark:border-transparent";
  if (!code || failed) {
    return (
      <span className={cn(tile, "text-xs font-medium text-neutral-900")} title={leg.carrier ?? undefined}>
        {code ?? <PlaneIcon className="size-4" aria-hidden />}
      </span>
    );
  }
  return (
    <span className={tile}>
      <img
        src={airlineLogoUrl(code)}
        alt={leg.carrier ? `${leg.carrier} logo` : `${code} logo`}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-8 object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function Leg({ leg, carrier, delay }: { leg: FlightLeg; carrier?: string | null; delay: number }) {
  const later = daysLater(leg);
  const facts = [carrier, leg.durationMinutes !== null ? duration(leg.durationMinutes) : null, stopsLabel(leg.stops)].filter(Boolean);
  return (
    <div className="flex flex-col gap-1" title={leg.flights.join(", ")}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1">
        <div>
          <p className="text-xs text-muted-foreground">
            <Time at={leg.departsAt} />
          </p>
          <p className="text-2xl leading-tight font-medium tracking-wide">{leg.from}</p>
        </div>
        <div className="min-w-0 pb-0.5">
          <FlightPath stops={leg.stops} delay={delay} />
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">
            <Time at={leg.arrivesAt} />
            {later && <span className={cn("ml-1", ACCENT_TEXT)}>{later}</span>}
          </p>
          <p className="text-2xl leading-tight font-medium tracking-wide">{leg.to}</p>
        </div>
      </div>
      <p className="truncate text-center text-xs text-muted-foreground">{facts.join(" · ")}</p>
    </div>
  );
}

const LEG_NAMES: Record<string, string> = { outbound: "Outbound only", inbound: "Return only" };

function SellerRow({ link, roundTrip }: { link: BookingLink; roundTrip: boolean }) {
  const covers = roundTrip && link.legs.length === 1 ? LEG_NAMES[link.legs[0]] : null;
  const facts = [covers, link.fareName, link.isAirline ? "Airline" : null, link.exact ? null : "Pick the flight again there"].filter(Boolean);
  return (
    <button
      type="button"
      onClick={() => void openUrl(link.url)}
      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-neutral-200 dark:hover:bg-neutral-800"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{link.provider}</span>
        {facts.length > 0 && <span className="block truncate text-xs text-muted-foreground">{facts.join(" · ")}</span>}
      </span>
      {link.amount !== null && link.currency && <Price amount={link.amount} currency={link.currency} className="shrink-0" />}
      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

type Sellers = { state: "loading" } | { state: "failed"; error: string } | { state: "ready"; links: BookingLink[] };

type Tag = "Cheapest" | "Fastest";

const TAG_STYLES: Record<Tag, string> = {
  Cheapest: ACCENT_FILL,
  Fastest: cn("bg-brand/15", ACCENT_TEXT),
};

/** Who sells a fare, looked up on the first Book since each lookup is a billed request. */
function useSellers(fareId: string) {
  const [open, setOpen] = useState(false);
  const [sellers, setSellers] = useState<Sellers | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (open || (sellers && sellers.state !== "failed")) return;
    setSellers({ state: "loading" });
    api
      .flightsBookingLinks(fareId)
      .then((links) => setSellers({ state: "ready", links }))
      .catch((e) => setSellers({ state: "failed", error: errorMessage(e) }));
  };
  return { open, sellers, toggle };
}

function BookButton({ open, toggle, quiet = false }: { open: boolean; toggle: () => void; quiet?: boolean }) {
  return open ? (
    <Button size="sm" variant="ghost" aria-label="Hide sellers" aria-expanded onClick={toggle}>
      <ChevronUpIcon />
    </Button>
  ) : (
    <Button size="sm" aria-expanded={false} className={quiet ? QUIET_BUTTON : ACCENT_BUTTON} onClick={toggle}>
      Book
    </Button>
  );
}

function SellerList({ sellers, roundTrip }: { sellers: Sellers; roundTrip: boolean }) {
  return (
    <div className="rounded-2xl bg-muted p-1">
      {sellers.state === "loading" && (
        <div className="px-2 py-1.5">
          <LoadingState label="Finding sellers" />
        </div>
      )}
      {sellers.state === "failed" && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground" title={sellers.error}>
          Couldn't find sellers for this fare. Try the search links below.
        </p>
      )}
      {sellers.state === "ready" && sellers.links.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No seller links for this fare, or it's no longer available. Try the search links below.</p>
      )}
      {sellers.state === "ready" && sellers.links.map((link) => <SellerRow key={`${link.provider}:${link.url}`} link={link} roundTrip={roundTrip} />)}
    </div>
  );
}

function FareTile({ fare, index, tag, quiet, picked, onPick }: { fare: Fare; index: number; tag: Tag | null; quiet: boolean; picked: boolean; onPick?: () => void }) {
  const { open, sellers, toggle } = useSellers(fare.id);
  const reduced = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const featured = tag === "Cheapest";
  // With no globe to pick for, the ring goes to the cheapest.
  const ringed = onPick ? picked : featured;

  const delay = index * 0.12;
  const flightNumber = fare.outbound.flights[0]?.replace(" ", "");
  const otherCarrier = fare.inbound?.carrier && fare.inbound.carrier !== fare.outbound.carrier ? fare.inbound.carrier : null;

  return (
    <motion.li
      onClick={pickOnClick(onPick)}
      className={cn(TILE, "flex min-w-0 flex-col gap-3 p-4 transition-colors", featured && FEATURED_TILE, ringed ? PICKED_TILE : "hover:border-brand/50", onPick && "cursor-pointer")}
      initial={reduced ? false : { opacity: 0, transform: "translateY(8px)" }}
      whileInView={{ opacity: 1, transform: "translateY(0px)" }}
      viewport={{ once: true }}
      transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1], delay: index * 0.05 }}
    >
      <div className="flex items-start justify-between gap-2">
        <AirlineLogo leg={fare.outbound} />
        <div className="flex items-center gap-1">
          {tag && <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium uppercase", TAG_STYLES[tag])}>{tag}</span>}
          {onPick && <GlobeButton picked={picked} onPick={onPick} />}
        </div>
      </div>
      <div className="min-w-0">
        {flightNumber && <p className="text-xl font-medium tabular-nums">{flightNumber}</p>}
        <p className="truncate text-xs text-muted-foreground" title={fare.outbound.carrier ?? undefined}>
          {fare.outbound.carrier ?? "Airline"}
        </p>
      </div>
      <Leg leg={fare.outbound} delay={delay} />
      {fare.inbound && <Leg leg={fare.inbound} carrier={otherCarrier} delay={delay + 0.2} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Price amount={fare.amount} currency={fare.currency} className={cn("font-medium", featured ? "text-3xl leading-none" : "text-xl")} />
        <BookButton open={open} toggle={toggle} quiet={quiet} />
      </div>
      {open && sellers && <SellerList sellers={sellers} roundTrip={!!fare.inbound} />}
    </motion.li>
  );
}

function LegLine({ leg }: { leg: FlightLeg }) {
  const later = daysLater(leg);
  return (
    <p className="truncate text-xs text-muted-foreground" title={leg.flights.join(", ")}>
      <Time at={leg.departsAt} /> – <Time at={leg.arrivesAt} />
      {later && <span className={cn("ml-1", ACCENT_TEXT)}>{later}</span>}
      {" · "}
      {[leg.durationMinutes !== null ? duration(leg.durationMinutes) : null, stopsLabel(leg.stops)].filter(Boolean).join(" · ")}
    </p>
  );
}

function FareRow({ fare, picked, onPick }: { fare: Fare; picked: boolean; onPick?: () => void }) {
  const { open, sellers, toggle } = useSellers(fare.id);
  return (
    <li onClick={pickOnClick(onPick)} className={cn("flex flex-col gap-2 p-3 transition-colors", picked && "bg-brand/10", onPick && "cursor-pointer")}>
      <div className="flex items-center gap-3">
        <AirlineLogo leg={fare.outbound} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{fare.outbound.carrier ?? "Airline"}</p>
          <LegLine leg={fare.outbound} />
          {fare.inbound && <LegLine leg={fare.inbound} />}
        </div>
        <Price amount={fare.amount} currency={fare.currency} className="shrink-0 font-medium" />
        {onPick && <GlobeButton picked={picked} onPick={onPick} />}
        <BookButton open={open} toggle={toggle} quiet />
      </div>
      {open && sellers && <SellerList sellers={sellers} roundTrip={!!fare.inbound} />}
    </li>
  );
}

/** How many of the list show before "Show all". */
const LIST_FIRST = 5;

/** Fares that didn't make the tiles, usually dearer: still the user's to see and choose. */
function MoreFares({ fares, pickedId, onPick }: { fares: Fare[]; pickedId?: string; onPick?: (fare: Fare) => void }) {
  const [all, setAll] = useState(false);
  const airlines = new Set(fares.map((fare) => fare.outbound.carrier ?? fare.outbound.flights[0])).size;
  const shown = all ? fares : fares.slice(0, LIST_FIRST);
  return (
    <section aria-label="More flights" className="flex flex-col gap-2">
      <p className={cn(LABEL, "px-2 pt-1")}>
        {fares.length === 1 ? "1 more flight" : `${fares.length} more flights`}, {airlines === 1 ? "1 airline" : `${airlines} airlines`}, cheapest first
      </p>
      <ul className={cn(TILE, "divide-y divide-border overflow-hidden")}>
        {shown.map((fare) => (
          <FareRow key={fare.id} fare={fare} picked={fare.id === pickedId} onPick={onPick && (() => onPick(fare))} />
        ))}
      </ul>
      {fares.length > LIST_FIRST && (
        <Button variant="ghost" size="sm" className={cn("self-center rounded-xl", ACCENT_TEXT)} aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${fares.length}`}
        </Button>
      )}
    </section>
  );
}

const WEATHER_ICONS: [(code: number) => boolean, LucideIcon][] = [
  [(c) => c === 0, SunIcon],
  [(c) => c === 1 || c === 2, CloudSunIcon],
  [(c) => c === 45 || c === 48, CloudFogIcon],
  [(c) => (c >= 71 && c <= 77) || c === 85 || c === 86, CloudSnowIcon],
  [(c) => c >= 95, CloudLightningIcon],
  [(c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82), CloudRainIcon],
];

function WeatherTile({ weather }: { weather: DayWeather }) {
  const unit = useTemperatureUnit();
  const Icon = WEATHER_ICONS.find(([matches]) => matches(weather.code))?.[1] ?? CloudIcon;
  return (
    <section className={cn(TILE, "flex flex-col gap-3 bg-linear-to-b from-brand/20 to-brand/5 p-5")}>
      <div className="flex items-start justify-between gap-3">
        <PlaneLandingIcon className="size-5 shrink-0" aria-hidden />
        <div className="flex flex-col items-end gap-2">
          <p className="text-4xl leading-none font-medium tabular-nums">{degrees(weather.highC, unit)}</p>
          <Segmented label="Temperature unit" value={unit} onChange={setTemperatureUnit} options={TEMPERATURE_UNITS} />
        </div>
      </div>
      <Icon className={cn("mx-auto size-14", ACCENT_TEXT)} aria-label={weather.condition} strokeWidth={1.25} />
      <div className="mt-auto min-w-0">
        <p className="truncate text-xl font-medium" title={weather.place}>
          {weather.place}
        </p>
        <p className="text-xs text-muted-foreground">
          {weather.condition} · low {degrees(weather.lowC, unit)}
        </p>
        <p className="text-xs text-muted-foreground">{weather.lastYear ? `On ${day(weather.date)} last year` : `Forecast for ${day(weather.date)}`}</p>
        <button
          type="button"
          onClick={() => void openUrl("https://open-meteo.com/")}
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Weather by Open-Meteo
        </button>
      </div>
    </section>
  );
}

function PriceAlertTile({ trip, price, currency }: { trip: FlightsOutput; price: number; currency: string }) {
  const alert = useTripAlert(trip);
  const full = usePriceAlerts().length >= MAX_PRICE_ALERTS;
  const change = alert ? priceChange(alert) : 0;
  return (
    <section className={cn(TILE, "flex flex-col gap-3 p-5")}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-base font-medium">Price alert</p>
        {alert ? <BellRingIcon className={cn("size-4 shrink-0", ACCENT_TEXT)} aria-hidden /> : <BellIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      </div>
      <p className="flex items-center gap-2 text-2xl font-medium tracking-wide">
        {trip.origin}
        <PlaneIcon className="size-4 rotate-45 fill-current text-muted-foreground" aria-label="to" />
        {trip.destination}
      </p>
      {alert ? (
        <div className="mt-auto flex flex-col gap-1">
          {change !== 0 && (
            <p className={cn("flex items-center gap-1 font-medium tabular-nums", change > 0 ? ACCENT_TEXT : "text-coral")}>
              {change > 0 ? <TrendingDownIcon className="size-4" aria-hidden /> : <TrendingUpIcon className="size-4" aria-hidden />}
              {Math.abs(change)}% {change > 0 ? "lower" : "higher"}
            </p>
          )}
          <Price amount={alert.lastPrice} currency={alert.currency} className="text-xl font-medium" />
          <p className="text-xs text-muted-foreground">Checked every 6 hours while Sush is open. You'll get a notice in the app if it drops.</p>
          <Button variant="outline" size="sm" className="mt-1 rounded-xl" onClick={() => removePriceAlert(alert.id)}>
            Stop watching
          </Button>
        </div>
      ) : (
        <div className="mt-auto flex flex-col gap-1">
          <Price amount={price} currency={currency} className="text-xl font-medium" />
          <p className="text-xs text-muted-foreground">
            {full ? `You're watching ${MAX_PRICE_ALERTS} trips, the most at once. Remove one in Settings → Flights.` : "Get a notice in the app if this trip gets cheaper."}
          </p>
          <Button size="sm" disabled={full} className={cn(ACCENT_BUTTON, "mt-1")} onClick={() => addPriceAlert(trip, price, currency)}>
            Watch this price
          </Button>
        </div>
      )}
    </section>
  );
}

const NO_FARES: Record<"failed" | "noKey" | "none", [string, string]> = {
  failed: ["Fares unavailable", "Couldn't get prices right now. You can still compare this trip on these sites."],
  noKey: ["Live fares", "Add an Ignav key to see prices here, or compare this trip on these sites."],
  none: ["No fares found", "Nothing came back for these dates. Try other dates, or compare on these sites."],
};

/** Holds the price alert's place in the layout when there are no fares, and says why. */
function NoFaresTile({ trip }: { trip: FlightsOutput }) {
  const reason = trip.error ? "failed" : trip.fetchedAt === undefined ? "noKey" : "none";
  const [title, detail] = NO_FARES[reason];
  return (
    <section className={cn(TILE, "flex flex-col gap-3 p-5")}>
      <p className="text-base font-medium">{title}</p>
      <p className="flex items-center gap-2 text-2xl font-medium tracking-wide">
        {trip.origin}
        <PlaneIcon className="size-4 rotate-45 fill-current text-muted-foreground" aria-label="to" />
        {trip.destination}
      </p>
      <div className="mt-auto flex flex-col gap-2">
        <p className="text-xs text-muted-foreground" title={trip.error}>
          {detail}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="outline" size="sm" className="rounded-xl" onClick={() => void openUrl(googleFlightsUrl(trip))}>
            Google Flights
            <ExternalLinkIcon />
          </Button>
          <Button variant="outline" size="sm" className="rounded-xl" onClick={() => void openUrl(kayakUrl(trip))}>
            Kayak
            <ExternalLinkIcon />
          </Button>
          {reason === "noKey" && (
            <Button size="sm" className={ACCENT_BUTTON} onClick={() => openSettings({ section: "flights" })}>
              Add key
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Only while a price on the card is converted: what that means, and the credit the rates' terms ask for. */
function ConversionNote({ fare }: { fare: Fare }) {
  const money = useMoney()(fare.amount, fare.currency);
  if (!money.quoted) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Shown in {money.currency} at today's rate. Sellers charge in their own currency, so the final price will differ a little.{" "}
      <button type="button" onClick={() => void openUrl("https://www.exchangerate-api.com")} className="underline-offset-2 hover:underline">
        Rates by ExchangeRate-API
      </button>
    </p>
  );
}

const SHELL = "flex w-full max-w-3xl flex-col gap-2 text-sm";

/** While a search runs: the route as far as it's known, with the plane flying it. */
export function FlightSearching({ origin, destination }: { origin?: string; destination?: string }) {
  return (
    <div className={SHELL}>
      <Route origin={origin || "···"} destination={destination || "···"} footer={<LoadingState label="Looking for flights" />} />
    </div>
  );
}

const totalMinutes = (fare: Fare) => (fare.outbound.durationMinutes ?? Infinity) + (fare.inbound?.durationMinutes ?? 0);

/**
 * Where a flight stops, for the globe. Null until the first answer. Keeps the last answer
 * while the next is found, so the globe changes route once, when it has the whole route.
 */
function useStopovers(codes: string[]) {
  const [found, setFound] = useState<{ key: string; stops: AirportStop[] } | null>(null);
  const key = codes.join(",");
  useEffect(() => {
    let current = true;
    // Without the table, the route is still right from end to end.
    const lookup = codes.length > 0 ? airportStops(codes).catch(() => []) : Promise.resolve([]);
    void lookup.then((stops) => {
      if (current) setFound({ key, stops });
    });
    return () => {
      current = false;
    };
  }, [key]);
  return { stops: found?.stops ?? null, settled: found?.key === key };
}

/** Says when the line on the globe leaves out stops, rather than letting it pass for a direct flight. */
function UnplacedStops({ fare, placed }: { fare: Fare; placed: number }) {
  const count = fare.outbound.stops - placed;
  if (count <= 0) return null;
  return (
    <p className="pointer-events-none absolute top-4 left-4 max-w-[calc(100%-2rem)] rounded-md bg-card/80 px-2 py-1 text-xs text-foreground">
      {count === 1 ? "1 stop isn't shown." : `${count} stops aren't shown.`}
      {/* Cards saved before stops were kept don't know the airports; a new search does. */}
      {!fare.outbound.via && ` Search again to trace ${count === 1 ? "it" : "them"}.`}
    </p>
  );
}

export function FlightCard({ trip }: { trip: FlightsOutput }) {
  const travellers = trip.adults + trip.children;
  const cabin = trip.maxStops === 0 ? `${CABINS[trip.cabin]} · Nonstop` : CABINS[trip.cabin];
  const fares = trip.fares ?? [];
  const cheapest = fares.length > 0 ? fares.reduce((a, b) => (b.amount < a.amount ? b : a)) : null;
  const fastest = fares.length > 0 ? fares.reduce((a, b) => (totalMinutes(b) < totalMinutes(a) ? b : a)) : null;
  const tagOf = (fare: Fare): Tag | null => {
    if (fares.length < 2) return null;
    if (fare === cheapest) return "Cheapest";
    return fare === fastest ? "Fastest" : null;
  };
  const moreFares = trip.cardOnly?.moreFares ?? [];
  const [pickedId, setPickedId] = useState<string | null>(null);
  const hasGlobe = !!trip.originPoint && !!trip.destinationPoint;
  // The globe starts on the cheapest. The pill describes the flight it's showing.
  const picked = [...fares, ...moreFares].find((fare) => fare.id === pickedId) ?? cheapest;
  const { stops: stopovers, settled } = useStopovers(picked?.outbound.via ?? []);
  const onPick = hasGlobe ? (fare: Fare) => setPickedId(fare.id) : undefined;
  const pillFare = hasGlobe ? picked : fastest;
  const pillMinutes = pillFare?.outbound.durationMinutes ?? null;
  const pill: [string, string] =
    pillFare && pillMinutes !== null
      ? [duration(pillMinutes), stopsLabel(pillFare.outbound.stops)]
      : [trip.returnDate ? "Round trip" : "One way", CABINS[trip.cabin]];
  return (
    <figure className={SHELL}>
      <Route
        globe={
          trip.originPoint && trip.destinationPoint ? (
            <Suspense fallback={null}>
              {stopovers && (
                <div className="relative size-full">
                  <FlightGlobe
                    from={{ point: trip.originPoint, name: trip.originCity ?? trip.origin }}
                    via={stopovers}
                    to={{ point: trip.destinationPoint, name: trip.destinationCity ?? trip.destination }}
                  />
                  {picked && settled && <UnplacedStops fare={picked} placed={stopovers.length} />}
                </div>
              )}
            </Suspense>
          ) : undefined
        }
        origin={trip.origin}
        destination={trip.destination}
        originCity={trip.originCity}
        destinationCity={trip.destinationCity}
        topLeft={`Depart ${day(trip.departureDate)}`}
        topRight={trip.returnDate ? `Return ${day(trip.returnDate)}` : "One way"}
        pill={pill}
        footer={
          <>
            <p className="flex items-center gap-2 font-medium">
              <PlaneTakeoffIcon className="size-4 shrink-0" aria-hidden />
              {nearDay(trip.departureDate)}
            </p>
            <p className="flex flex-wrap items-center gap-x-3 text-muted-foreground">
              <span>{travellers === 1 ? "1 passenger" : `${travellers} passengers`}</span>
              <span>{cabin}</span>
              {cheapest && (
                <span className="text-foreground">
                  From <Price amount={cheapest.amount} currency={cheapest.currency} className="font-medium" />
                </span>
              )}
            </p>
          </>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2">
        {trip.weather && <WeatherTile weather={trip.weather} />}
        {cheapest ? <PriceAlertTile trip={trip} price={cheapest.amount} currency={cheapest.currency} /> : <NoFaresTile trip={trip} />}
      </div>
      {fares.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
            <p className={LABEL}>{trip.total !== undefined && trip.total > fares.length ? `Top picks, ${fares.length} of ${trip.total} flights` : "Flights"}</p>
            <CurrencySelect quoted={cheapest?.currency} />
          </div>
          {/* `items-start`: opening one fare's sellers doesn't stretch the others. */}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-2">
            {fares.map((fare, i) => (
              <FareTile key={fare.id} fare={fare} index={i} tag={tagOf(fare)} quiet={fares.length > 1 && fare !== cheapest} picked={fare === picked} onPick={onPick && (() => onPick(fare))} />
            ))}
          </ul>
          {moreFares.length > 0 && <MoreFares fares={moreFares} pickedId={picked?.id} onPick={onPick} />}
        </>
      )}
      {cheapest && trip.fetchedAt !== undefined && (
        <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2">
          <div className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
            <p>Prices from {new Date(trip.fetchedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Confirm the final price and pay on the seller's site.</p>
            <ConversionNote fare={cheapest} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => void openUrl(googleFlightsUrl(trip))}>
              Google Flights
              <ExternalLinkIcon />
            </Button>
            <Button variant="outline" size="sm" onClick={() => void openUrl(kayakUrl(trip))}>
              Kayak
              <ExternalLinkIcon />
            </Button>
          </div>
        </figcaption>
      )}
    </figure>
  );
}
