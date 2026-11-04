// Cards for Swiggy's Food and Instamart tools: restaurants, a menu, products, the cart, the order
// and its tracking, and the card that confirms an order. That one reads the live cart from Swiggy,
// so what the user approves is Swiggy's own figures and not the model's account of them. Each card
// carries the attribution Swiggy's brand guidelines ask for at every step, for its own service.

import { openUrl } from "@tauri-apps/plugin-opener";
import { ClockIcon, ExternalLinkIcon, LeafIcon, MapPinIcon, ReceiptTextIcon, StarIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { brandLogo } from "@/lib/connector-catalog";
import {
  addressLine,
  parseCart,
  rupees,
  SERVICE_NAME,
  type SwiggyCardData,
  type SwiggyCart,
  type SwiggyDish,
  type SwiggyOrder,
  type SwiggyProduct,
  type SwiggyRestaurant,
  type SwiggyService,
  type SwiggyTracked,
} from "@/lib/swiggy";
import { api, errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Swiggy's Food recipe for builders caps an order at this much. */
const FOOD_ORDER_CAP = 1000;
/** Swiggy's Instamart recipe: a cart under this is turned down. */
const INSTAMART_MINIMUM = 99;
/** Swiggy: cancellations go to its customer care; no tool cancels an order. */
const CUSTOMER_CARE = "080-67466729";

function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full max-w-xl overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm", className)}>
      {children}
    </div>
  );
}

function PoweredBy({ service }: { service: SwiggyService }) {
  // The sizes and spacing Swiggy's guidelines set for a compact badge: a 24px logo, 8px clear around it, 14px text.
  return (
    <div className="flex items-center gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
      <img src={brandLogo({ id: service === "food" ? "swiggy" : "instamart" })} alt="" className="size-6 shrink-0 rounded-[20%] object-cover" />
      <span>Powered by {SERVICE_NAME[service]}</span>
    </div>
  );
}

/** Hidden if it doesn't load; only Swiggy's own https images are tried. */
function Photo({ src, className }: { src?: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src?.startsWith("https://") || failed) return null;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={cn("shrink-0 rounded-lg object-cover", className)} />;
}

function RestaurantRow({ r }: { r: SwiggyRestaurant }) {
  const facts = [r.cuisines, r.area].filter(Boolean).join(" · ");
  return (
    <li className={cn("flex gap-3 p-3", !r.open && "opacity-60")}>
      <Photo src={r.imageUrl} className="size-14" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{r.name}</div>
        {facts && <div className="truncate text-xs text-muted-foreground">{facts}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {r.rating && (
            <span className="inline-flex items-center gap-1">
              <StarIcon className="size-3" /> {r.rating}
            </span>
          )}
          {r.deliveryTime && (
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="size-3" /> {r.deliveryTime}
            </span>
          )}
          {r.costForTwo && <span>{r.costForTwo}</span>}
          {!r.open && <span>Closed{r.nextOpen ? ` · opens ${r.nextOpen}` : ""}</span>}
        </div>
        {r.offer && r.open && <div className="mt-1 text-xs font-medium">{r.offer}</div>}
      </div>
    </li>
  );
}

function DishRow({ d }: { d: SwiggyDish }) {
  return (
    <li className={cn("flex gap-3 p-3", !d.inStock && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {d.veg && <LeafIcon aria-label="Vegetarian" className="size-3.5 shrink-0" />}
          <span className="truncate">{d.name}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {d.price && <span className="text-foreground">{d.price}</span>}
          {d.restaurant && <span>{d.restaurant}</span>}
          {d.bestseller && <span>Bestseller</span>}
          {!d.inStock && <span>Out of stock</span>}
        </div>
        {d.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.description}</p>}
      </div>
      <Photo src={d.imageUrl} className="size-14" />
    </li>
  );
}

function ProductRow({ p }: { p: SwiggyProduct }) {
  return (
    <li className="flex gap-3 p-3">
      <Photo src={p.imageUrl} className="size-14" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p.name}</div>
        {p.brand && <div className="truncate text-xs text-muted-foreground">{p.brand}</div>}
        <ul className="mt-1 space-y-0.5">
          {p.variants.map((v) => (
            <li key={v.id} className={cn("flex flex-wrap gap-x-2 text-xs text-muted-foreground", !v.inStock && "opacity-60")}>
              {v.label && <span>{v.label}</span>}
              {v.price && <span className="text-foreground">{v.price}</span>}
              {v.mrp && <span className="line-through">{v.mrp}</span>}
              {!v.inStock && <span>Out of stock</span>}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function CartLines({ cart }: { cart: SwiggyCart }) {
  return (
    <>
      <ul className="space-y-2">
        {cart.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
            <Photo src={item.imageUrl} className="size-8 bg-white object-contain" />
            <div className="min-w-0 flex-1">
              <span>
                {item.quantity} × {item.name}
              </span>
              {item.options.length > 0 && <div className="text-xs text-muted-foreground">{item.options.join(", ")}</div>}
              {!item.inStock && <div className="text-xs text-destructive">Out of stock</div>}
            </div>
            {item.price && <span className="shrink-0 tabular-nums">{item.price}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1 border-t pt-3">
        {cart.lines.map((line, i) => (
          <div key={`${line.label}-${i}`} className="flex justify-between gap-3 text-xs text-muted-foreground">
            <span>{line.label}</span>
            <span className="tabular-nums">{line.value}</span>
          </div>
        ))}
        {cart.toPay !== undefined && (
          <div className="flex justify-between gap-3 pt-1 text-sm font-medium">
            <span>To pay</span>
            <span className="tabular-nums">{rupees(cart.toPay)}</span>
          </div>
        )}
      </div>
    </>
  );
}

/** Swiggy's own remarks on a cart, and how a cart across stores will be ordered. */
function CartNotices({ cart }: { cart: SwiggyCart }) {
  return (
    <>
      {cart.unavailable.length > 0 && <Notice>Can't be delivered to this address: {cart.unavailable.join(", ")}.</Notice>}
      {cart.warnings.map((w, i) => (
        <Notice key={i}>{w}</Notice>
      ))}
      {cart.stores > 1 && <Notice>These items come from {cart.stores} stores, so Swiggy will make a separate order for each.</Notice>}
    </>
  );
}

function orderTitle(order: SwiggyOrder, service: SwiggyService) {
  switch (order.state) {
    case "placed":
      // Swiggy asks for this wording on Instamart orders.
      return service === "instamart" ? "Instamart order placed successfully" : "Order placed";
    case "pending":
      return "Waiting for your payment";
    case "partial":
      return "Only part of this order was placed";
    default:
      return order.parts.length ? "This order wasn't placed" : (order.status ?? "Order update");
  }
}

function OrderCard({ order, service }: { order: SwiggyOrder; service: SwiggyService }) {
  return (
    <Frame>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ReceiptTextIcon className="size-4 shrink-0" /> {orderTitle(order, service)}
        </div>
        {order.state === "pending" && <p className="text-xs text-muted-foreground">The order isn't placed until you've paid.</p>}
        {order.restaurant && <div className="text-sm">{order.restaurant}</div>}
        {order.items.length > 0 && <div className="text-xs text-muted-foreground">{order.items.join(", ")}</div>}
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {order.total && <span className="text-foreground">{order.total}</span>}
          {order.eta && <span>{order.eta}</span>}
          {order.orderId && <span>Order {order.orderId}</span>}
        </div>
        {order.parts.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {order.parts.map((p, i) => (
              <li key={p.orderId ?? i} className={cn(p.error && "text-destructive")}>
                {p.orderId ? `Order ${p.orderId}` : `Store ${i + 1}`}: {p.error ?? p.status ?? "placed"}
              </li>
            ))}
          </ul>
        )}
        {order.address && <div className="text-xs text-muted-foreground">{order.address}</div>}
        {order.state === "pending" && order.payUrl && (
          <Button size="sm" className="rounded-full" onClick={() => void openUrl(order.payUrl!)}>
            <ExternalLinkIcon className="size-3.5" /> Pay with UPI
          </Button>
        )}
        {(order.state === "placed" || order.state === "partial") && (
          <p className="text-xs text-muted-foreground">To cancel, call Swiggy customer care on {CUSTOMER_CARE}.</p>
        )}
      </div>
      <PoweredBy service={service} />
    </Frame>
  );
}

function TrackedRow({ o }: { o: SwiggyTracked }) {
  return (
    <li className="space-y-1.5 p-3">
      <div className="flex justify-between gap-3 text-sm font-medium">
        <span className="min-w-0">{o.title}</span>
        {o.eta && <span className="shrink-0 text-xs text-muted-foreground">{o.eta}</span>}
      </div>
      {o.subtitle && <div className="text-xs text-muted-foreground">{o.subtitle}</div>}
      {o.progress !== undefined && (
        <div
          role="progressbar"
          aria-valuenow={o.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={o.status ?? "Order progress"}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${o.progress}%` }} />
        </div>
      )}
    </li>
  );
}

export function SwiggyCard({ card, service }: { card: SwiggyCardData; service: SwiggyService }) {
  switch (card.kind) {
    case "restaurants":
      return (
        <Frame>
          <ul className="max-h-96 divide-y overflow-y-auto">
            {card.restaurants.map((r) => (
              <RestaurantRow key={r.id} r={r} />
            ))}
            {card.dishes.map((d) => (
              <DishRow key={`${d.restaurant}-${d.id}`} d={d} />
            ))}
          </ul>
          <PoweredBy service={service} />
        </Frame>
      );
    case "menu":
      return (
        <Frame>
          <ul>
            <RestaurantRow r={card.restaurant} />
          </ul>
          <div className="max-h-96 divide-y overflow-y-auto border-t">
            {card.categories.map((c, i) => (
              <details key={`${c.title}-${i}`} open={i === 0}>
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  {c.title} <span className="font-normal text-muted-foreground">({c.items.length})</span>
                </summary>
                <ul className="divide-y">
                  {c.items.map((d) => (
                    <DishRow key={d.id} d={d} />
                  ))}
                </ul>
              </details>
            ))}
          </div>
          <PoweredBy service={service} />
        </Frame>
      );
    case "products":
      return (
        <Frame>
          <div className="max-h-96 overflow-y-auto">
            <ul className="divide-y">
              {card.products.map((p) => (
                <ProductRow key={p.id} p={p} />
              ))}
            </ul>
            {card.similar.length > 0 && (
              <>
                <div className="border-t px-3 py-2 text-sm font-medium">Similar items</div>
                <ul className="divide-y border-t">
                  {card.similar.map((p) => (
                    <ProductRow key={p.id} p={p} />
                  ))}
                </ul>
              </>
            )}
          </div>
          <PoweredBy service={service} />
        </Frame>
      );
    case "cart":
      return (
        <Frame>
          <div className="space-y-3 p-3">
            <div className="text-sm font-medium">{card.cart.title ?? "Your cart"}</div>
            {card.cart.items.length ? <CartLines cart={card.cart} /> : <p className="text-sm text-muted-foreground">The cart is empty.</p>}
            <CartNotices cart={card.cart} />
            {service === "food" && <p className="text-xs text-muted-foreground">Items added here may not show in the Swiggy app on your phone.</p>}
          </div>
          <PoweredBy service={service} />
        </Frame>
      );
    case "addresses":
      // Instamart's picker is in instamart-card.tsx, and Food's `get_addresses` has no card.
      return null;
    case "order":
      return <OrderCard order={card.order} service={service} />;
    case "tracking":
      return (
        <Frame>
          {card.orders.length ? (
            <ul className="divide-y">
              {card.orders.map((o, i) => (
                <TrackedRow key={o.id || i} o={o} />
              ))}
            </ul>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">{card.message ?? "No active orders."}</p>
          )}
          <PoweredBy service={service} />
        </Frame>
      );
  }
}

interface Preview {
  cart: SwiggyCart;
  address: string | null;
}

interface OrderInput {
  addressId?: unknown;
  paymentMethod?: unknown;
  noteToRestaurant?: unknown;
  confirmDuplicate?: unknown;
}

/** What's about to be ordered, for spotting a change on Confirm. */
const orderKey = (cart: SwiggyCart) => JSON.stringify([cart.toPay, cart.items.map((i) => [i.id, i.quantity])]);

function paymentLabel(method: string) {
  const upper = method.toUpperCase();
  if (upper.includes("UPI")) return "UPI";
  if (upper === "COD" || upper === "CASH") return "Cash on delivery";
  if (upper === "SWIGGYPAY") return "Swiggy Money, charged straight away";
  return method;
}

/**
 * Asks before the call that places an order. The call names only an address and a payment method, so
 * the order itself is read from Swiggy, again on Confirm in case it changed. There's no "Always allow".
 */
export function SwiggyOrderApproval({
  connectorId,
  service,
  input,
  onConfirm,
  onDeny,
}: {
  connectorId: string;
  service: SwiggyService;
  input: unknown;
  onConfirm: () => void;
  onDeny: () => void;
}) {
  const { addressId, paymentMethod, noteToRestaurant, confirmDuplicate } = (input ?? {}) as OrderInput;
  const address = typeof addressId === "string" ? addressId : "";
  const payment = typeof paymentMethod === "string" && paymentMethod.trim() ? paymentMethod : null;
  const note = typeof noteToRestaurant === "string" ? noteToRestaurant : null;
  const upi = payment?.toUpperCase().includes("UPI") ?? false;

  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [checking, setChecking] = useState(false);

  const read = useCallback(async (): Promise<Preview> => {
    if (!address) throw new Error("The order doesn't say which address to deliver to.");
    const { cart, addresses } = await api.swiggyOrderPreview(connectorId, address, service === "instamart");
    const parsed = parseCart(cart, service);
    if (!parsed) throw new Error("Swiggy's cart couldn't be read.");
    return { cart: parsed, address: addressLine(addresses, address) };
  }, [address, connectorId, service]);

  useEffect(() => {
    let stale = false;
    read().then(
      (p) => !stale && setPreview(p),
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [read]);

  const confirm = async () => {
    setChecking(true);
    setError(null);
    try {
      const fresh = await read();
      if (!preview || orderKey(fresh.cart) !== orderKey(preview.cart)) {
        setPreview(fresh);
        setChanged(true);
        return;
      }
      onConfirm();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const cart = preview?.cart;
  const problem = !cart
    ? null
    : !cart.items.length
      ? "The cart is empty."
      : cart.items.some((i) => !i.inStock)
        ? "Something in the cart is out of stock."
        : cart.unavailable.length
          ? "Something in the cart can't be delivered to this address."
          : cart.toPay === undefined
            ? "Swiggy didn't give a total for this order."
            : !preview?.address
              ? "This address isn't among your first 10 saved addresses, so it can't be shown here."
              : cart.addressId && cart.addressId !== address
                ? "This cart was built for a different address, so the items may not be available at this one."
                : // Instamart picks a method itself if none is named, which could be Swiggy Money.
                  service === "instamart" && !payment
                  ? "The order doesn't say how you'd pay. Tell the assistant which payment method to use."
                  : null;
  const total = cart?.toPay !== undefined ? rupees(cart.toPay) : null;

  return (
    <Frame className="max-w-md">
      <div className="space-y-3 p-3">
        <div className="text-sm font-medium">{upi ? "Check your order, then continue to payment" : "Place this order?"}</div>
        {!preview && !error && <LoadingState label="Checking your cart with Swiggy" />}
        {cart && (
          <>
            {cart.title && <div className="text-sm">{cart.title}</div>}
            <CartLines cart={cart} />
            {preview?.address && (
              <div className="flex gap-1.5 text-xs text-muted-foreground">
                <MapPinIcon className="mt-px size-3.5 shrink-0" /> <span>{preview.address}</span>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Payment: {payment ? paymentLabel(payment) : service === "food" ? "Cash on delivery" : "not chosen"}
            </div>
            {note && <div className="text-xs text-muted-foreground">Note to the restaurant: {note}</div>}
            <CartNotices cart={cart} />
            {service === "food" && cart.toPay !== undefined && cart.toPay > FOOD_ORDER_CAP && (
              <Notice>Swiggy limits orders from apps like this to {rupees(FOOD_ORDER_CAP)}, so it may turn this one down.</Notice>
            )}
            {service === "instamart" && cart.toPay !== undefined && cart.toPay < INSTAMART_MINIMUM && (
              <Notice>Instamart has a {rupees(INSTAMART_MINIMUM)} minimum, so it may turn this one down.</Notice>
            )}
            {confirmDuplicate === true && (
              <Notice>Swiggy flagged this as a probable duplicate of a recent order. Confirm only if you want another one.</Notice>
            )}
          </>
        )}
        {changed && <Notice>This order changed since the card opened. Check it and confirm again.</Notice>}
        {problem && <Notice>{problem}</Notice>}
        {error && <Notice>{error}</Notice>}
      </div>
      <div className="flex items-center justify-end gap-1.5 border-t p-2.5">
        <Button variant="ghost" size="sm" className="rounded-full" onClick={onDeny}>
          Don't order
        </Button>
        <Button size="sm" className="rounded-full" disabled={!cart || !!problem || checking} onClick={() => void confirm()}>
          {upi ? "Continue to payment" : `Place order${total ? ` · ${total}` : ""}`}
        </Button>
      </div>
      <PoweredBy service={service} />
    </Frame>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-1.5 text-xs text-destructive">
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0" /> <span>{children}</span>
    </div>
  );
}
