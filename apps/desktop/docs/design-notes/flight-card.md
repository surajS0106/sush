# Flight Card: Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- The card follows the user's accent color: every Tailwind `sky`, `slate`, `emerald` and `rose` class is gone from `src/components/flight-card.tsx`. Tiles use `bg-card` and `border-border`; fills and highlights use `brand`; a price rising uses `coral`. Filled text is near black in dark mode, where every accent is light enough for it (`ACCENT_FILL`).
- The tiles now hold the cheapest fare, the fastest, then the cheapest from each other airline, with any room left going to the next cheapest (`pick_fares` in `crates/sush-core/src/flights.rs`).
- A search tries again after 1 and 3 seconds on Ignav's temporary `unable_to_complete_request` (424) or a dropped connection, as its docs advise (`search_once`). Failed requests aren't billed.
- A card's search asks Ignav up to twice more, excluding the airlines found so far, because one answer leans to the best few airlines and has no setting for more (`search_flights`, `EXTRA_SEARCHES`). Price alert checks stay at one request.
- Up to 40 other fares, at most 3 per airline, appear in a list under the tiles. Five show first, then "Show all". Each row books the same way a tile does (`MoreFares`, `FareRow`, `useSellers`).
- A tool output's `cardOnly` field stays in the thread but is removed before the model reads it (`CARD_ONLY` in `crates/sush-core/src/agent/ui.rs`). The list travels there, and the tool's note tells the model not to call the tiles the only airlines (`src/lib/flights.ts`).
- A °C/°F switch on the weather tile, using the preference the weather card and Settings already share (`WeatherTile`).
- A searchable currency picker above the fares and in Settings → Flights, labelled with what prices are in now and opening from that button (`src/components/currency-select.tsx`, `src/lib/currency.ts`). A native-style select came first and was dropped: 166 rows with no search, running off the window's edge. Rates come from ExchangeRate-API through Rust, with no key (`exchange_rates`).
- The bento layout holds in every state: the card stays `max-w-3xl`, and when there are no fares a tile in the price alert's place says why and links to Google Flights and Kayak (`NoFaresTile`).
- Clicking a fare's tile or list row, or its globe button, shows that flight's outbound route on the globe (`pickedId`, `GlobeButton`, `pickOnClick`). The picked tile has a solid accent border and ring, a picked row a tint, and the globe starts on the cheapest. Clicks on Book and other buttons don't pick. The pill under the route describes the picked flight rather than always the fastest. A card with no globe has no picking. `FlightLeg.via` carries the stop airports from Ignav's segments (`parse_leg` in `crates/sush-core/src/flights.rs`).
- The cheapest fare's tile stands out: an accent tint over the card, a soft accent shadow, an accent border and a larger price (`FEATURED_TILE`, `FareTile`). It has the only filled Book button; every other tile and list row has a quiet one (`QUIET_BUTTON`). A search with one fare has nothing to compare, so that fare keeps the plain tile and filled button.
- Tiles fade and rise in with a 50 ms stagger, their border tints on hover, and Sush buttons scale to 0.97 on press. Reduced motion skips the entrance.

## Why

The card used stock Tailwind blues, so it looked like a different product inside Sush. Fixed Sush teal was tried first, but users pick an accent in Settings and the card should honor it like the rest of the app.

Keeping the six cheapest fares hid every airline but the one or two cheapest on a route. Dearer airlines can still be the right choice because of loyalty, schedule or preference, so choosing is left to the user. The trade-off is that the tiles are no longer strictly the six cheapest. Prices stay sorted within each group, and the cheapest and fastest are still tagged.

The repeat searches trade cost and time for coverage: up to two more billed requests per card and up to 30 seconds more waiting in the worst case. A failed repeat only ends the looking, so the card still shows what the first search found.

Two different flights can reach the same city by very different routes, and a trip-level route hid that. Tying the globe to a picked flight makes the difference visible. Being picked and being cheapest are separate signals, the ring and the tint, so both can be read when the user picks a dearer flight.

A small tag alone left the cheapest fare looking like its neighbours, since every tile had the same surface and the same filled button. The tile keeps its size, because making it wider would leave holes in the grid for some fare counts. The trade-off is that the dearer fares' Book buttons are less prominent, though they still read as actions.

Sending the list to the model would add its tokens to every later turn of the chat, so it stays on the card. The trade-off is that the model can't discuss those fares.

A converted price is an estimate, since sellers charge in their own currency. So conversion changes only what's shown: fares stay stored as quoted, price alerts compare the quoted figures, a converted price reads "≈" with the quoted one on hover, and a note explains this. Rates aren't fetched until someone opens the picker or has already picked a currency, so people who never use it contact no new service.

## What makes it stand out

Compared with sorting all fares by price and showing the first few:

- Airlines are chosen for variety, so one airline's many departures can't fill the card.
- The long list costs no model tokens, through a general `cardOnly` field other tools can use.
- Converted prices are marked as estimates and alerts can't fire because an exchange rate moved.
- 166 currencies from a keyless source, with the common ones first, and prices stay as quoted if rates can't load.
- Rates are cached for 12 hours, so a chat full of cards makes at most one request in that time.
