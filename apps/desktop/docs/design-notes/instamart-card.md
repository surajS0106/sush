# Instamart card — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- Parsers read Swiggy's real output: instructions for the model followed by bare fields, with no `{ success, data }` wrapper. `get_addresses` is read as text, one line per address. (`src/lib/swiggy.ts`)
- New search and cart card with photo tiles, discount tabs, Add and quantity controls, a cart bar and the bill. Its header holds the required attribution and the connection status. (`src/components/instamart-card.tsx`)
- A working state per tool: the search term with placeholder tiles, or the items being added with their names and photos. (`InstamartWorking`)
- Controls change the cart directly, with no model turn, through two commands limited to Instamart's server: `instamart_cart_read` and `instamart_cart_write`. (`src/lib/instamart-cart.ts`, `src-tauri/src/connectors.rs`)
- Only each reply's last cart call shows as a card; earlier ones collapse into the activity line. (`src/components/activity-group.tsx`)
- Search and cart results reach the model with Swiggy's display instructions replaced by "the user already sees this as a card", keeping the JSON. (`instamart_for_model` in `src-tauri/src/connectors.rs`, `src-tauri/src/runs.rs`)
- `toolNote` repeats that, and says not to add items again when a read returns an older cart. (`src/lib/agent.ts`)
- New address card: every saved address with its label, Swiggy's suggestion marked, and the recipient shown only when it isn't the usual one. One click sends the pick to the model with the address id, then the card shrinks to the choice with a Change button. Older cards with no pick collapse to a plain row. (`InstamartAddresses`, `savedAddresses` in `src/lib/swiggy.ts`, `addressPickInstruction` in `src/lib/instamart-cart.ts`)
- `get_addresses` results reach the model with only the count, rows and suggested id, plus a note to ask for a pick from the card. (`instamart_addresses_for_model` in `src-tauri/src/connectors.rs`, `toolNote`)
- `get_cart` and `update_cart` results now split in two: the model gets item names, quantities, ids, the total and any warnings, and the full result goes under `cardOnly`. `envelopeData` unwraps it for the card and Swiggy's widget. (`instamart_output` in `src-tauri/src/connectors.rs`, `src-tauri/src/runs.rs`, `src/lib/swiggy.ts`)
- A bar above Swiggy's widget says it can't change the cart and shows it as of that message, with a link to Sush's view. (`InstamartCard`)
- A finished `clear_cart` now counts as the thread's latest cart, an empty one, so the cards forget what they remembered. (`instamartThread` in `src/lib/instamart-cart.ts`)
- The model is told that card taps reach Swiggy without a message, so it reads the cart when the user says they've picked something and before any `update_cart`. (`toolNote`, `instamart_for_model`)
- `update_cart` and `clear_cart` notes no longer treat a successful call as final: the model says Swiggy accepted a change, calls `get_cart` on its own before saying a cart is cleared, reports what a read shows, and doesn't add items again unless asked. (`toolNote`, `instamart_for_model`)
- Experiment: a Sush / Swiggy's toggle frames Swiggy's own widget from `resources/read`, for tools that advertise one in `_meta`. (`src-tauri/src/widgets.rs`, `InstamartWidget`)

## Why

The cards never appeared on real output because the parsers followed Swiggy's reference rather than what the server sends. The model then obeyed the result's "display in a tabular format". The same mismatch would have blocked every order on the confirm card, so the fix covers `addressLine` too.

The first attempt only told the model in the tool's description not to repeat the card. It still wrote a table under the card, because the result itself said to. Replacing the text in the result removes the competing instruction. Saved chats keep their old text, and a model can still ignore the new note.

Checkout stays a message to the model, so it still ends at the confirm card that reads the live cart. The card's commands can't reach `checkout`.

`update_cart` replaces the whole cart, and saved calls show `get_cart` returning fewer items right after a write. A write therefore merges the fresh read with what the card already knows and keeps a list of removed items. The trade-off is that an item removed in the phone app moments earlier can come back if the card still holds it.

A saved chat shows the model writing a full cart table with "don't write a table" at the start of that same result, so instructions alone aren't enough. Withholding per-item prices and the bill removes most of what a table would repeat. The total stays so the model can answer in one sentence, and names, quantities and ids stay because `update_cart` needs them. The model can still list names and quantities, or reuse prices from earlier search results or older saved messages in the same chat.

The model used to answer `get_addresses` with one suggested address in text, so the other saved addresses weren't a real choice. A pick is one click with no confirm step because choosing an address spends nothing, and checkout still ends at the confirm card with the live address. It is sent as a message because the model needs the id for its next calls. The result's own instruction to "confirm the suggestion" is removed, since a note in the tool description lost to the result's text on search and cart. If the user has already named an address, the model can use it and the card stays unpicked. This card is Instamart only, because no real Food `get_addresses` output has been saved to check against.

That merge also put cleared items back: the card ignored `clear_cart`, so the first tap after a clear saved the old cart with the new item. In one chat this fits a card showing 6 items at ₹631 after the user had picked 3, though taps aren't logged, so the match is inferred from the count and total. `clear_cart` now resets what the card remembers. A card in an older thread still holds that thread's last cart, and a tap there can bring those items back.

Card taps skip the model on purpose, so a change takes effect quickly and never needs a model turn. The cost is that the model can't see them: told "items have been selected", it asked the user to choose again. Adding taps to the thread would have changed what the model is sent on every turn, so it reads the cart on demand instead. This relies on the model following the note.

The earlier instruction to trust `update_cart` over a later read assumed a short lag. Saved calls show more than that: items gone 10 minutes after a read had shown them, with the same `cartId`, and an older cart returning under a new `cartId` after a clear. On 2026-11-04 the Swiggy app also still showed 7 items and ₹926 about 3 minutes after `update_cart` returned 5 items and ₹611. Whether the app had refreshed is unknown. The phone app writing back its own copy is the main suspect, not yet proven, so the notes ask the model to report what it sees rather than explain it. This makes Sush's replies accurate but doesn't stop the items changing. These changes haven't been built or run yet.

The controls use the user's accent (`brand`), like Sush's other cards, at the user's request. The first version used Instamart's logo blue, which they asked to change. The logo itself stays full colour, as Swiggy's brand rules require, and the feel of Instamart comes from the layout.

Swiggy's widget is served on its own scheme because a `srcdoc` frame inherits the app's CSP, which blocks its scripts. A 2026-11-04 screenshot shows it rendering a real cart. It answers both the MCP Apps handshake and `window.openai` because the HTML hasn't been seen, and it turns down tool calls for now. Its − and + buttons therefore look live but can't change the cart, and it shows the result of its own call, so a bar above it says so and links to Sush's view. Its content also stops short of the frame's right edge, and the cause can't be confirmed until the page's HTML has been inspected.

Unknown: whether `discountedFinalPrice` is per unit or per line. No saved cart has a quantity above 1, so the card shows the figure as sent and doesn't compute a savings total.

## What makes it stand out

- Prices, totals and availability are only ever Swiggy's figures. The total waits for the save rather than being estimated.
- Photos come through Swiggy's CDN at the size shown: one tested image went from 291KB to 11KB.
- The widget frame is sandboxed to `allow-scripts`, with a CSP built from the server's declared https origins, filtered so a value can't add a directive. Tool output stays in memory for the latest 8 pages only.
- Sponsored products are labelled, and Out of stock, pack limits and Swiggy's warnings are shown as Swiggy states them.
- Per-item prices and the bill from `get_cart` and `update_cart` stay out of what the model is sent, rather than relying on an instruction not to repeat them.
- The address card lists every address the result returned, and a pick carries its id to the model while the chat shows only "Deliver to Home". The pick is read back from the thread, so it survives a reload.
- Entrance motion plays only for a call that just ran, not for every card in a reopened chat, and respects reduced motion.
