// Swiggy's Food and Instamart tools come through ordinary connectors (`swiggy__<tool>` and
// `instamart__<tool>`, connector-catalog.ts). This reads their output for the cards in
// swiggy-card.tsx. Anything that doesn't parse returns null and the call shows as a plain connector
// row. Field names follow Swiggy's tool reference; the two services differ in tools and shapes:
// https://mcp.swiggy.com/builders/docs/reference/index.md

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const text = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  return typeof v === "number" ? String(v) : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** A figure from a number or text like "₹1,240.50"; undefined for text like "FREE". */
const money = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const digits = typeof v === "string" ? v.replace(/[^0-9.]/g, "") : "";
  return digits ? num(digits) : undefined;
};

export type SwiggyService = "food" | "instamart";

/** The brand name Swiggy's guidelines ask for with each service. */
export const SERVICE_NAME: Record<SwiggyService, string> = { food: "Swiggy", instamart: "Instamart" };

/** The tool that places an order. */
export const ORDER_TOOL: Record<SwiggyService, string> = { food: "place_food_order", instamart: "checkout" };

/** Which service a model-facing tool name (or a connector's `name__` prefix) belongs to. */
export function swiggyService(name: string): SwiggyService | null {
  const at = name.indexOf("__");
  const prefix = at < 0 ? name : name.slice(0, at);
  if (prefix.includes("instamart")) return "instamart";
  return prefix.startsWith("swiggy") ? "food" : null;
}

/** The tool's name on Swiggy's server, for a `swiggy__…` or `instamart__…` call; null for anything else. */
export function swiggyToolOf(toolName: string): string | null {
  if (!swiggyService(toolName)) return null;
  const at = toolName.indexOf("__");
  return at < 0 ? null : toolName.slice(at + 2);
}

/** Whether this call places an order, so it gets the confirm card. */
export function isSwiggyOrder(toolName: string): boolean {
  const service = swiggyService(toolName);
  return !!service && swiggyToolOf(toolName) === ORDER_TOOL[service];
}

const WITH_CARD: Record<SwiggyService, Set<string>> = {
  food: new Set([
    "search_restaurants",
    "get_restaurant_menu",
    "get_food_cart",
    "update_food_cart",
    ORDER_TOOL.food,
    "confirm_order",
    "track_food_order",
  ]),
  instamart: new Set([
    "search_products",
    "your_go_to_items",
    "get_cart",
    "update_cart",
    "get_addresses",
    ORDER_TOOL.instamart,
    "confirm_order",
    "track_order",
  ]),
};

/** Whether a finished call of this tool stays in view as a card. */
export function hasSwiggyCard(toolName: string): boolean {
  const service = swiggyService(toolName);
  return !!service && WITH_CARD[service].has(swiggyToolOf(toolName) ?? "");
}

/**
 * A tool's fields, from its text output. Swiggy's reference wraps them in `{ success, data }`, but the
 * servers send instructions for the model and then the fields bare, so this takes either.
 */
export function envelopeData(output: unknown): Rec | null {
  let value = output;
  if (typeof value === "string") {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      value = JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  // Instamart's cart: the full result is kept for the card, away from the model (`instamart_output`).
  if (isRec(value) && isRec(value.cardOnly) && isRec(value.cardOnly.result)) value = value.cardOnly.result;
  if (!isRec(value) || value.success === false || isRec(value.error)) return null;
  return isRec(value.data) ? value.data : value;
}

/** "₹240", from a number or a figure in a string; other text (like "₹300 for two") as written. */
export function rupees(v: unknown): string | undefined {
  const n = num(v);
  if (n !== undefined) return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return text(v);
}

export interface SwiggyRestaurant {
  id: string;
  name: string;
  cuisines?: string;
  rating?: string;
  costForTwo?: string;
  deliveryTime?: string;
  area?: string;
  offer?: string;
  imageUrl?: string;
  open: boolean;
  nextOpen?: string;
}

export interface SwiggyDish {
  id: string;
  name: string;
  price?: string;
  veg?: boolean;
  restaurant?: string;
  bestseller?: boolean;
  description?: string;
  imageUrl?: string;
  inStock: boolean;
}

/** An Instamart product with its pack sizes. */
export interface SwiggyProduct {
  id: string;
  name: string;
  brand?: string;
  imageUrl?: string;
  /** Sponsored by the brand; Swiggy asks that this is always shown. */
  promoted: boolean;
  /** Swiggy's own label, such as "Diwali Picks". */
  badge?: string;
  variants: SwiggyVariant[];
}

/** One pack size. `id` is its `spinId`. */
export interface SwiggyVariant {
  id: string;
  skuId?: string;
  label: string;
  price?: string;
  mrp?: string;
  /** Whole percent off, from Swiggy's two prices. */
  percentOff?: number;
  inStock: boolean;
  imageUrl?: string;
  rating?: string;
  ratingCount?: string;
  /** "10 mins", from Swiggy's estimate for this address. */
  eta?: string;
  maxQuantity?: number;
  maxQuantityMessage?: string;
}

export interface SwiggyCartItem {
  id: string;
  name: string;
  quantity: number;
  price?: string;
  options: string[];
  inStock: boolean;
  /** Instamart only, like the rest of these. */
  skuId?: string;
  imageUrl?: string;
  mrp?: string;
  maxQuantity?: number;
  maxQuantityMessage?: string;
}

export interface SwiggyCart {
  /** The restaurant; Instamart carts have none. */
  title?: string;
  items: SwiggyCartItem[];
  /** The bill above the total, as labelled rows. */
  lines: { label: string; value: string }[];
  toPay?: number;
  /** The address the cart was built for, when it says. */
  addressId?: string;
  /** Where it's going, for the card: "Home · 12 Main Road". */
  addressLabel?: string;
  /** How many stores its items come from: Instamart makes an order per store. */
  stores: number;
  /** Items that can't be delivered to the cart's address. */
  unavailable: string[];
  /** What Swiggy says about the cart, as written. */
  warnings: string[];
}

export interface SwiggyOrder {
  /** placed: Swiggy has it. pending: waiting for payment, not placed yet. partial: some stores' orders failed. */
  state: "placed" | "pending" | "partial" | "other";
  status?: string;
  orderId?: string;
  restaurant?: string;
  items: string[];
  total?: string;
  eta?: string;
  address?: string;
  payUrl?: string;
  /** An Instamart cart across stores: one order each. */
  parts: { orderId?: string; status?: string; error?: string }[];
}

export interface SwiggyTracked {
  id: string;
  title: string;
  subtitle?: string;
  eta?: string;
  status?: string;
  progress?: number;
}

export interface SwiggyAddress {
  id: string;
  label: string;
  /** Who it's for, as saved on the address. */
  name?: string;
  line: string;
}

export type SwiggyCardData =
  | { kind: "addresses"; addresses: SwiggyAddress[]; suggestedId?: string; total?: number }
  | { kind: "restaurants"; restaurants: SwiggyRestaurant[]; dishes: SwiggyDish[] }
  | { kind: "menu"; restaurant: SwiggyRestaurant; categories: { title: string; items: SwiggyDish[] }[] }
  | { kind: "products"; products: SwiggyProduct[]; similar: SwiggyProduct[] }
  | { kind: "cart"; cart: SwiggyCart }
  | { kind: "order"; order: SwiggyOrder }
  | { kind: "tracking"; orders: SwiggyTracked[]; message?: string };

function dish(d: Rec): SwiggyDish | null {
  const name = text(d.name);
  if (!name) return null;
  return {
    id: text(d.id) ?? name,
    name,
    price: rupees(d.price),
    veg: typeof d.isVeg === "boolean" ? d.isVeg : undefined,
    restaurant: text(d.restaurantName),
    bestseller: d.isBestseller === true,
    description: text(d.description),
    imageUrl: text(d.imageUrl),
    inStock: d.inStock !== false,
  };
}

const dishes = (v: unknown): SwiggyDish[] => list(v).flatMap((d) => dish(d) ?? []);

function restaurants(data: Rec): SwiggyCardData | null {
  const found = list(data.restaurants).flatMap((r): SwiggyRestaurant[] => {
    const name = text(r.name);
    if (!name) return [];
    const cuisines = Array.isArray(r.cuisines) ? r.cuisines.filter((c) => typeof c === "string").join(", ") : text(r.cuisines);
    const status = text(r.availabilityStatus);
    return [
      {
        id: text(r.id) ?? name,
        name,
        cuisines,
        rating: text(r.avgRating),
        costForTwo: rupees(r.costForTwo),
        deliveryTime: text(r.deliveryTimeRange) ?? (num(r.deliveryTimeMinutes) !== undefined ? `${num(r.deliveryTimeMinutes)} min` : undefined),
        area: text(r.areaName),
        offer: text(r.offer),
        imageUrl: text(r.imageUrl),
        open: !status || status === "OPEN",
        nextOpen: text(r.nextOpenTime),
      },
    ];
  });
  const matched = dishes(data.dishes);
  return found.length + matched.length ? { kind: "restaurants", restaurants: found, dishes: matched } : null;
}

function menu(data: Rec): SwiggyCardData | null {
  const r = isRec(data.restaurant) ? data.restaurant : null;
  const name = r && text(r.name);
  if (!r || !name) return null;
  const categories = list(data.categories).flatMap((c) => {
    const nested = list(c.subcategories).flatMap((s) => dishes(s.items));
    const items = [...dishes(c.items), ...nested];
    return items.length ? [{ title: text(c.title) ?? "Menu", items }] : [];
  });
  return {
    kind: "menu",
    restaurant: {
      id: text(r.id) ?? name,
      name,
      cuisines: Array.isArray(r.cuisines) ? r.cuisines.filter((c) => typeof c === "string").join(", ") : undefined,
      rating: text(r.avgRatingString) ?? text(r.avgRating),
      costForTwo: text(r.costForTwoMessage),
      deliveryTime: text(r.slaString),
      area: text(r.areaName),
      imageUrl: text(r.imageUrl),
      open: r.isOpen !== false,
    },
    categories,
  };
}

const productsOf = (v: unknown): SwiggyProduct[] =>
  list(v).flatMap((p): SwiggyProduct[] => {
    const name = text(p.displayName);
    if (!name) return [];
    const variations = list(p.variations);
    return [
      {
        id: text(p.productId) ?? name,
        name,
        brand: text(p.brand),
        imageUrl: variations.map((x) => text(x.imageUrl)).find(Boolean),
        promoted: p.isPromoted === true,
        badge: list(p.badges).flatMap((b) => text(b.text) ?? [])[0],
        variants: variations.map((x, i) => {
          const price = isRec(x.price) ? x.price : {};
          const offer = num(price.offerPrice);
          const mrp = num(price.mrp);
          const discounted = mrp !== undefined && offer !== undefined && mrp > offer;
          const rating = isRec(x.rating) ? x.rating : {};
          const sla = isRec(x.sla) ? x.sla : {};
          return {
            id: text(x.spinId) ?? String(i),
            skuId: text(x.skuId),
            label: text(x.quantityDescription) ?? text(x.displayName) ?? "",
            price: rupees(offer ?? mrp),
            mrp: discounted ? rupees(mrp) : undefined,
            percentOff: discounted ? Math.round(((mrp - offer) / mrp) * 100) : undefined,
            inStock: x.isInStockAndAvailable !== false,
            imageUrl: text(x.imageUrl),
            rating: text(rating.value),
            ratingCount: text(rating.count),
            eta: text(sla.value) ? `${text(sla.value)} ${(text(sla.unit) ?? "mins").toLowerCase()}` : undefined,
            maxQuantity: num(x.maxQuantity),
            maxQuantityMessage: text(x.maxQuantityMessage),
          };
        }),
      },
    ];
  });

function products(data: Rec): SwiggyCardData | null {
  const found = productsOf(data.products);
  const similar = productsOf(data.similarProducts);
  return found.length + similar.length ? { kind: "products", products: found, similar } : null;
}

/** Food's cart: by Swiggy's reference, its `data` holds another `data`. */
function foodCart(data: Rec): SwiggyCart | null {
  const inner = isRec(data.data) ? data.data : data;
  if (!Array.isArray(inner.items)) return null;
  const pricing = isRec(inner.pricing) ? inner.pricing : {};
  const offers = isRec(inner.offers) ? inner.offers : {};
  const restaurant = isRec(inner.restaurant) ? inner.restaurant : {};
  const discount = num(offers.coupon_discount);
  const lines = [
    { label: "Items", value: rupees(pricing.item_total) },
    { label: "Delivery", value: rupees(pricing.delivery_charge) },
    { label: "Taxes and charges", value: rupees(pricing.taxes_and_charges) },
    // Swiggy: a coupon counts as applied only when its discount is above zero.
    { label: "Coupon", value: discount !== undefined && discount > 0 ? `−${rupees(discount)}` : undefined },
  ].flatMap((l) => (l.value ? [{ label: l.label, value: l.value }] : []));
  return {
    title: text(restaurant.name),
    items: list(inner.items).map((i) => ({
      id: text(i.menu_item_id) ?? text(i.name) ?? "item",
      name: text(i.name) ?? "Item",
      quantity: num(i.quantity) ?? 1,
      price: rupees(i.final_price ?? i.total ?? i.subtotal),
      options: [...list(i.variants), ...list(i.addons)].flatMap((o) => text(o.name) ?? []),
      inStock: i.in_stock !== false,
    })),
    lines,
    toPay: money(pricing.to_pay),
    stores: 1,
    unavailable: [],
    warnings: [],
  };
}

function labelledAddress(address: Rec) {
  const line = text(address.address);
  if (!line) return undefined;
  const tag = text(address.annotation) ?? text(address.category);
  return tag ? `${tag.charAt(0).toUpperCase()}${tag.slice(1).toLowerCase()} · ${line}` : line;
}

/** Instamart's cart, from `get_cart` or `update_cart`. */
function instamartCart(data: Rec): SwiggyCart | null {
  if (!Array.isArray(data.items) && data.cartAbsent !== true) return null;
  const items = list(data.items);
  const bill = isRec(data.billBreakdown) ? data.billBreakdown : {};
  const toPay = isRec(bill.toPay) ? bill.toPay : {};
  const address = isRec(data.selectedAddressDetails) ? data.selectedAddressDetails : {};
  const warning = isRec(data.cartWarning) ? data.cartWarning : {};
  return {
    items: items.map((i) => ({
      id: text(i.spinId) ?? text(i.itemName) ?? "item",
      name: text(i.itemName) ?? "Item",
      quantity: num(i.quantity) ?? 1,
      price: rupees(i.discountedFinalPrice),
      options: text(i.itemVariant) ? [text(i.itemVariant)!] : [],
      inStock: i.isInStockAndAvailable !== false,
      skuId: text(i.skuId),
      imageUrl: text(i.imageUrl),
      mrp: num(i.mrp) !== undefined && num(i.mrp)! > (num(i.discountedFinalPrice) ?? Infinity) ? rupees(i.mrp) : undefined,
      maxQuantity: num(i.maxQuantity),
      maxQuantityMessage: text(i.maxQuantityMessage),
    })),
    lines: list(bill.lineItems).flatMap((l) => {
      const label = text(l.label);
      const value = rupees(l.value);
      return label && value ? [{ label, value }] : [];
    }),
    toPay: money(toPay.value) ?? money(data.cartTotalAmount),
    addressId: text(address.id),
    addressLabel: labelledAddress(address),
    stores: new Set(items.map((i) => text(i.storeId)).filter(Boolean)).size,
    unavailable: list(data.unserviceableItems).flatMap((i) => text(i.itemName) ?? []),
    warnings: [
      text(data.addressWarning),
      text(warning.message),
      text(data.cartAbsentReason),
      ...list(data.removedOutOfStockItems).map((i) => (text(i.itemName) ? `${text(i.itemName)} was removed: out of stock.` : undefined)),
      ...list(data.reducedQuantityItems).map((i) =>
        text(i.itemName) ? `${text(i.itemName)} was reduced to ${text(i.cappedQuantity) ?? "fewer"}${text(i.reason) ? `: ${text(i.reason)}` : "."}` : undefined,
      ),
    ].flatMap((w) => w ?? []),
  };
}

/** A cart tool's output as a cart. */
export function parseCart(output: unknown, service: SwiggyService): SwiggyCart | null {
  const data = envelopeData(output);
  if (!data) return null;
  return service === "food" ? foodCart(data) : instamartCart(data);
}

function order(data: Rec): SwiggyCardData | null {
  const status = text(data.status);
  const orderId = text(data.orderId);
  const parts = list(data.orders).map((o) => ({ orderId: text(o.orderId), status: text(o.status), error: text(o.error) }));
  if (!status && !orderId && !parts.length) return null;
  const normalized = text(data.normalizedStatus);
  const bridge = text(data.bridgeUrl);
  const items = Array.isArray(data.items)
    ? data.items.flatMap((i) => {
        if (typeof i === "string") return [i];
        if (!isRec(i)) return [];
        const name = text(i.name);
        const quantity = num(i.quantity);
        return name ? [quantity ? `${quantity} × ${name}` : name] : [];
      })
    : [];
  const failed = parts.some((p) => p.error);
  return {
    kind: "order",
    order: {
      state: parts.length
        ? data.allSucceeded === true
          ? "placed"
          : failed && parts.some((p) => !p.error)
            ? "partial"
            : "other"
        : status === "PENDING_PAYMENT" || normalized === "pending"
          ? "pending"
          : normalized === "success" || status === "CONFIRMED" || status === "PLACED"
            ? "placed"
            : "other",
      status,
      orderId,
      restaurant: text(data.restaurantName),
      items,
      total: rupees(data.totalAmount ?? data.cartTotal),
      eta: text(data.estimatedDelivery),
      address: text(data.deliveryAddress),
      payUrl: bridge?.startsWith("https://") ? bridge : undefined,
      parts,
    },
  };
}

function foodTracking(data: Rec): SwiggyCardData {
  return {
    kind: "tracking",
    message: text(data.statusMessage),
    orders: list(data.orders).map((o) => {
      const progress = num(typeof o.progressPercentage === "string" ? o.progressPercentage.replace("%", "") : o.progressPercentage);
      return {
        id: text(o.orderId) ?? "",
        title: text(o.title) ?? "Your order",
        subtitle: text(o.subtitle),
        eta: text(o.etaText),
        status: text(o.orderStatus),
        progress: progress === undefined ? undefined : Math.min(100, Math.max(0, progress)),
      };
    }),
  };
}

function instamartTracking(data: Rec): SwiggyCardData | null {
  const status = isRec(data.status) ? data.status : {};
  const title = text(status.statusMessage) ?? text(data.orderTitle);
  if (!title) return null;
  return {
    kind: "tracking",
    orders: [
      {
        id: text(data.orderId) ?? "",
        title,
        subtitle: text(status.subStatusMessage) ?? text(data.orderSubtitle),
        eta: text(status.etaText) ?? (num(status.etaMinutes) !== undefined ? `${num(status.etaMinutes)} min` : undefined),
        status: text(status.statusMessage),
      },
    ],
  };
}

/** In practice `get_addresses` sends text, a line per address: `1. [Home] Name: 12 Main Road (ID: abc)`. */
const ADDRESS_ROW = /^\s*\d+\.\s*\[([^\]]+)\]\s*(?:([^:]*):\s*)?(.+?)\s*\(ID:\s*([^)\s]+)\)\s*$/;

function savedAddresses(output: unknown): SwiggyCardData | null {
  if (typeof output === "string") {
    const rows = output.split("\n").flatMap((row) => {
      const found = row.match(ADDRESS_ROW);
      return found ? [{ id: found[4], label: found[1].trim(), name: found[2]?.trim() || undefined, line: found[3] }] : [];
    });
    if (rows.length) {
      return {
        kind: "addresses",
        addresses: rows,
        suggestedId: output.match(/(?:preselected|suggested) address ID:\s*(\S+?)\.?(?:\s|$)/i)?.[1],
        total: num(output.match(/Found (\d+) saved address/i)?.[1]),
      };
    }
  }
  const data = envelopeData(output);
  const addresses = list(data?.addresses).flatMap((a) => {
    const id = text(a.id);
    const line = text(a.addressLine);
    return id && line ? [{ id, line, label: text(a.addressTag) ?? text(a.addressCategory) ?? "Saved address" }] : [];
  });
  return addresses.length ? { kind: "addresses", addresses } : null;
}

function cardData(service: SwiggyService, tool: string, output: unknown): SwiggyCardData | null {
  if (tool === "get_food_cart" || tool === "update_food_cart" || tool === "get_cart" || tool === "update_cart") {
    const cart = parseCart(output, service);
    return cart && { kind: "cart", cart };
  }
  if (tool === "get_addresses") return savedAddresses(output);
  const data = envelopeData(output);
  if (!data) return null;
  switch (tool) {
    case "search_restaurants":
      return restaurants(data);
    case "get_restaurant_menu":
      return menu(data);
    case "search_products":
    case "your_go_to_items":
      return products(data);
    case "track_food_order":
      return foodTracking(data);
    case "track_order":
      return instamartTracking(data);
    default:
      return order(data);
  }
}

/** The card for a finished call, or null to show it as a plain connector row. */
export function parseSwiggyCard(toolName: string, output: unknown): { service: SwiggyService; card: SwiggyCardData } | null {
  const service = swiggyService(toolName);
  const tool = swiggyToolOf(toolName);
  if (!service || !tool || !WITH_CARD[service].has(tool)) return null;
  const card = cardData(service, tool, output);
  return card && { service, card };
}

/** The line of one saved address, from `get_addresses` output. */
export function addressLine(output: unknown, id: string): string | null {
  if (typeof output === "string") {
    for (const row of output.split("\n")) {
      const found = row.match(ADDRESS_ROW);
      if (found?.[4] === id) return `${found[1]}: ${found[3]}`;
    }
  }
  const data = envelopeData(output);
  const found = data && list(data.addresses).find((a) => a.id === id);
  if (!found) return null;
  const line = text(found.addressLine);
  if (!line) return null;
  const tag = text(found.addressTag) ?? text(found.addressCategory);
  return tag ? `${tag}: ${line}` : line;
}
