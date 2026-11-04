# Flight Globe — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04 (stops)
- The globe flies the picked flight's real stops: `FlightGlobe` takes `via`, and `planFlight` runs one `planLeg` per leg. The plane lands at each stop for `STOP_MS`, with the landing ring and a "Stop in Singapore" readout, then takes off again. All legs are drawn from the start, flown ones solid and later ones dashed, with a dot and name at every stop.
- Every leg starts and ends at one shared zoom, north up, so the camera doesn't jump at a stop. Each stop adds `EXTRA_LEG_MS` of flying, shared between legs by the square root of their length.
- Picking another flight starts the new route from the beginning, fading in (`flownRoute`). With reduced motion, the still frame fits every stop (`overview`).
- Stops come from a bundled table (`src/lib/airports.ts`, `airports.json`).
- When the line leaves out stops, a note on the globe says so (`UnplacedStops` in `src/components/flight-card.tsx`). A card saved before stops were kept also suggests searching again. A straight line on such a card was reported as the feature not working, since it looks exactly like a direct flight.

### 2026-11-04 (later)
- The route and glow use the user's accent, and the sea and land are neutrals tinted with it. They're read from `--brand` and mixed by hand, since a canvas can't read CSS variables and not every webview has `color-mix`. Changing theme or accent repaints the map (`paletteOf`).
- A soft atmosphere outside the Earth and a darker edge inside it, drawn only while the edge is in frame (`paintMap`).
- The flown part of the route has a glow, and a ring spreads from the destination on landing. `SETTLE_MS` went from 400 to 600 to fit it.
- A distance readout in the corner: "8,420 km to go", then "13,860 km flown". Fahrenheit users get miles (`paintReadout`).

### 2026-11-04
- The camera now moves for the whole flight. It starts close on the origin, follows the plane along the great circle, pulls back at mid-route and pushes in on the destination, where it rests (`src/components/flight-globe.tsx:119-160`). It used to stay still, framed on the route's midpoint.
- The peak zoom is worked out from the route's length so the route fits the frame in any orientation. Long routes show the whole Earth and short hops pull back a little (`flight-globe.tsx:125-126`).
- The ground covered per frame is scaled by the inverse of the zoom, so the Earth crosses the frame at an even speed (`flight-globe.tsx:129-140`).
- The camera rolls as it travels. North is up at both ends, and the route's direction on screen turns steadily between them (`flight-globe.tsx:143-154`).
- The route's arc is a lift above the globe's surface, so it scales with the zoom. It used to be a fixed screen offset (`paintFlight`).
- The coarse map is drawn on every moving frame, with borders. The detailed map is painted once, after landing, and fades in during a new `settle` stage (`paintLanded`, `flight-globe.tsx:346`).
- Painting is capped at about 60 fps, up from 30 fps for the old zoom-in (`FRAME_MS`).
- The flight takes 7 s, up from 5.5 s, because the same time now covers the zoom as well as the route (`FLIGHT_MS`).
- Each city's name sits on the side of its dot away from the route, chosen once per flight (`fromSide`, `toSide`). It moves clear of a plane on top of it and fades at the Earth's edge.
- Hovering to replay now fades out first, because the camera has to return from the destination to the origin (`flight-globe.tsx:451`).
- With reduced motion there is still one still frame: the whole route, north up, with the plane 72% of the way along (`paintStill`).

## Why

Landing at each stop was chosen over flying through it. The route changes direction sharply there, and the camera rolls to follow the route, so passing through would spin the Earth. Landing also says what a stop is: a place the traveller spends time. The cost is a longer flight, about 10 seconds with one stop instead of 7.

The legs are great circles between airports, not the path an aircraft actually flew. Ignav gives airports, not tracks. The airports and their order are real, which is what the user needs for comparing routes.

The airport table is bundled because the other sources were worse. Open-Meteo's geocoder reads a code as a place name: SIN gave Singa in Sudan and KUL gave Kulti in India, which would put wrong dots on the map with no sign of error. Ignav's lookup is a billed request. The table costs about 130 KB, loaded only when a route has a stop, and can go out of date as airports open. A code that isn't in it is skipped, so the route stays right from end to end but misses that stop.

A still camera made the globe read as a static map with a plane on it. A flight map on a seat-back screen tells the trip through the camera: where you leave, how far you are going, where you arrive. The camera movement is what carries that, so it is worth the cost of redrawing the map.

The earlier code held the camera still because the detailed map costs too much per frame on the UI thread. That limit still applies to the detailed map (about 25 ms to project), but the coarse map takes about 3 to 5 ms, which leaves room for a moving camera. The trade-off is rough coastlines while moving, most visible at close zoom on takeoff and approach. The detailed map appears only once the camera has stopped, and the origin is never shown with it.

The zoom, travel and roll are tied together because each one alone looks wrong. Zoom and travel on separate curves whip the map past at close range. Keeping north up all the way spins the Earth around the pole on routes that pass near it, such as Chennai to San Francisco or London to Auckland.

Destination close-ups mean the detailed map now loads on every animated flight, where long routes used to skip it. It loads when the globe first appears, so decoding happens before the plane sets off. The cost is that chunk's download and decode for each session that shows a route.

At rest, the card now shows the destination up close and not the whole route. Hovering replays the flight, and the route's text stays in the card below the globe.

## What makes it stand out

Compared with a globe whose camera interpolates center and zoom on one eased curve, or a library globe:

- The peak zoom comes from the route's length, so a 290 km hop and a 15,000 km route both fill the frame without per-route tuning.
- The camera path is a great circle with a calculated roll, so a route near the pole does not spin the map. Both ends are north up.
- It has no WebGL, tile server or network dependency. The maps ship in the bundle and draw on a 2D canvas.
- Measured in headless WebKit at 2x on a 700 x 256 canvas: frames about 17 ms apart with 3 to 4 ms of work per frame, and no frames requested at rest. Painting also stops off screen.
- The fade from coarse to detailed happens with the camera stopped, so the slow paint causes no visible hitch.
- Reduced motion gets a complete still frame showing the whole route, not a frozen moment of the close-up.
