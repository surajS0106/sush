// The Instamart cart the cards show and change. It starts from the thread's latest cart call. A change
// from a card goes straight to Instamart, with no model turn: the card reads the cart, merges the
// change and saves it, because `update_cart` replaces the whole cart, which may hold items added in the
// phone app. A `get_cart` right after a write has been seen to return an older cart, so what this
// already knows is merged in too, and a removed item stays removed.

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

import { api, errorMessage } from "@/lib/tauri";
import { parseCart, swiggyService, swiggyToolOf, type SwiggyAddress, type SwiggyCart } from "@/lib/swiggy";
import type { SushUIMessage } from "@/lib/transport";

const CART_TOOLS = new Set(["get_cart", "update_cart"]);
const SAVE_AFTER_MS = 400;

export function isInstamartCartTool(toolName: string) {
  return swiggyService(toolName) === "instamart" && CART_TOOLS.has(swiggyToolOf(toolName) ?? "");
}

export interface InstamartThreadInfo {
  threadId: string;
  /** The thread's latest cart call that finished and parsed, or `clear_cart`, as an empty cart. */
  latest: { callId: string; cart: SwiggyCart } | null;
  /** Earlier cart calls of a reply: only each reply's last one shows as a card. */
  superseded: Set<string>;
  /** The thread's latest `get_addresses` call, and the address picked on each card, by call id. */
  addresses: { latest: string | null; picks: Map<string, string> };
}

export const InstamartThread = createContext<InstamartThreadInfo | null>(null);

/** What the model gets when the user picks an address on the card. The thread reads the pick back from it. */
export function addressPickInstruction(address: SwiggyAddress) {
  return `The user picked a delivery address on the card: ${address.label}, ${address.line}. Use address ID ${address.id} from now on, for searches, the cart and checkout. If the cart already has items, update it to use this address. Carry on with what they asked for, and don't ask for the address again.`;
}
const ADDRESS_PICK = /^The user picked a delivery address on the card:.* address ID (\S+) from now on/;

export function instamartThread(threadId: string, messages: SushUIMessage[]): InstamartThreadInfo | null {
  let latest: InstamartThreadInfo["latest"] = null;
  let latestAddresses: string | null = null;
  let found = false;
  const superseded = new Set<string>();
  const picks = new Map<string, string>();
  for (const message of messages) {
    const pick = message.role === "user" ? message.metadata?.instruction?.text.match(ADDRESS_PICK)?.[1] : undefined;
    if (pick && latestAddresses) picks.set(latestAddresses, pick);
    let last: string | null = null;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || !swiggyService(part.toolName)) continue;
      if (swiggyService(part.toolName) === "instamart") found = true;
      if (swiggyService(part.toolName) === "instamart" && swiggyToolOf(part.toolName) === "get_addresses" && part.state === "output-available") {
        latestAddresses = part.toolCallId;
      }
      // `clear_cart` sends no cart back, but what the cards remember has to go, or the next tap saves it again.
      if (swiggyService(part.toolName) === "instamart" && swiggyToolOf(part.toolName) === "clear_cart") {
        if (part.state === "output-available") latest = { callId: part.toolCallId, cart: EMPTY };
        continue;
      }
      if (!isInstamartCartTool(part.toolName)) continue;
      if (last) superseded.add(last);
      last = part.toolCallId;
      if (part.state !== "output-available") continue;
      const cart = parseCart(part.output, "instamart");
      if (cart) latest = { callId: part.toolCallId, cart };
    }
  }
  return found ? { threadId, latest, superseded, addresses: { latest: latestAddresses, picks } } : null;
}

// --- photos for items only named by id -------------------------------------------------------

export interface KnownProduct {
  name: string;
  imageUrl?: string;
}

/** `update_cart`'s input has only ids, so what the cards have shown gives its "adding" state names and photos. */
const known = new Map<string, KnownProduct>();

export function rememberProduct(spinId: string, product: KnownProduct) {
  known.set(spinId, product);
}

export const knownProduct = (spinId: string) => known.get(spinId);

// --- the live cart ---------------------------------------------------------------------------

export interface CartItemRef {
  spinId: string;
  skuId?: string;
}

interface Live {
  /** The cart call this was built on: a later call from the model takes over from it. */
  base: string | null;
  cart: SwiggyCart;
  pending: Map<string, { skuId?: string; quantity: number }>;
  removed: Set<string>;
  saving: boolean;
  error: string | null;
}

const lives = new Map<string, Live>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const EMPTY: SwiggyCart = { items: [], lines: [], stores: 0, unavailable: [], warnings: [] };

function publish(connectorId: string, change: Partial<Live>) {
  lives.set(connectorId, { ...lives.get(connectorId)!, ...change });
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The live state for this thread's latest call, starting over when the model has read or changed the cart since. */
function liveFor(connectorId: string, base: string | null, seed: SwiggyCart | null): Live {
  const live = lives.get(connectorId);
  if (live && live.base === base) return live;
  const fresh: Live = { base, cart: seed ?? EMPTY, pending: new Map(), removed: new Set(), saving: false, error: null };
  lives.set(connectorId, fresh);
  return fresh;
}

async function save(connectorId: string, addressHint?: string) {
  const live = lives.get(connectorId);
  if (!live || live.saving || !live.pending.size) return;
  const pending = new Map(live.pending);
  publish(connectorId, { saving: true, error: null });
  try {
    const server = parseCart(await api.instamartCartRead(connectorId), "instamart");
    if (!server) throw new Error("Instamart's cart couldn't be read.");
    const now = lives.get(connectorId)!;
    const lines = new Map<string, { spinId: string; skuId: string; quantity: number }>();
    for (const item of [...server.items, ...now.cart.items]) {
      if (item.skuId && !now.removed.has(item.id)) lines.set(item.id, { spinId: item.id, skuId: item.skuId, quantity: item.quantity });
    }
    for (const [spinId, { skuId, quantity }] of pending) {
      const sku = skuId ?? lines.get(spinId)?.skuId;
      if (quantity <= 0) lines.delete(spinId);
      else if (sku) lines.set(spinId, { spinId, skuId: sku, quantity });
    }
    const items = [...lines.values()];
    const output = await api.instamartCartWrite(connectorId, items, now.cart.addressId ?? server.addressId ?? addressHint);
    // `clear_cart` doesn't send a cart back.
    const cart = items.length ? parseCart(output, "instamart") : EMPTY;
    if (!cart) throw new Error("Instamart's reply about the cart couldn't be read.");
    const after = lives.get(connectorId)!;
    const rest = new Map(after.pending);
    for (const [spinId, change] of pending) if (rest.get(spinId)?.quantity === change.quantity) rest.delete(spinId);
    publish(connectorId, { cart, pending: rest, saving: false });
    if (rest.size) void save(connectorId, addressHint);
  } catch (e) {
    publish(connectorId, { pending: new Map(), saving: false, error: errorMessage(e) });
  }
}

/** Quantities as the user sees them while a save is on its way. */
export function useInstamartCart(connectorId: string | undefined, addressHint?: string) {
  const thread = useContext(InstamartThread);
  const base = thread?.latest?.callId ?? null;
  const seed = thread?.latest?.cart ?? null;
  const live = useSyncExternalStore(subscribe, () => (connectorId ? liveFor(connectorId, base, seed) : null));
  return useMemo(() => {
    const cart = live?.cart ?? seed ?? EMPTY;
    const quantityOf = (spinId: string) => live?.pending.get(spinId)?.quantity ?? cart.items.find((i) => i.id === spinId)?.quantity ?? 0;
    const setQuantity = (item: CartItemRef, quantity: number) => {
      if (!connectorId || !live) return;
      const now = lives.get(connectorId) ?? live;
      const removed = new Set(now.removed);
      if (quantity <= 0) removed.add(item.spinId);
      else removed.delete(item.spinId);
      publish(connectorId, { pending: new Map(now.pending).set(item.spinId, { skuId: item.skuId, quantity }), removed, error: null });
      clearTimeout(timers.get(connectorId));
      timers.set(connectorId, setTimeout(() => void save(connectorId, addressHint), SAVE_AFTER_MS));
    };
    return {
      cart,
      quantityOf,
      setQuantity,
      saving: !!live?.saving || !!live?.pending.size,
      error: live?.error ?? null,
      /** Items on the way in count; the total is Instamart's own, so it waits for the save. */
      count: countOf(cart, live?.pending),
    };
  }, [addressHint, connectorId, live, seed]);
}

function countOf(cart: SwiggyCart, pending?: Live["pending"]) {
  const inCart = cart.items.reduce((sum, i) => sum + (pending?.get(i.id)?.quantity ?? i.quantity), 0);
  let added = 0;
  pending?.forEach((p, spinId) => {
    if (!cart.items.some((i) => i.id === spinId)) added += p.quantity;
  });
  return inCart + added;
}
