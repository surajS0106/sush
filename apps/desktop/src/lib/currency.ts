// Showing a flight card's prices in the currency the user picks. Fares stay stored as
// quoted, and price alerts compare those, so this only changes what's shown: a seller
// charges its own currency, which is why a converted price reads as an estimate. Rates
// come through Rust (`sush_core::flights`) with no key, and aren't fetched until
// someone opens the picker or has already picked a currency.

import { useEffect, useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, type ExchangeRates } from "@/lib/tauri";

const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/** Offered first, and all that's offered until the rates have loaded. */
export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "INR", "AED", "SGD", "AUD", "CAD", "JPY"];

/** Null shows each price as the seller quoted it. */
const picked = createStore<string | null>("sush.currency", null);
const saved = createStore<(ExchangeRates & { fetchedAt: number }) | null>("sush.exchange-rates", null);

export const usePickedCurrency = () => useSyncExternalStore(picked.subscribe, picked.get);
export const setPickedCurrency = (currency: string | null) => picked.set(currency);
const useSavedRates = () => useSyncExternalStore(saved.subscribe, saved.get);

let loading = false;

export function loadRates() {
  const current = saved.get();
  if (loading || (current && Date.now() - current.fetchedAt < REFRESH_AFTER_MS)) return;
  loading = true;
  void api
    .flightsRates()
    .then((rates) => saved.set({ ...rates, fetchedAt: Date.now() }))
    // Prices stay as quoted, or at the last rates, until a later try works.
    .catch(() => {})
    .finally(() => {
      loading = false;
    });
}

/** Every currency there's a rate for, the common ones first. */
export function useCurrencyOptions() {
  const rates = useSavedRates()?.rates;
  const others = rates ? Object.keys(rates).filter((code) => !COMMON_CURRENCIES.includes(code)) : [];
  return { common: rates ? COMMON_CURRENCIES.filter((code) => code in rates) : COMMON_CURRENCIES, others };
}

/** A currency's symbol, told apart from its namesakes: "$" (US), "CA$", "A$", "₹", "€". */
export function currencySign(code: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).formatToParts(0).find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

export function currencyName(code: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface Money {
  amount: number;
  currency: string;
  /** What the seller quoted, when this is a conversion of it. */
  quoted: { amount: number; currency: string } | null;
}

/** Turns a quoted price into the picked currency, or leaves it when there's no rate for either. */
export function useMoney() {
  const currency = usePickedCurrency();
  const rates = useSavedRates()?.rates;
  useEffect(() => {
    if (currency) loadRates();
  }, [currency]);
  return (amount: number, from: string): Money => {
    const [source, target] = [rates?.[from], currency ? rates?.[currency] : undefined];
    if (!currency || currency === from || !source || !target) return { amount, currency: from, quoted: null };
    return { amount: (amount / source) * target, currency, quoted: { amount, currency: from } };
  };
}
