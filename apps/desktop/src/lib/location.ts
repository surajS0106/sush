// The `location_get` tool: where the user is, when they agree in its card
// (`components/location-card.tsx`). Every call asks; there's no standing
// permission. It gives their saved address (Settings → Maps), or the device's
// position, which can be far off on a computer. The result stays out of shared
// sessions (`share/redact.rs`).

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";
import { api, errorMessage, type ToolSpec } from "@/lib/tauri";

export const LOCATION_GET = "location_get";

/** Below this the fix is too rough to route from without saying so (desktops often locate by network). */
const ROUGH_METERS = 2000;

const saved = createStore<string>("sush.saved-location", "");
export const useSavedLocation = () => useSyncExternalStore(saved.subscribe, saved.get);
export const setSavedLocation = (address: string) => saved.set(() => address.trim());

const PRIVATE_NOTE = "Pass `place` to map_show as `origin`, or to weather_show as `place`. Don't repeat it to the user.";

export const locationTool: ToolSpec = {
  name: LOCATION_GET,
  description:
    "Ask for the user's current location; they approve each request in the chat. Use it when the user says " +
    "'my location', 'from here', 'near me' or similar, or asks about the weather without naming a place, instead of " +
    "asking where they are. For directions, pass the `place` it returns to map_show as `origin`; for the weather, to " +
    "weather_show as `place`. If they decline or it fails, ask them to name a place. Don't " +
    "use it unless the request needs it, don't repeat the place in your reply, and don't save it to memory.",
  inputSchema: { type: "object", properties: {} },
};

/** What the tool's output holds. */
export interface LocationOutput {
  /** An address, or `latitude,longitude`: either is what map_show takes. */
  place: string;
  source: "saved" | "device";
  accuracyMeters?: number;
  note: string;
  /** Shared "for this session": `Store::forget_session_locations` removes it when the app quits. */
  temporary?: boolean;
}

export const savedLocationOutput = (address: string): LocationOutput => ({ place: address, source: "saved", note: PRIVATE_NOTE });

function failure(e: GeolocationPositionError) {
  if (e.code === e.PERMISSION_DENIED) {
    return "Location access is blocked. Allow it for Sush in your system's privacy settings, then try again.";
  }
  if (e.code === e.TIMEOUT) return "Finding your location took too long.";
  return "Your device couldn't find its location. Check that location services are on.";
}

/** The webview's position. On macOS it refuses without asking, so `readLocation` goes through Rust there. */
function webviewPosition() {
  return new Promise<{ latitude: number; longitude: number; accuracyMeters: number }>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location isn't available on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracyMeters: coords.accuracy }),
      (e) => reject(new Error(failure(e))),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

/** Read the device's position. Rejects with a message for the user. */
export async function readLocation(temporary = false): Promise<LocationOutput> {
  const isMac = navigator.userAgent.includes("Mac");
  // A command rejects with a plain string, and the card shows `message`.
  const position = await (isMac ? api.locationRead() : webviewPosition()).catch((e: unknown) => {
    throw new Error(errorMessage(e));
  });
  const accuracyMeters = Math.round(position.accuracyMeters);
  const rough = accuracyMeters > ROUGH_METERS;
  return {
    place: `${position.latitude.toFixed(5)},${position.longitude.toFixed(5)}`,
    source: "device",
    accuracyMeters,
    note: rough
      ? `${PRIVATE_NOTE} This fix is only good to about ${Math.round(accuracyMeters / 1000)} km, so tell the user it may be off and that they can save their address in Settings → Maps.`
      : PRIVATE_NOTE,
    ...(temporary && { temporary }),
  };
}
