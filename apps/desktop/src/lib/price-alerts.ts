// Price alerts: a trip the user asked to watch from its flight card. While the app
// is open, one window searches each trip's fares every few hours (each search is one
// request on the user's Ignav key) and shows a toast when the lowest fare beats the
// lowest seen so far. An alert ends once its departure date has passed.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { defaultMarket, today, type FlightsOutput } from "@/lib/flights";
import { createStore } from "@/lib/store";
import { api, type FlightSearch } from "@/lib/tauri";

export interface PriceAlert {
  id: string;
  search: FlightSearch;
  currency: string;
  /** The lowest fare when the alert was set. */
  startPrice: number;
  /** The lowest fare at the last check. */
  lastPrice: number;
  /** The lowest fare seen, which a new one has to beat to tell the user. */
  lowestPrice: number;
  checkedAt: number;
}

export const MAX_PRICE_ALERTS = 10;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** How often to look for a check that's due. */
const TICK_MS = 15 * 60 * 1000;
/** A drop smaller than this isn't worth interrupting anyone for. */
const MIN_DROP = 0.01;

const alerts = createStore<PriceAlert[]>("sush.price-alerts", []);

export const usePriceAlerts = () => useSyncExternalStore(alerts.subscribe, alerts.get);

/** The same trip gives the same id, so a card finds its alert again. */
function alertId(trip: FlightsOutput) {
  const { origin, destination, departureDate, returnDate, adults, children, cabin, maxStops } = trip;
  return [origin, destination, departureDate, returnDate ?? "", adults, children, cabin, maxStops ?? ""].join("|");
}

export function useTripAlert(trip: FlightsOutput) {
  const id = alertId(trip);
  return usePriceAlerts().find((alert) => alert.id === id) ?? null;
}

export function addPriceAlert(trip: FlightsOutput, price: number, currency: string) {
  const alert: PriceAlert = {
    id: alertId(trip),
    search: {
      origin: trip.origin,
      destination: trip.destination,
      departureDate: trip.departureDate,
      returnDate: trip.returnDate ?? null,
      adults: trip.adults,
      children: trip.children,
      cabin: trip.cabin,
      maxStops: trip.maxStops ?? null,
      market: trip.market ?? defaultMarket(),
    },
    currency,
    startPrice: price,
    lastPrice: price,
    lowestPrice: price,
    checkedAt: Date.now(),
  };
  alerts.set((all) => [...all.filter((a) => a.id !== alert.id), alert]);
}

export const removePriceAlert = (id: string) => alerts.set((all) => all.filter((a) => a.id !== id));

/** How far the fare is below (positive) or above (negative) where it started, in whole percent. */
export const priceChange = (alert: PriceAlert) => Math.round(((alert.startPrice - alert.lastPrice) / alert.startPrice) * 100);

async function check(alert: PriceAlert) {
  const found = await api.flightsSearch(alert.search).catch(() => null);
  const prices = found?.fares.filter((fare) => fare.currency === alert.currency).map((fare) => fare.amount) ?? [];
  const price = prices.length > 0 ? Math.min(...prices) : null;
  const dropped = price !== null && price <= alert.lowestPrice * (1 - MIN_DROP);
  // The alert may have been removed during the search, and `set` leaves it removed.
  alerts.set((all) =>
    all.map((a) =>
      a.id !== alert.id
        ? a
        : { ...a, checkedAt: Date.now(), lastPrice: price ?? a.lastPrice, lowestPrice: price === null ? a.lowestPrice : Math.min(a.lowestPrice, price) },
    ),
  );
  if (dropped && alerts.get().some((a) => a.id === alert.id)) {
    const figure = price.toLocaleString(undefined, { maximumFractionDigits: 0 });
    toast.success(`${alert.search.origin} → ${alert.search.destination} fell to ${figure} ${alert.currency}`, {
      description: `Your price alert for ${alert.search.departureDate}.`,
      duration: 15_000,
    });
  }
}

async function checkDue() {
  const now = Date.now();
  alerts.set((all) => {
    const live = all.filter((a) => a.search.departureDate >= today());
    return live.length === all.length ? all : live;
  });
  // One at a time, so a list of alerts doesn't arrive at Ignav all at once.
  for (const alert of alerts.get()) {
    if (now - alert.checkedAt >= CHECK_EVERY_MS) await check(alert);
  }
}

let started = false;

/** Keeps alerts checked while the app is open. Run from one window only (`whenLeader`). */
export function startPriceAlerts() {
  if (started) return;
  started = true;
  const tick = () => {
    void checkDue().finally(() => setTimeout(tick, TICK_MS));
  };
  tick();
}
