// Where airports are, for drawing a flight's stops on the globe. `airports.json` holds
// [latitude, longitude, city] by IATA code, for every airport with scheduled service in
// OurAirports' public-domain data (https://ourairports.com/data/). City names are tidied
// by hand where the data names the airport's suburb. It's bundled because Open-Meteo's
// geocoder reads a code as a place name (SIN gives Singa, KUL gives Kulti), and Ignav's
// lookup is a billed request. It's loaded only when a route has a stop.

import type { GeoPoint } from "@/lib/tauri";

type Row = [latitude: number, longitude: number, city: string];

let table: Promise<Record<string, Row>> | null = null;
const load = () => (table ??= import("@/lib/airports.json").then((m) => m.default as unknown as Record<string, Row>));

export interface AirportStop {
  point: GeoPoint;
  name: string;
}

/** The airports we know of `codes`, in order. One we don't know is left out. */
export async function airportStops(codes: string[]): Promise<AirportStop[]> {
  const airports = await load();
  return codes.flatMap((code) => {
    const row = airports[code];
    return row ? [{ point: { latitude: row[0], longitude: row[1] }, name: row[2] }] : [];
  });
}
