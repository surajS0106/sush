// The `weather_show` tool: the weather now in a place, the next 24 hours and 7 days, as a
// pixel-art card in the chat (`components/weather-card.tsx`). The figures come from
// Open-Meteo through Rust (`sush_core::weather`), with no key. The result stays out
// of shared sessions (`share/redact.rs`), since the place is usually where the user is.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, errorMessage, type LocalWeather, type ToolSpec } from "@/lib/tauri";

export const WEATHER_SHOW = "weather_show";

export type TemperatureUnit = "c" | "f";

/** The usual unit in the user's region, until they pick one. */
function regionUnit(): TemperatureUnit {
  try {
    return new Intl.Locale(navigator.language).region === "US" ? "f" : "c";
  } catch {
    // An unreadable language setting gets Celsius.
    return "c";
  }
}

// On the weather card and in Settings → General. Also used by the flight card's tile.
const temperatureUnit = createStore<TemperatureUnit>("sush.temperature-unit", regionUnit());
export const useTemperatureUnit = () => useSyncExternalStore(temperatureUnit.subscribe, temperatureUnit.get);
export const setTemperatureUnit = (unit: TemperatureUnit) => temperatureUnit.set(unit);
export const TEMPERATURE_UNITS: { value: TemperatureUnit; label: string }[] = [
  { value: "c", label: "°C" },
  { value: "f", label: "°F" },
];

const MAX_PLACE = 200;
const MAX_LABEL = 60;

export const weatherTool: ToolSpec = {
  name: WEATHER_SHOW,
  description:
    "Show the user the current weather and forecast as a card in the chat, which they can expand for the next 24 hours, " +
    "the next 7 days, the chance of rain, wind, humidity, UV and sunrise and sunset. Use it whenever they ask about " +
    "the weather, the temperature, the forecast, or whether to take an umbrella or a jacket, and use it instead of " +
    "map_show for those. If they mean where they are, get the place with location_get first; if they name a place, " +
    "don't ask for their location. It reaches a week ahead; for a date further off, say it can't. The card is " +
    "shown right under the call and holds the figures, so don't repeat them: add at most a sentence of advice.",
  inputSchema: {
    type: "object",
    properties: {
      place: {
        type: "string",
        description: "A city in English, e.g. 'Chennai' or 'Portland, Maine', or location_get's `place`.",
      },
      label: {
        type: "string",
        description: "With a `latitude,longitude` place: the name of the city you recognise there, shown on the card. Leave it out if you aren't sure.",
      },
    },
    required: ["place"],
  },
};

/** What the tool's output holds; the card renders it. */
export interface WeatherOutput extends Omit<LocalWeather, "place"> {
  place: string;
  /** In ms: it goes stale in a saved chat. */
  fetchedAt: number;
  note: string;
}

const note = () =>
  "The user sees all of this on the card. Don't repeat the figures; add at most a sentence of advice. Don't repeat the place if it came from location_get. " +
  `If you do mention a temperature, give it in ${temperatureUnit.get() === "f" ? "Fahrenheit" : "Celsius"}, the unit the user picked.`;

export async function runWeatherShow(input: unknown): Promise<{ output: WeatherOutput } | { errorText: string }> {
  const { place, label } = (input ?? {}) as { place?: unknown; label?: unknown };
  if (typeof place !== "string" || !place.trim()) return { errorText: "weather_show needs a `place`." };
  if (place.length > MAX_PLACE) return { errorText: `\`place\` must be ${MAX_PLACE} characters or fewer.` };
  let weather: LocalWeather | null;
  try {
    weather = await api.weatherNow(place.trim());
  } catch (e) {
    return { errorText: `Couldn't get the weather: ${errorMessage(e)}` };
  }
  if (!weather) return { errorText: `No weather found for "${place}". Try the name of a nearby city.` };
  const named = typeof label === "string" ? label.trim().slice(0, MAX_LABEL) : "";
  return { output: { ...weather, place: weather.place ?? (named || "Your location"), fetchedAt: Date.now(), note: note() } };
}

// Temperature as colour, in °C whatever unit is shown, so 30° looks the same in any city.
const TEMPERATURE_STOPS: [number, [number, number, number]][] = [
  [-10, [63, 111, 214]], // deep blue
  [0, [78, 168, 230]], // sky blue
  [10, [47, 181, 160]], // teal
  [18, [140, 198, 63]], // green
  [22, [246, 201, 69]], // gold
  [28, [242, 140, 56]], // orange
  [34, [233, 74, 53]], // salmon
  [42, [179, 34, 47]], // deep red
];

function temperatureColor(celsius: number) {
  const stops = TEMPERATURE_STOPS;
  const next = stops.findIndex(([at]) => at >= celsius);
  if (next === 0) return `rgb(${stops[0][1].join(" ")})`;
  if (next === -1) return `rgb(${stops[stops.length - 1][1].join(" ")})`;
  const [fromAt, from] = stops[next - 1];
  const [toAt, to] = stops[next];
  const t = (celsius - fromAt) / (toAt - fromAt);
  return `rgb(${from.map((v, i) => Math.round(v + (to[i] - v) * t)).join(" ")})`;
}

/** A left-to-right gradient for a bar from `low` to `high`, passing through the scale's colours between them. */
export function temperatureGradient(low: number, high: number) {
  const span = Math.max(high - low, 0.01);
  const between = TEMPERATURE_STOPS.filter(([at]) => at > low && at < high).map(([at]) => `${temperatureColor(at)} ${((at - low) / span) * 100}%`);
  return `linear-gradient(to right, ${[`${temperatureColor(low)} 0%`, ...between, `${temperatureColor(high)} 100%`].join(", ")})`;
}

/** Wind in the units that go with the temperature unit. */
export const windSpeed = (kmh: number, unit: TemperatureUnit) => (unit === "f" ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`);

/** A `YYYY-MM-DDTHH:MM` time, read as the place's own clock whatever the user's time zone. */
export const clockTime = (time: string, options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }) =>
  new Date(time).toLocaleTimeString(undefined, options).replace(/\s/g, " ");

/** Degrees in the unit the user picked (`useTemperatureUnit`). */
export function degrees(celsius: number, unit: TemperatureUnit) {
  return `${Math.round(unit === "f" ? (celsius * 9) / 5 + 32 : celsius)}°`;
}
