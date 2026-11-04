# Weather Card: Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- New `weather_show` tool (`src/lib/weather.ts`, wired in `src/lib/agent.ts`). It runs without approval, like `map_show`, and takes a city name or `location_get`'s coordinates, plus an optional `label` naming the city at those coordinates.
- New `local_weather` in `crates/sush-core/src/weather.rs`, exposed as the `weather_now` command (`src-tauri/src/weather.rs`). It returns the current temperature, feels-like, code, day or night, and today plus three days. A name that the geocoder can't find is retried with each comma's tail, so "12 Main Road, Adyar, Chennai" ends at "Chennai".
- New card (`src/components/weather-card.tsx`): a large bitmap temperature, an icon and condition word, and the next three days over an animated scene. The place sits at the top, and the attribution sits below the card.
- New scene renderer (`src/lib/weather-scene.ts`): a 108×108 canvas scaled with `image-rendering: pixelated`. The sky, sun or moon and hills are dithered once into a buffer. Clouds, rain, snow, fog, stars, birds and lightning are drawn over it at about 8 frames a second.
- The picked mascot stands in the scene. Awake, it is the real `Mascot` with `still`. It gets an umbrella in rain and storms, a hat in snow, and is asleep at night (`MascotSprite` with `closed`).
- Clouds are billowy sprites, overlapping puffs lit from the upper left. Partly cloudy is open sky with a big cloud across the foot of the sun or moon. Cloudy overlaps clouds under a scalloped ceiling until little sky shows, and rain, storm and snow get the same ceiling, with rain falling from under it (`CLOUD_LAYOUTS`, `deckSprite` in `src/lib/weather-scene.ts`).
- The card's look follows the sun at the place, not the app's theme. `local_weather` adds a `phase` from today's sunrise and sunset (`phase_of` in `weather.rs`): dawn from 45 minutes before sunrise to 30 after, dusk from 30 before sunset to 45 after. Dawn and dusk use sunrise and sunset hues as the whole background: dawn is pink over peach and gold with ink type, leading into a light day, and dusk is wine over ember and orange with rice type, leading into a dark night (`DAY`, `NIGHT`, `DAWN`, `DUSK` in `src/lib/weather-scene.ts`). Where the sun doesn't rise or set, it falls back to Open-Meteo's `is_day`.
- Hues widened from Sush's teal and salmon to sky blues, midnight blues, rose and apricot, with the Sush salmon kept for the umbrella and lightning.
- Clicking the card, or the expand button under it, opens a dialog with the card, today's figures (feels like, high, low, chance of rain, humidity, wind, UV, sunrise, sunset), the next 24 hours and the next 7 days with a temperature range on one scale (`Expanded` in `src/components/weather-card.tsx`). The dialog's colours follow the phase. `local_weather` now fetches eight days and 24 hours with these figures.
- All bitmap text is drawn at a whole number of CSS pixels per bitmap pixel, and the 7-day rows have a fixed height (`PixelText`, `NextWeek`). At 1.5, rows and columns snapped to different thicknesses, so digits looked shaved off.
- The canvas and what sits on it have explicit layers (`z-0`, and `z-10` with `transform-gpu`), after the sleeping mascot was reported missing in the expanded view in the app. It could not be reproduced in Chrome or a WKWebView snapshot, so the cause is inferred: it was the only piece over the canvas without a layer. The sleeping mascot also breathes now.
- The 7-day range bars are a gradient from the low's colour to the high's, on one fixed scale in °C from deep blue through teal, green, gold and orange to red (`temperatureGradient` in `src/lib/weather.ts`).
- A click on the mascot stays with the mascot and doesn't expand the card, so its hearts and backflip keep working.
- The expanded view's Today, Next 24 hours and Next 7 days sections are set in the chat font from Settings → General (`--transcript-font` on `DialogContent`), not bitmap type. The card in the dialog and the small condition icons stay pixel.
- Privacy paths: `weather_show` joined `PRIVATE_TOOLS` (`share/redact.rs`), and `forget_locations_in` (`store.rs`) removes a card drawn from a session-only location. The location card now names Open-Meteo.
- `location_get` and `map_show` descriptions steer weather questions to the new tool. `degrees` moved from `flight-card.tsx` to `lib/weather.ts`.
- Users can choose Celsius or Fahrenheit: a `Segmented` control under the card and a Units group in Settings → General, both on one saved preference (`sush.temperature-unit` in `lib/weather.ts`). It starts from the system region. The flight card's weather tile follows it, and the tool's note tells the model which unit to use.

## Why

Asked about the weather, the model had no weather tool. It called `location_get`, drew a map and told the user to check a weather service. `sush_core::weather` could already reach Open-Meteo, but only for the flight card's tile. The fix had to be a tool the model calls, since no restyling of the map would have produced a forecast.

The first clouds were two small shapes reused in every sky, so "Cloudy" looked like a clear sky with specks and barely differed from "Partly cloudy". How much of the sky is covered is now the difference between those two states. The clouds are muted against the sky so type stays readable over them, which costs some brightness.

The card shows what the sky looks like at that place right now, so a card for somewhere in the dark reads as dark even in a light chat, and two cities in one chat can differ. That gives up matching the app's theme. Weather greys their colours (`GLOOM`) rather than replacing them, so a rainy dusk still looks like dusk.

The compact card stays a glance, and the detail is there for whoever wants it, as the map card does with its expand button. The extra figures are stored in the tool's result instead of being fetched on expand. That costs some tokens on each later turn in the chat, in exchange for follow-up questions the model can answer, and an expanded view that works in a saved chat with no network.

Bitmap type suits the card, which is a picture read at a glance. The expanded view is a table of figures read closely, so it uses the font the user picked to read with, at the cost of a seam between the pixel card and the panel beside it.

The gradient's colours are tied to the temperature and not to each week's range, so colour means the same thing between cards and a cold week reads as cold. It uses several hues where a single-hue scale would be the stricter choice, because blue-to-red is the familiar reading for temperature. The low and high are always printed beside each bar, so nothing depends on colour alone.

The look comes from a pixel-art weather reference, redrawn in Sush's colours. Night stays midnight blue rather than the reference's indigo, keeping purple out of the card. Bitmap type follows Yammer's `pixel.tsx`, drawn in the same pixels as the mascot. A font package would have been easier, but it would blur at small sizes and need another dependency. The trade-off is that a place name with characters outside the bitmap face falls back to Geist.

Open-Meteo has no reverse geocoding, so coordinates carry no place name. The model supplies `label` from what it recognises, and the card says "Your location" when it doesn't. A wrong label is possible. A second service for reverse geocoding would have sent the user's position to one more company.

A location shared for one session must not survive in a card, so the whole call is removed rather than only its coordinates: the output names the city.

The unit used to be inferred from the region with no way to change it, which is wrong for anyone whose system region doesn't match what they read. The control sits on the card because that is where the wrong unit is noticed, and in Settings so it can be found without asking for the weather first. Figures stay stored in Celsius and are converted on display, so a saved card changes with the preference.

## What makes it stand out

- The obvious version is a styled card with a Lucide icon, like the flight card's tile. This one has eight skies in four phases of the day, chosen from the live WMO code and the place's own sunrise and sunset.
- The mascot is the user's own pick and still responds: its eyes follow the pointer, and clicks give hearts and a backflip.
- Rain and snow land on the hills, so the forecast below stays clear of moving pixels. Clouds are muted against the sky so type over them stays readable.
- Scenes pause off screen and in hidden windows (`IntersectionObserver`, `document.hidden`), so a long chat holding many cards doesn't keep drawing them. Under reduced motion each is one still frame.
- The whole scene is one `role="img"` with a spoken summary, including the feels-like and today's high and low that the card only shows on hover.
- A card reopened more than an hour later shows when its figures were fetched.

Limits: a card doesn't refresh itself in a saved chat. The forecast's 8-day reach is fixed in `local_weather`, so the tool tells the model to say it can't answer for dates further off. The flight card's weather tile keeps its existing style.
