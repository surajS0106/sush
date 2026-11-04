//! Live fares for a flight card, with the user's own Ignav key
//! (https://ignav.com/docs/api-reference). Ignav only finds fares and links to
//! sellers; a ticket is bought on the seller's site, so nothing here can spend the
//! user's money. The key goes in a header, never a URL, so it can't turn up in an
//! error message.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API: &str = "https://ignav.com/api";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);
/// How many fares a card shows and the model reads.
const MAX_FARES: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Cabin {
    Economy,
    PremiumEconomy,
    Business,
    First,
}

impl Cabin {
    fn wire(self) -> &'static str {
        match self {
            Cabin::Economy => "economy",
            Cabin::PremiumEconomy => "premium_economy",
            Cabin::Business => "business",
            Cabin::First => "first",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightSearch {
    /// IATA airport or metro codes.
    pub origin: String,
    pub destination: String,
    /// `YYYY-MM-DD`.
    pub departure_date: String,
    /// Leave out for a one-way trip.
    pub return_date: Option<String>,
    pub adults: u32,
    pub children: u32,
    pub cabin: Cabin,
    /// 0 for nonstop, up to 2.
    pub max_stops: Option<u32>,
    /// The two-letter country to price in, which also sets the currency.
    pub market: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightLeg {
    pub carrier: Option<String>,
    pub duration_minutes: Option<u64>,
    pub stops: usize,
    pub from: String,
    pub to: String,
    /// Local time at the airport, e.g. `2026-12-03T08:00:00`.
    pub departs_at: String,
    pub arrives_at: String,
    /// e.g. "AA 100".
    pub flights: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fare {
    /// What `booking_links` looks a fare up by.
    pub id: String,
    pub amount: f64,
    pub currency: String,
    pub outbound: FlightLeg,
    pub inbound: Option<FlightLeg>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightResults {
    pub fares: Vec<Fare>,
    /// How many Ignav found, before keeping `MAX_FARES`.
    pub total: usize,
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLink {
    pub provider: String,
    pub is_airline: bool,
    /// False when the link opens a results page where the user picks the flight again.
    pub exact: bool,
    pub fare_name: Option<String>,
    /// What this link's legs cost. Absent when the seller gave no price.
    pub amount: Option<f64>,
    pub currency: Option<String>,
    pub url: String,
    /// What it covers: "outbound", "inbound" or both. A round trip can take two purchases.
    pub legs: Vec<String>,
}

fn search_body(search: &FlightSearch) -> Value {
    let mut body = json!({
        "origin": search.origin,
        "destination": search.destination,
        "departure_date": search.departure_date,
        "adults": search.adults,
        "children": search.children,
        "cabin_class": search.cabin.wire(),
        "market": search.market,
    });
    if let Some(date) = &search.return_date {
        body["return_date"] = date.as_str().into();
    }
    if let Some(stops) = search.max_stops {
        body["max_stops"] = stops.into();
    }
    body
}

fn parse_leg(leg: &Value) -> Option<FlightLeg> {
    let segments = leg.get("segments")?.as_array()?;
    let text = |segment: &Value, key: &str| segment.get(key).and_then(Value::as_str).map(str::to_owned);
    let (first, last) = (segments.first()?, segments.last()?);
    Some(FlightLeg {
        carrier: text(leg, "carrier"),
        duration_minutes: leg.get("duration_minutes").and_then(Value::as_u64),
        stops: segments.len() - 1,
        from: text(first, "departure_airport")?,
        to: text(last, "arrival_airport")?,
        departs_at: text(first, "departure_time_local")?,
        arrives_at: text(last, "arrival_time_local")?,
        flights: segments
            .iter()
            .filter_map(|s| Some(format!("{} {}", text(s, "marketing_carrier_code")?, text(s, "flight_number")?)))
            .collect(),
    })
}

/// Ignav marks a price it couldn't get with an amount of 0 and flights with no
/// segments. Neither is a fare to show.
fn parse_fare(itinerary: &Value) -> Option<Fare> {
    let amount = itinerary.pointer("/price/amount")?.as_f64().filter(|a| *a > 0.0)?;
    Some(Fare {
        id: itinerary.get("ignav_id")?.as_str()?.to_owned(),
        amount,
        currency: itinerary.pointer("/price/currency")?.as_str()?.to_owned(),
        outbound: parse_leg(itinerary.get("outbound")?)?,
        // A return that's there but unreadable makes the whole fare unreadable.
        inbound: match itinerary.get("inbound") {
            None | Some(Value::Null) => None,
            Some(leg) => Some(parse_leg(leg)?),
        },
    })
}

fn total_minutes(fare: &Fare) -> u64 {
    let leg = |l: &FlightLeg| l.duration_minutes.unwrap_or(u64::MAX / 4);
    leg(&fare.outbound) + fare.inbound.as_ref().map_or(0, leg)
}

/// The cheapest fares. The fastest stays too, even at a higher price, since the
/// cheapest few can all be long trips with several stops.
fn pick_fares(mut fares: Vec<Fare>) -> Vec<Fare> {
    fares.sort_by(|a, b| a.amount.total_cmp(&b.amount));
    if fares.len() > MAX_FARES {
        let fastest = (0..fares.len()).min_by_key(|i| total_minutes(&fares[*i])).unwrap_or(0);
        if fastest >= MAX_FARES {
            let fare = fares.swap_remove(fastest);
            fares[MAX_FARES - 1] = fare;
        }
        fares.truncate(MAX_FARES);
    }
    fares
}

fn parse_results(body: &Value) -> FlightResults {
    let all = body.get("itineraries").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let fares: Vec<Fare> = all.iter().filter_map(parse_fare).collect();
    FlightResults {
        total: fares.len(),
        fares: pick_fares(fares),
        observed_at: body.get("observed_at").and_then(Value::as_str).map(str::to_owned),
    }
}

/// A seller's address, as a web link or nothing: it comes from a third party and
/// ends up opened in the user's browser. Ignav's examples leave off the scheme.
fn web_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).or_else(|_| reqwest::Url::parse(&format!("https://{url}"))).ok()?;
    matches!(parsed.scheme(), "https" | "http").then(|| parsed.to_string())
}

fn parse_link(link: &Value, legs: &[String]) -> Option<BookingLink> {
    Some(BookingLink {
        provider: link.get("provider_name")?.as_str()?.to_owned(),
        is_airline: link.get("provider_type").and_then(Value::as_str) == Some("airline"),
        exact: link.get("specificity").and_then(Value::as_str) == Some("exact_flight"),
        fare_name: link.get("fare_name").and_then(Value::as_str).map(str::to_owned),
        amount: link.pointer("/price/amount").and_then(Value::as_f64).filter(|a| *a > 0.0),
        currency: link.pointer("/price/currency").and_then(Value::as_str).map(str::to_owned),
        url: web_url(link.get("url")?.as_str()?)?,
        legs: legs.to_vec(),
    })
}

fn parse_links(body: &Value) -> Vec<BookingLink> {
    let options = body.get("booking_options").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    options
        .iter()
        .flat_map(|option| {
            let legs: Vec<String> = option
                .get("legs")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .filter_map(|leg| leg.as_str().map(str::to_owned))
                .collect();
            let links = option.get("links").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            links.iter().filter_map(move |link| parse_link(link, &legs)).collect::<Vec<_>>()
        })
        .collect()
}

/// Ignav's own message for a failed call, e.g. that the key is wrong.
fn error_message(status: u16, body: &Value) -> String {
    match body.pointer("/error/message").and_then(Value::as_str) {
        Some(message) => message.to_string(),
        None => format!("HTTP {status}"),
    }
}

/// Sends a request and reads its answer. `reqwest`'s own errors aren't passed on.
async fn send(request: reqwest::RequestBuilder, key: &str) -> Result<(u16, Value), String> {
    let resp = request
        .header("X-Api-Key", key)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "it took too long to answer".to_string() } else { "couldn't reach Ignav".to_string() })?;
    let status = resp.status().as_u16();
    Ok((status, resp.json().await.unwrap_or(Value::Null)))
}

pub async fn search_flights(http: &reqwest::Client, key: &str, search: &FlightSearch) -> Result<FlightResults, String> {
    let path = if search.return_date.is_some() { "round-trip" } else { "one-way" };
    let request = http.post(format!("{API}/fares/{path}")).timeout(SEARCH_TIMEOUT).json(&search_body(search));
    match send(request, key).await? {
        (200..=299, body) => Ok(parse_results(&body)),
        (status, body) => Err(error_message(status, &body)),
    }
}

/// Where a fare can be bought. Ignav answers 404 for a fare with no links, which
/// is an answer rather than a failure.
pub async fn booking_links(http: &reqwest::Client, key: &str, fare_id: &str) -> Result<Vec<BookingLink>, String> {
    let request = http.post(format!("{API}/fares/booking-links")).timeout(LOOKUP_TIMEOUT).json(&json!({ "ignav_id": fare_id }));
    match send(request, key).await? {
        (200..=299, body) => Ok(parse_links(&body)),
        (404, _) => Ok(Vec::new()),
        (status, body) => Err(error_message(status, &body)),
    }
}

/// Try a key with an airport lookup, the smallest request there is (one billed
/// request at most). Returns what's wrong, if anything.
pub async fn check_key(http: &reqwest::Client, key: &str) -> Option<String> {
    let request = http.get(format!("{API}/airports?q=London&limit=1")).timeout(LOOKUP_TIMEOUT);
    match send(request, key).await {
        Ok((200..=299, _)) => None,
        Ok((status, body)) => Some(error_message(status, &body)),
        Err(e) => Some(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(code: &str, number: &str, from: &str, departs: &str, to: &str, arrives: &str) -> Value {
        json!({
            "marketing_carrier_code": code,
            "flight_number": number,
            "operating_carrier_name": null,
            "departure_airport": from,
            "departure_time_local": departs,
            "arrival_airport": to,
            "arrival_time_local": arrives,
            "duration_minutes": 100,
        })
    }

    fn itinerary(id: &str, amount: f64, minutes: u64) -> Value {
        json!({
            "ignav_id": id,
            "price": { "amount": amount, "currency": "USD", "status": "verified" },
            "outbound": {
                "carrier": "American Airlines",
                "duration_minutes": minutes,
                "segments": [segment("AA", "100", "SFO", "2026-12-03T08:00:00", "JFK", "2026-12-03T16:30:00")],
            },
        })
    }

    fn search(return_date: Option<&str>) -> FlightSearch {
        FlightSearch {
            origin: "SFO".into(),
            destination: "LON".into(),
            departure_date: "2026-12-03".into(),
            return_date: return_date.map(str::to_owned),
            adults: 2,
            children: 1,
            cabin: Cabin::PremiumEconomy,
            max_stops: None,
            market: "GB".into(),
        }
    }

    #[test]
    fn a_search_says_only_what_was_asked() {
        let body = search_body(&search(None));
        assert_eq!(body["cabin_class"], "premium_economy");
        assert_eq!(body["adults"], 2);
        assert_eq!(body["market"], "GB");
        assert!(body.get("return_date").is_none());
        assert!(body.get("max_stops").is_none());
        let mut nonstop = search(Some("2026-12-10"));
        nonstop.max_stops = Some(0);
        let body = search_body(&nonstop);
        assert_eq!(body["return_date"], "2026-12-10");
        assert_eq!(body["max_stops"], 0);
    }

    #[test]
    fn a_connection_joins_its_segments_into_one_leg() {
        let body = json!({
            "observed_at": "2026-11-04T10:00:00Z",
            "itineraries": [{
                "ignav_id": "abc",
                "price": { "amount": 488, "currency": "USD", "status": "verified" },
                "outbound": {
                    "carrier": "Delta",
                    "duration_minutes": 400,
                    "segments": [
                        segment("DL", "1", "SFO", "2026-12-03T08:00:00", "SLC", "2026-12-03T11:00:00"),
                        segment("DL", "2", "SLC", "2026-12-03T12:00:00", "JFK", "2026-12-03T19:00:00"),
                    ],
                },
                "inbound": null,
            }],
        });
        let results = parse_results(&body);
        assert_eq!(results.total, 1);
        assert_eq!(results.observed_at.as_deref(), Some("2026-11-04T10:00:00Z"));
        let fare = &results.fares[0];
        assert_eq!(fare.amount, 488.0);
        assert!(fare.inbound.is_none());
        assert_eq!(fare.outbound.stops, 1);
        assert_eq!((fare.outbound.from.as_str(), fare.outbound.to.as_str()), ("SFO", "JFK"));
        assert_eq!(fare.outbound.arrives_at, "2026-12-03T19:00:00");
        assert_eq!(fare.outbound.flights, ["DL 1", "DL 2"]);
    }

    #[test]
    fn placeholders_are_not_fares() {
        let no_price = itinerary("zero", 0.0, 100);
        let mut no_flights = itinerary("empty", 100.0, 100);
        no_flights["outbound"]["segments"] = json!([]);
        let mut bad_return = itinerary("return", 100.0, 100);
        bad_return["inbound"] = json!({ "segments": [] });
        let results = parse_results(&json!({ "itineraries": [no_price, no_flights, bad_return] }));
        assert_eq!(results.total, 0);
        assert!(results.fares.is_empty());
        assert!(parse_results(&json!({})).fares.is_empty());
    }

    #[test]
    fn the_cheapest_are_kept_and_the_fastest_with_them() {
        let many: Vec<Value> = (0..9).map(|i| itinerary(&format!("f{i}"), 100.0 + f64::from(i), 600)).collect();
        let fast = itinerary("fast", 900.0, 90);
        let all = [many, vec![fast]].concat();
        let results = parse_results(&json!({ "itineraries": all }));
        assert_eq!(results.total, 10);
        assert_eq!(results.fares.len(), MAX_FARES);
        assert_eq!(results.fares[0].id, "f0");
        assert_eq!(results.fares[MAX_FARES - 1].id, "fast");
        // A fastest fare that's cheap enough already takes no one's place.
        let mut cheap: Vec<Value> = (0..9).map(|i| itinerary(&format!("f{i}"), 100.0 + f64::from(i), 600)).collect();
        cheap[2] = itinerary("f2", 102.0, 90);
        let results = parse_results(&json!({ "itineraries": cheap }));
        assert_eq!(results.fares[MAX_FARES - 1].id, "f5");
    }

    #[test]
    fn booking_links_keep_what_they_cover_and_only_web_addresses() {
        let body = json!({ "booking_options": [
            { "legs": ["outbound"], "links": [
                { "provider_name": "American Airlines", "provider_type": "airline", "specificity": "exact_flight", "fare_name": "Main Cabin",
                  "price": { "amount": 488, "currency": "USD", "status": "verified" }, "url": "aa.com/booking/1" },
                { "provider_name": "Expedia", "provider_type": "third_party", "specificity": "search_results", "url": "https://expedia.com/f" },
                { "provider_name": "Bad", "url": "javascript:alert(1)" },
            ] },
            { "legs": ["inbound"], "links": [{ "provider_name": "Delta", "url": "https://delta.com/x", "price": { "amount": 0, "currency": "USD" } }] },
        ] });
        let links = parse_links(&body);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].url, "https://aa.com/booking/1");
        assert!(links[0].is_airline && links[0].exact);
        assert_eq!(links[0].amount, Some(488.0));
        assert!(!links[1].is_airline && !links[1].exact);
        assert_eq!(links[1].amount, None);
        assert_eq!(links[2].legs, ["inbound"]);
        assert_eq!(links[2].amount, None);
    }

    #[test]
    fn errors_use_ignavs_message() {
        let body = json!({ "error": { "type": "auth", "code": "invalid_key", "message": "API key is not valid" } });
        assert_eq!(error_message(401, &body), "API key is not valid");
        assert_eq!(error_message(502, &Value::Null), "HTTP 502");
    }
}
