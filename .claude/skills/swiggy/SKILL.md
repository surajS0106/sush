---
name: swiggy
description: Work on Sush's Swiggy integration, the Food and Instamart MCP connectors with their cards, order confirmation and safety rules. Use when changing how Swiggy tools render or get approved, adding a Swiggy service such as Dineout or Scenes, applying for Swiggy production access, or adding any connector tool that spends the user's money.
---

# Swiggy connectors

Swiggy runs one MCP server per service. Sush talks to them as ordinary connectors from Customize → Connectors → Discover, so sign-in, tool listing and tool calls need no Swiggy code. The Swiggy code covers cards, the confirm step and safety rules.

| Service | Catalog id and name | URL | Tool prefix | Order tool | Status |
| --- | --- | --- | --- | --- | --- |
| Food | `swiggy`, Swiggy | `https://mcp.swiggy.com/food` | `swiggy__` | `place_food_order` | Tried on a real account: sign-in, cart |
| Instamart | `instamart`, Instamart | `https://mcp.swiggy.com/im` | `instamart__` | `checkout` | Tried on a real account: cart, sync to the phone app |
| Dineout | not added | `/dineout` | | `book_table` | |
| Scenes | not added | `/scenes` | | `place_event_order` | |

No order has been placed through Sush yet, so the order and tracking cards are unproven on both services.

## Where things are

| What | Where |
| --- | --- |
| Catalog entries, `placesOrder` | `apps/desktop/src/lib/connector-catalog.ts` |
| Output parsers, service and tool lookup | `apps/desktop/src/lib/swiggy.ts` |
| Cards and the confirm card | `apps/desktop/src/components/swiggy-card.tsx` |
| Where the cards are used | `ConnectorPart` in `components/tool-parts.tsx` |
| Keeping cards out of the collapsed activity line | `groupableTool` in `components/activity-group.tsx` |
| Extra instructions for the model | `toolNote` in `lib/agent.ts` |
| Live cart read for the confirm card | `swiggy_order_preview` in `src-tauri/src/connectors.rs`, `api.swiggyOrderPreview` in `lib/tauri.ts` |
| Always asking before spending | `places_order` in `crates/sush-core/src/share/policy.rs`, `Host::approval` in `src-tauri/src/runs.rs`, `runsWithoutApproval` in `lib/agent.ts` |
| Hiding calls from shared-session guests | `is_delivery_tool` in `crates/sush-core/src/share/redact.rs` |
| Image hosts | `img-src` in `tauri.conf.json` and `tauri.release.conf.json` |

## Rules to keep

- **Spending always asks.** A connector tool whose name starts with `place`, `checkout`, `book`, `buy`, `purchase`, `pay` or `order` asks every time, even in Auto mode or with an old "Always allow", and only the owner can answer. `places_order` (Rust) and `placesOrder` (TS) must stay in step, and `approvalClass` in `lib/share.ts` must keep matching `classify`.
- **The confirm card shows Swiggy's figures.** Order tools only take an address and a payment method, so the card reads the live cart through `swiggy_order_preview` and reads it again on Confirm. Never build it from the model's text. The command only reads named tools; the webview doesn't get to call connector tools itself.
- **Orders aren't safe to retry.** After a server error, check `get_food_orders` or `get_orders` first. Never set Instamart's `confirmDuplicate` to retry a failed call; Swiggy warns that this can charge the user twice.
- **UPI isn't placed until it's confirmed.** The order tool returns `PENDING_PAYMENT`. The card opens `bridgeUrl`, and Sush never draws its own QR code. The order is placed only after `check_payment_status` succeeds and `confirm_order` runs.
- **Parsers fail quietly.** A parser returns null on anything unexpected, and the call stays a plain connector row. Swiggy's docs give schemas but no example responses, so trust real output over the docs.
- **Attribution travels with the content.** Each card shows "Powered by Swiggy" or "Powered by Instamart" for its own service. Swiggy's guidelines say a footer or a one-time message isn't enough.
- **The logo isn't recoloured.** Connector icons in `assets/connectors/` are single-colour masks, which Swiggy's brand rules forbid. Official logos go in `assets/brands/` and `BRAND_LOGOS` (`connector-catalog.ts`), rendered as plain images with corners rounded to 20% of the width. Swiggy's minimum is 24px with 8px of clear space, so chat tool rows show the logo at 24px, and the @ menu's 16px slot keeps its generic icon.

## How the services differ

| | Food | Instamart |
| --- | --- | --- |
| Cart read | `get_food_cart`, takes `addressId`, cart under `data.data` | `get_cart`, no arguments, cart directly under `data` |
| Cart update | Adding from the same restaurant kept what was there in testing; changing restaurant replaces the cart | `update_cart` **replaces the whole cart**, so send every item to keep |
| Prices | Numbers | Bill values are text such as `₹120`; item prices are numbers |
| Order limit | ₹1000 cap | ₹99 minimum |
| Order result | One order | Can be one order per store, with partial success |
| No `paymentMethod` | Cash, when it's the only option | Swiggy picks one, possibly Swiggy Money, so the card blocks this |
| Tracking | `track_food_order`, a list of orders | `track_order`, needs `orderId`, `lat`, `lng`, returns one order |

`confirm_order` and `check_payment_status` exist on both with different arguments, so look tools up per service. Tool names can also clash with other connectors (`checkout`, `update_cart`), so go by `swiggyService`, never by the tool name alone.

## What real testing found

- **Food cart sync looks one-way.** On one account, an item added in the phone app appeared in `get_food_cart`, but items added through `update_food_cart` stayed out of the app after it was fully closed and reopened. Swiggy's docs imply otherwise, and the question went to builders@swiggy.in on 2026-11-04. Update `toolNote` and the cart card's line when they answer.
- **Instamart cart sync works.** An item added through Sush showed in the phone app after a refresh, so only Food's cart has the problem and only Food's card carries the "may not show" line. It also means a careless `update_cart` changes the cart the user sees on their phone.
- **The model invents explanations.** Asked about the sync, it claimed a "temporary session cart" and pushed the user to place the order. Facts it needs go in `toolNote`, with an instruction not to guess.

## Adding a service

1. Read its recipe and tool pages. The list of pages is at `https://mcp.swiggy.com/builders/llms.txt`.
2. Add a catalog entry, its square logo (the [brand page](https://mcp.swiggy.com/builders/docs/operate/brand-guidelines.md) lists them), and a `SwiggyService`, `SERVICE_NAME`, `ORDER_TOOL` and `WITH_CARD` entry.
3. Add parsers and cards, with its own "Powered by" name.
4. Extend `swiggy_order_preview` if it has an order to confirm. Check `places_order` catches its order tool.
5. Add its prefix to `is_delivery_tool`, with a test, and any new image host to both CSPs.
6. Add anything the model must not get wrong to `toolNote`, and update this skill.

## Testing

Run the app with the `run-app` skill and add the connector from Discover. Sign-in is by phone number and OTP in the browser, so it needs the account owner.

- **Don't confirm an order by accident.** The production server places real orders; click "Don't order" on the confirm card. Staging (`mcp-staging.swiggy.com/{server}`) has seeded data and no real orders, but access comes with the production application.
- **If a card doesn't appear,** expand the plain row to see the real output and fix the parser. `flatten_result` in `crates/sush-core/src/mcp/mod.rs` keeps only text content, and uses `structuredContent` only when there is no text.
- **Check amounts and photos.** Compare prices with the Swiggy app to catch wrong units. A missing photo usually means a host missing from `img-src`.

## Going to production

Swiggy needs an application at `https://mcp.swiggy.com/builders/access/` with a demo video, then 48 hours or more of green staging, then allowlisted redirect URIs. Still open:

- **Redirect:** Sush signs in on `http://localhost` with a random port (`connector_auth.rs`). Swiggy matches exactly and wants HTTPS outside development. Sush has no backend, so ask for a fixed localhost port or a `sush://` scheme.
- **Personal data:** Swiggy treats addresses and orders as personal data and requires a signed agreement to send them outside India or Singapore. Sush sends full tool output to the user's chosen model and saves it in `sush.db`. Ask Swiggy how this applies to a desktop app, or trim what reaches the model.

Docs: [reference](https://mcp.swiggy.com/builders/docs/reference/index.md), [order food](https://mcp.swiggy.com/builders/docs/build/recipes/order-food.md), [order groceries](https://mcp.swiggy.com/builders/docs/build/recipes/order-groceries.md), [pay with UPI](https://mcp.swiggy.com/builders/docs/build/recipes/pay-with-upi.md), [data rules](https://mcp.swiggy.com/builders/docs/operate/data-and-compliance.md).
