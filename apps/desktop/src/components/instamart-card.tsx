// Instamart's search results and cart, in the feel of its own app: products on white photo tiles with
// the discount on a tab and Add on the photo, and a bar for the cart. The header is also the connection
// status and the attribution Swiggy asks for above results and beside a cart. Swiggy's own widget, when
// its server offers one for the tool, can be shown instead (see `InstamartWidget`).

import { openUrl } from "@tauri-apps/plugin-opener";
import { BriefcaseIcon, CheckIcon, ChevronRightIcon, ClockIcon, HomeIcon, MapPinIcon, MinusIcon, PlusIcon, ShoppingBagIcon, StarIcon, TriangleAlertIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { brandLogo } from "@/lib/connector-catalog";
import {
  addressPickInstruction,
  InstamartThread,
  knownProduct,
  rememberProduct,
  useInstamartCart,
  type CartItemRef,
} from "@/lib/instamart-cart";
import { sendMessage } from "@/lib/sessions";
import { envelopeData, rupees, type SwiggyAddress, type SwiggyCardData, type SwiggyCart, type SwiggyCartItem, type SwiggyProduct, type SwiggyVariant } from "@/lib/swiggy";
import { api, errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Swiggy's Instamart recipe: a cart under this is turned down. */
const MINIMUM = 99;
const COLLAPSED_PRODUCTS = 6;
const VIEW_KEY = "sush.instamartView";

/** A smaller copy from Swiggy's image CDN: originals can be 300KB for a 160px tile. */
function sized(url: string | undefined, width: number) {
  return url?.replace("/image/upload/", `/image/upload/fl_lossy,f_auto,q_auto,w_${width}/`);
}

function Photo({ src, name, width, className }: { src?: string; name: string; width: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const usable = src?.startsWith("https://") && !failed;
  return (
    // White in dark mode too: Instamart's product photos are shot on white.
    <div className={cn("flex items-center justify-center overflow-hidden bg-white", className)}>
      {usable ? (
        <img src={sized(src, width)} alt={name} loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <ShoppingBagIcon aria-hidden className="size-1/3 text-neutral-300" />
      )}
    </div>
  );
}

function Header({ connected, children }: { connected: boolean; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-2 py-2">
      {/* Swiggy's compact badge: a 24px logo, 8px to the text and around it, 14px text, nothing else inside. */}
      <div className="flex items-center gap-2 p-2">
        <img src={brandLogo({ id: "instamart" })} alt="" className="size-6 shrink-0 rounded-[20%] object-cover" />
        <span className="text-sm font-medium">Powered by Instamart</span>
      </div>
      <div className="ml-auto flex items-center gap-3 pr-2">
        {children}
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>
    </div>
  );
}

function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn("@container w-full overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm", wide ? "max-w-2xl" : "max-w-xl")}>{children}</div>;
}

// --- controls --------------------------------------------------------------------------------

function Stepper({
  name,
  quantity,
  max,
  maxMessage,
  onChange,
  className,
}: {
  name: string;
  quantity: number;
  max?: number;
  maxMessage?: string;
  onChange: (quantity: number) => void;
  className?: string;
}) {
  const atMax = max !== undefined && quantity >= max;
  return (
    <div className={cn("flex h-8 items-center rounded-lg bg-brand text-brand-foreground shadow-sm", className)}>
      <button type="button" aria-label={`Remove one ${name}`} onClick={() => onChange(quantity - 1)} className="flex h-8 w-8 items-center justify-center rounded-l-lg transition-colors hover:bg-brand-foreground/15 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand-foreground">
        <MinusIcon className="size-3.5" />
      </button>
      <span aria-live="polite" className="min-w-4 text-center text-sm font-semibold tabular-nums">
        {quantity}
      </span>
      <button
        type="button"
        aria-label={`Add one more ${name}`}
        title={atMax ? maxMessage : undefined}
        disabled={atMax}
        onClick={() => onChange(quantity + 1)}
        className="flex h-8 w-8 items-center justify-center rounded-r-lg transition-colors enabled:hover:bg-brand-foreground/15 disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand-foreground"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

function AddButton({ name, onClick, className }: { name: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Add ${name}`}
      onClick={onClick}
      className={cn(
        "h-8 rounded-lg border border-brand bg-white px-4 text-sm font-semibold text-brand shadow-sm transition-colors hover:bg-brand hover:text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        className,
      )}
    >
      Add
    </button>
  );
}

// --- products --------------------------------------------------------------------------------

function ProductTile({
  product,
  readOnly,
  quantityOf,
  setQuantity,
  fresh,
  index,
}: {
  product: SwiggyProduct;
  readOnly: boolean;
  quantityOf: (spinId: string) => number;
  setQuantity: (item: CartItemRef, quantity: number) => void;
  fresh: boolean;
  index: number;
}) {
  const initial = product.variants.find((v) => quantityOf(v.id) > 0) ?? product.variants.find((v) => v.inStock) ?? product.variants[0];
  const [pickedId, setPickedId] = useState(initial?.id);
  const variant: SwiggyVariant | undefined = product.variants.find((v) => v.id === pickedId) ?? initial;
  const quantity = variant ? quantityOf(variant.id) : 0;
  const name = variant?.label ? `${product.name}, ${variant.label}` : product.name;
  const ref = variant && { spinId: variant.id, skuId: variant.skuId };

  return (
    <div
      style={fresh ? { animationDelay: `${index * 40}ms` } : undefined}
      className={cn("flex h-full flex-col overflow-hidden rounded-xl border bg-background", fresh && "motion-safe:animate-in motion-safe:fill-mode-both motion-safe:fade-in motion-safe:slide-in-from-bottom-2")}
    >
      <div className="relative">
        <Photo src={variant?.imageUrl ?? product.imageUrl} name={product.name} width={320} className={cn("aspect-square", !variant?.inStock && "opacity-50")} />
        {variant?.percentOff ? (
          <span className="absolute top-0 left-2 rounded-b-md bg-brand px-1.5 py-1 text-xs leading-none font-semibold text-brand-foreground">{variant.percentOff}% OFF</span>
        ) : null}
        {!variant?.inStock ? (
          <span className="absolute right-2 bottom-2 rounded-md bg-neutral-900/80 px-2 py-1 text-xs font-medium text-white">Out of stock</span>
        ) : (
          !readOnly &&
          ref &&
          (quantity > 0 ? (
            <Stepper name={product.name} quantity={quantity} max={variant.maxQuantity} maxMessage={variant.maxQuantityMessage} onChange={(q) => setQuantity(ref, q)} className="absolute right-2 bottom-2" />
          ) : (
            <AddButton name={name} onClick={() => setQuantity(ref, 1)} className="absolute right-2 bottom-2" />
          ))
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {variant?.eta && (
            <span className="inline-flex items-center gap-1 font-medium">
              <ClockIcon aria-hidden className="size-3" /> {variant.eta}
            </span>
          )}
          {variant?.rating && (
            <span className="inline-flex items-center gap-1">
              <StarIcon aria-hidden className="size-3" /> {variant.rating}
              {variant.ratingCount ? ` (${variant.ratingCount})` : ""}
            </span>
          )}
        </div>
        <div className="line-clamp-2 text-sm leading-snug font-medium" title={product.name}>
          {product.name}
        </div>
        {product.promoted && <div className="text-xs text-muted-foreground">Sponsored</div>}
        {product.variants.length > 1 ? (
          // One line, however many pack sizes: some products have five.
          <select
            aria-label={`Pack size of ${product.name}`}
            value={variant?.id}
            onChange={(e) => setPickedId(e.target.value)}
            className="mt-1 w-full truncate rounded-md border bg-background px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {product.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.price ? ` · ${v.price}` : ""}
                {v.inStock ? "" : " · out of stock"}
              </option>
            ))}
          </select>
        ) : (
          variant?.label && <div className="text-xs text-muted-foreground">{variant.label}</div>
        )}
        <div className="mt-auto flex items-baseline gap-1.5 pt-2">
          <span className="text-sm font-semibold tabular-nums">{variant?.price}</span>
          {variant?.mrp && <span className="text-xs text-muted-foreground tabular-nums line-through">{variant.mrp}</span>}
        </div>
      </div>
    </div>
  );
}

function ProductsBody({
  products,
  similar,
  connectorId,
  readOnly,
  addressId,
  fresh,
}: {
  products: SwiggyProduct[];
  similar: SwiggyProduct[];
  connectorId?: string;
  readOnly: boolean;
  addressId?: string;
  fresh: boolean;
}) {
  const [all, setAll] = useState(false);
  const { cart, quantityOf, setQuantity, saving, error, count } = useInstamartCart(connectorId, addressId);
  const shown = all ? products : products.slice(0, COLLAPSED_PRODUCTS);
  const tile = { readOnly, quantityOf, setQuantity, fresh };
  return (
    <>
      <div className="space-y-4 p-3">
        {shown.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 @lg:grid-cols-3">
            {shown.map((p, i) => (
              <li key={p.id}>
                <ProductTile product={p} index={i} {...tile} />
              </li>
            ))}
          </ul>
        )}
        {products.length > shown.length && (
          <button type="button" onClick={() => setAll(true)} className="flex w-full items-center justify-center gap-1 rounded-lg border py-2 text-sm font-medium text-brand transition-colors hover:bg-muted">
            Show all {products.length} <ChevronRightIcon aria-hidden className="size-4" />
          </button>
        )}
        {similar.length > 0 && (
          <section>
            <h4 className="mb-2 text-sm font-semibold">Similar items</h4>
            {/* A rail, as in Instamart: these are suggestions, so they don't push the cart bar away. */}
            <ul className="-mx-3 flex snap-x scroll-pl-3 gap-2 overflow-x-auto px-3 pb-1">
              {similar.map((p, i) => (
                <li key={p.id} className="w-40 shrink-0 snap-start">
                  <ProductTile product={p} index={i} {...tile} fresh={false} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {!readOnly && count > 0 && <CartBar count={count} toPay={cart.toPay} saving={saving} />}
    </>
  );
}

// --- cart ------------------------------------------------------------------------------------

function CheckoutButton({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  const threadId = useContext(InstamartThread)?.threadId;
  return (
    <button
      type="button"
      disabled={disabled || !threadId}
      onClick={() => threadId && sendMessage(threadId, "Take me through checkout for my Instamart cart.", [])}
      className="flex h-10 shrink-0 items-center gap-1 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      {children} <ChevronRightIcon aria-hidden className="size-4" />
    </button>
  );
}

function CartBar({ count, toPay, saving }: { count: number; toPay?: number; saving: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t p-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold tabular-nums">
          {count} {count === 1 ? "item" : "items"}
          {toPay !== undefined && !saving ? ` · ${rupees(toPay)}` : ""}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          {saving ? (
            "Updating your cart…"
          ) : (
            <>
              <CheckIcon aria-hidden className="size-3" /> In your Instamart cart
            </>
          )}
        </div>
      </div>
      <CheckoutButton disabled={saving}>Checkout</CheckoutButton>
    </div>
  );
}

function CartRow({
  item,
  quantity,
  readOnly,
  setQuantity,
  fresh,
  index,
}: {
  item: SwiggyCartItem;
  quantity: number;
  readOnly: boolean;
  setQuantity: (item: CartItemRef, quantity: number) => void;
  fresh: boolean;
  index: number;
}) {
  return (
    <li
      style={fresh ? { animationDelay: `${index * 60}ms` } : undefined}
      className={cn("flex items-center gap-3 p-3", fresh && "motion-safe:animate-in motion-safe:fill-mode-both motion-safe:fade-in motion-safe:slide-in-from-left-2", !item.inStock && "opacity-60")}
    >
      <Photo src={item.imageUrl} name={item.name} width={160} className="size-16 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm leading-snug font-medium">{item.name}</div>
        {item.options.length > 0 && <div className="truncate text-xs text-muted-foreground">{item.options.join(", ")}</div>}
        {!item.inStock && <div className="text-xs text-destructive">Out of stock</div>}
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-sm font-semibold tabular-nums">{item.price}</span>
          {item.mrp && <span className="text-xs text-muted-foreground tabular-nums line-through">{item.mrp}</span>}
        </div>
      </div>
      {readOnly ? (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">× {quantity}</span>
      ) : (
        <Stepper name={item.name} quantity={quantity} max={item.maxQuantity} maxMessage={item.maxQuantityMessage} onChange={(q) => setQuantity({ spinId: item.id, skuId: item.skuId }, q)} className="shrink-0" />
      )}
    </li>
  );
}

function CartBody({ snapshot, live, connectorId, readOnly, fresh }: { snapshot: SwiggyCart; live: boolean; connectorId?: string; readOnly: boolean; fresh: boolean }) {
  const state = useInstamartCart(connectorId);
  // An earlier reply's cart stays as it was then; only the thread's latest follows the live cart.
  const cart = live ? state.cart : snapshot;
  const editable = live && !readOnly;
  const quantityOf = (id: string) => (live ? state.quantityOf(id) : (snapshot.items.find((i) => i.id === id)?.quantity ?? 0));
  const items = cart.items.filter((i) => quantityOf(i.id) > 0);
  const short = cart.toPay !== undefined && cart.toPay < MINIMUM;
  return (
    <>
      {cart.addressLabel && (
        <div className="flex items-center gap-1.5 border-b px-4 py-2 text-xs text-muted-foreground">
          <MapPinIcon aria-hidden className="size-3.5 shrink-0" /> <span className="truncate">{cart.addressLabel}</span>
        </div>
      )}
      {items.length ? (
        <ul className="divide-y">
          {items.map((item, i) => (
            <CartRow key={item.id} item={item} quantity={quantityOf(item.id)} readOnly={!editable} setQuantity={state.setQuantity} fresh={fresh} index={i} />
          ))}
        </ul>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Your cart is empty.</p>
      )}
      {cart.warnings.map((w, i) => (
        <Notice key={i}>{w}</Notice>
      ))}
      {cart.unavailable.length > 0 && <Notice>Can't be delivered to this address: {cart.unavailable.join(", ")}.</Notice>}
      {cart.stores > 1 && <Notice>These items come from {cart.stores} stores, so Swiggy will make a separate order for each.</Notice>}
      {live && state.error && <Notice>{state.error}</Notice>}
      {items.length > 0 && (
        <>
          <dl className={cn("space-y-1 border-t px-4 py-3 text-xs text-muted-foreground transition-opacity", live && state.saving && "opacity-50")}>
            {cart.lines.map((line, i) => (
              <div key={`${line.label}-${i}`} className="flex justify-between gap-3">
                <dt>{line.label}</dt>
                <dd className="tabular-nums">{line.value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex items-center justify-between gap-3 border-t p-3 pl-4">
            <div className={cn("transition-opacity", live && state.saving && "opacity-50")} aria-live="polite">
              <div className="text-xs text-muted-foreground">{live && state.saving ? "Updating…" : "To pay"}</div>
              <div className="text-lg leading-tight font-semibold tabular-nums">{cart.toPay !== undefined ? rupees(cart.toPay) : "—"}</div>
            </div>
            {editable && <CheckoutButton disabled={state.saving || short}>Checkout</CheckoutButton>}
          </div>
          {short && <Notice>Instamart has a {rupees(MINIMUM)} minimum, so it may turn this order down.</Notice>}
        </>
      )}
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-1.5 border-t px-4 py-2 text-xs text-destructive">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" /> <span>{children}</span>
    </div>
  );
}

// --- Swiggy's own widget ---------------------------------------------------------------------

/**
 * Swiggy's own page for this result, fetched from its server, sandboxed to scripts only. It answers the
 * MCP Apps handshake and shows what it's given; tool calls from it are turned down for now, so it can't
 * change the cart or spend anything.
 */
function InstamartWidget({ connectorId, uri, input, output, onFail }: { connectorId: string; uri: string; input: unknown; output: unknown; onFail: (why: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState(480);
  const frame = useRef<HTMLIFrameElement>(null);
  const data = envelopeData(output);

  useEffect(() => {
    let stale = false;
    const dark = document.documentElement.classList.contains("dark");
    api.connectorWidget(connectorId, uri, input, data, dark).then(
      (u) => !stale && setUrl(u),
      (e) => !stale && onFail(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
    // The call's result doesn't change once it's finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorId, uri]);

  useEffect(() => {
    const reply = (id: unknown, result: unknown) => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", id, result }, "*");
    const notify = (method: string, params: unknown) => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", method, params }, "*");
    const open = (href: unknown) => {
      if (typeof href === "string" && href.startsWith("https://")) void openUrl(href);
    };
    const onMessage = (e: MessageEvent) => {
      // A sandboxed frame has no origin to check, so go by which window sent it.
      if (e.source !== frame.current?.contentWindow || typeof e.data !== "object" || e.data === null) return;
      const m = e.data as { sushWidget?: string; height?: unknown; href?: unknown; id?: unknown; method?: string; params?: { height?: unknown; url?: unknown } };
      if (m.sushWidget === "height" && typeof m.height === "number") setHeight(Math.min(Math.max(m.height, 120), 720));
      else if (m.sushWidget === "open") open(m.href);
      else if (m.method === "ui/initialize") {
        const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
        reply(m.id, { protocolVersion: "2025-06-18", hostInfo: { name: "Sush", version: "1" }, hostCapabilities: { openLinks: {} }, hostContext: { theme, displayMode: "inline" } });
      } else if (m.method === "ui/notifications/initialized") {
        notify("ui/notifications/tool-input", { arguments: input ?? {} });
        notify("ui/notifications/tool-result", { content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(data ?? output ?? "") }], structuredContent: data ?? undefined });
      } else if (m.method === "ui/notifications/size-changed" && typeof m.params?.height === "number") setHeight(Math.min(Math.max(m.params.height, 120), 720));
      else if (m.method === "ui/open-link") {
        open(m.params?.url);
        reply(m.id, {});
      } else if (m.id !== undefined && m.method) {
        frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "This view can't do that yet." } }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [data, input, output]);

  if (!url) return <WorkingTiles />;
  return <iframe ref={frame} title="Instamart's own view" src={url} sandbox="allow-scripts" className="block w-full border-0 bg-transparent" style={{ height }} />;
}

function readView(): "sush" | "instamart" {
  try {
    return localStorage.getItem(VIEW_KEY) === "instamart" ? "instamart" : "sush";
  } catch {
    return "sush";
  }
}

function ViewToggle({ view, onChange }: { view: "sush" | "instamart"; onChange: (view: "sush" | "instamart") => void }) {
  const option = (value: "sush" | "instamart", label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className={cn("rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-brand", view === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Which view of this result" className="flex rounded-lg bg-muted p-0.5">
      {option("sush", "Sush")}
      {option("instamart", "Swiggy's")}
    </div>
  );
}

// --- the card --------------------------------------------------------------------------------

export function InstamartCard({
  card,
  callId,
  input,
  output,
  connectorId,
  widget,
  readOnly,
  fresh,
  row,
}: {
  card: Extract<SwiggyCardData, { kind: "products" | "cart" }>;
  callId: string;
  input: unknown;
  output: unknown;
  connectorId?: string;
  widget?: string;
  readOnly: boolean;
  fresh: boolean;
  /** The plain line this call shows as once a later cart call has replaced it. */
  row: ReactNode;
}) {
  const thread = useContext(InstamartThread);
  const [view, setView] = useState(readView);
  const [widgetError, setWidgetError] = useState<string | null>(null);
  const choose = (next: "sush" | "instamart") => {
    setView(next);
    setWidgetError(null);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* The choice just isn't remembered. */
    }
  };

  if (card.kind === "products") {
    for (const p of [...card.products, ...card.similar]) {
      for (const v of p.variants) rememberProduct(v.id, { name: p.name, imageUrl: v.imageUrl ?? p.imageUrl });
    }
  } else {
    for (const i of card.cart.items) rememberProduct(i.id, { name: i.name, imageUrl: i.imageUrl });
  }

  if (card.kind === "cart" && thread?.superseded.has(callId)) return row;

  const canShowWidget = !!connectorId && widget?.startsWith("ui://") && !readOnly;
  const showWidget = canShowWidget && view === "instamart" && !widgetError;
  const addressId = typeof (input as { addressId?: unknown } | null)?.addressId === "string" ? (input as { addressId: string }).addressId : undefined;

  return (
    <Frame wide={card.kind === "products"}>
      <Header connected={!!connectorId}>{canShowWidget && <ViewToggle view={view} onChange={choose} />}</Header>
      {widgetError && <Notice>Swiggy's view didn't load, so this is Sush's: {widgetError}</Notice>}
      {showWidget ? (
        <>
          {/* Its own − and + buttons look live, but its tool calls are turned down, and it never updates. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground">
            <span>Swiggy's view can't change your cart, and shows it as of this message.</span>
            <button type="button" onClick={() => choose("sush")} className="font-medium text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
              Switch to Sush's view
            </button>
          </div>
          <InstamartWidget connectorId={connectorId!} uri={widget!} input={input} output={output} onFail={setWidgetError} />
        </>
      ) : card.kind === "products" ? (
        <ProductsBody products={card.products} similar={card.similar} connectorId={connectorId} readOnly={readOnly} addressId={addressId} fresh={fresh} />
      ) : (
        <CartBody snapshot={card.cart} live={thread?.latest?.callId === callId} connectorId={connectorId} readOnly={readOnly} fresh={fresh} />
      )}
    </Frame>
  );
}

// --- while a call runs -----------------------------------------------------------------------

function WorkingTiles() {
  return (
    <ul aria-hidden className="grid grid-cols-2 gap-2 p-3 @lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <li key={i} className="overflow-hidden rounded-xl border">
          <div className="aspect-square animate-pulse bg-muted" style={{ animationDelay: `${i * 150}ms` }} />
          <div className="space-y-2 p-3">
            <div className="h-3 animate-pulse rounded bg-muted" style={{ animationDelay: `${i * 150}ms` }} />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" style={{ animationDelay: `${i * 150}ms` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// --- addresses -------------------------------------------------------------------------------

function AddressIcon({ label, className }: { label: string; className?: string }) {
  const Icon = /home/i.test(label) ? HomeIcon : /work|office/i.test(label) ? BriefcaseIcon : MapPinIcon;
  return <Icon aria-hidden className={className} />;
}

/** The name most addresses share: usually the user's own, so only the others are worth showing. */
function usualName(addresses: SwiggyAddress[]) {
  const counts = new Map<string, number>();
  for (const { name } of addresses) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Every saved address, picked with one click. A pick is a message to the model carrying the address id,
 * then the card shrinks to the choice. Only the thread's latest card can be changed.
 */
export function InstamartAddresses({
  card,
  callId,
  connected,
  readOnly,
  row,
}: {
  card: Extract<SwiggyCardData, { kind: "addresses" }>;
  callId: string;
  connected: boolean;
  readOnly: boolean;
  /** The plain line this call shows as once a later call has replaced it, if nothing was picked on it. */
  row: ReactNode;
}) {
  const thread = useContext(InstamartThread);
  // The pick shows at once, though a message sent during a run only joins the thread at its next step.
  const [sent, setSent] = useState<string>();
  const [changing, setChanging] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const latest = thread?.addresses.latest === callId;
  const editable = latest && !readOnly && !!thread;
  const pickedId = sent ?? thread?.addresses.picks.get(callId);
  const picked = card.addresses.find((a) => a.id === pickedId);
  if (!latest && !picked) return row;

  const pick = (address: SwiggyAddress) => {
    if (!thread) return;
    setChanging(false);
    if (address.id !== pickedId) {
      setSent(address.id);
      sendMessage(thread.threadId, `Deliver to ${address.label}`, [], { text: addressPickInstruction(address) });
    }
    // The row that had focus is about to go.
    requestAnimationFrame(() => changeRef.current?.focus());
  };
  const change = () => {
    setChanging(true);
    requestAnimationFrame(() => listRef.current?.querySelector("button")?.focus());
  };

  if (picked && !changing) {
    return (
      <Frame>
        <Header connected={connected} />
        <div className="flex items-start gap-3 px-4 py-3" aria-live="polite">
          <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Delivering to {picked.label}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{picked.line}</div>
          </div>
          {editable && (
            <button
              ref={changeRef}
              type="button"
              onClick={change}
              aria-label={`Change delivery address, now ${picked.label}`}
              className="-my-1 h-8 shrink-0 rounded-lg px-2 text-sm font-medium text-brand transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Change
            </button>
          )}
        </div>
      </Frame>
    );
  }

  const usual = usualName(card.addresses);
  return (
    <Frame>
      <Header connected={connected} />
      <h4 className="px-4 pt-3 pb-2 text-sm font-semibold">Where should this go?</h4>
      <ul ref={listRef} aria-label="Saved addresses" className="divide-y border-t">
        {card.addresses.map((address) => {
          const forSomeoneElse = address.name && address.name !== usual && address.name !== address.label;
          const current = address.id === pickedId;
          return (
            <li key={address.id}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => pick(address)}
                aria-current={current || undefined}
                className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors enabled:hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
              >
                <AddressIcon label={address.label} className={cn("mt-0.5 size-4 shrink-0", current ? "text-brand" : "text-muted-foreground")} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">{address.label}</span>
                    {address.id === card.suggestedId && <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-xs font-medium text-brand">Suggested</span>}
                    {forSomeoneElse && <span className="text-xs text-muted-foreground">For {address.name}</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{address.line}</span>
                </span>
                {current ? (
                  <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
                ) : (
                  editable && <ChevronRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {card.total !== undefined && card.total > card.addresses.length && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Showing {card.addresses.length} of {card.total} saved addresses.
        </p>
      )}
    </Frame>
  );
}

/** What `update_cart` was asked to do, with names and photos from the cards shown so far. */
function ItemsOnTheirWay({ input }: { input: unknown }) {
  const items = (input as { items?: unknown } | null)?.items;
  const list = Array.isArray(items) ? (items as { spinId?: unknown; quantity?: unknown }[]) : [];
  if (!list.length) return null;
  return (
    <ul className="divide-y">
      {list.map((item, i) => {
        const spinId = typeof item.spinId === "string" ? item.spinId : "";
        const product = knownProduct(spinId);
        return (
          <li key={spinId || i} style={{ animationDelay: `${i * 80}ms` }} className="flex items-center gap-3 px-4 py-2 motion-safe:animate-in motion-safe:fill-mode-both motion-safe:fade-in motion-safe:slide-in-from-left-2">
            <Photo src={product?.imageUrl} name={product?.name ?? "Item"} width={96} className="size-10 shrink-0 rounded-lg" />
            <span className="min-w-0 flex-1 truncate text-sm">{product?.name ?? "An item"}</span>
            {typeof item.quantity === "number" && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">× {item.quantity}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function workingLabel(tool: string, input: unknown) {
  const args = (input ?? {}) as { query?: unknown; items?: unknown };
  switch (tool) {
    case "search_products":
      return typeof args.query === "string" && args.query ? `Looking for “${args.query}”` : "Looking through Instamart";
    case "your_go_to_items":
      return "Finding what you usually buy";
    case "update_cart": {
      const n = Array.isArray(args.items) ? args.items.length : 0;
      return n ? `Updating your cart with ${n} ${n === 1 ? "item" : "items"}` : "Updating your cart";
    }
    case "get_cart":
      return "Checking your cart";
    case "get_addresses":
      return "Finding your delivery address";
    case "checkout":
      return "Placing your order";
    default:
      return "Working with Instamart";
  }
}

export function InstamartWorking({ tool, input }: { tool: string; input: unknown }) {
  return (
    <Frame wide={tool === "search_products" || tool === "your_go_to_items"}>
      <Header connected />
      <div role="status" className="flex items-center gap-2 px-4 py-3 text-sm">
        <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-brand" />
        {workingLabel(tool, input)}
      </div>
      {tool === "update_cart" && <ItemsOnTheirWay input={input} />}
      {(tool === "search_products" || tool === "your_go_to_items") && <WorkingTiles />}
    </Frame>
  );
}

/** Above the approval for a cart change: what it would add, since its input is only ids. */
export function InstamartPendingItems({ tool, input }: { tool: string; input: unknown }) {
  if (tool !== "update_cart") return null;
  return (
    <div className="mb-3">
      <Frame>
        <Header connected />
        <ItemsOnTheirWay input={input} />
      </Frame>
    </div>
  );
}
