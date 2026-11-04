//! Live fares for a flight card, with the user's own Ignav key
//! (https://ignav.com/docs/api-reference). Ignav only finds fares and links to
//! sellers; a ticket is bought on the seller's site, so nothing here can spend the
//! user's money. The key goes in a header, never a URL, so it can't turn up in an
//! error message.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API: &str = "https://ignav.com/api";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);
/// Ignav's answer leans to the best few airlines and has no setting for more. So a
/// wide search asks again without the airlines it has found, this many times. Each
/// is a billed request, and a failed one only ends the looking.
const EXTRA_SEARCHES: usize = 2;
const EXTRA_TIMEOUT: Duration = Duration::from_secs(15);
/// The waits before asking again after a temporary failure, as Ignav's docs advise. A
/// failed request isn't billed.
const RETRY_WAITS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];
const TOO_LONG: &str = "it took too long to answer";
/// How many fares a card shows as tiles and the model reads.
const MAX_FARES: usize = 6;
/// How many more the card can list below the tiles, and how many of those from one
/// airline, so one airline's many departures don't crowd the others out.
const MAX_MORE: usize = 40;
const MAX_MORE_PER_AIRLINE: usize = 3;
/// Daily rates with no key. Its terms ask for the credit the card shows.
const RATES_API: &str = "https://open.er-api.com/v6/latest/USD";

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
    /// Also look for other airlines (`EXTRA_SEARCHES`). A price alert only needs the lowest fare.
    #[serde(default)]
    pub wide: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightLeg {
    pub carrier: Option<String>,
    pub duration_minutes: Option<u64>,
    pub stops: usize,
    pub from: String,
    pub to: String,
    /// The airports it stops at on the way, in order.
    pub via: Vec<String>,
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
    /// Other fares for the card's list, cheapest first. Not for the model.
    pub more: Vec<Fare>,
    /// How many Ignav found, before keeping these.
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
        via: segments[..segments.len() - 1].iter().filter_map(|s| text(s, "arrival_airport")).collect(),
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

fn airline(fare: &Fare) -> &str {
    fare.outbound.carrier.as_deref().or(fare.outbound.flights.first().map(String::as_str)).unwrap_or("")
}

/// The tiles and the list below them, each cheapest first. The tiles hold the cheapest
/// fare, the fastest (the cheapest can all be long trips with several stops), then the
/// cheapest from each other airline, so the user sees who flies the route and not one
/// airline's departures. Any room left goes to the next cheapest.
fn pick_fares(mut fares: Vec<Fare>) -> (Vec<Fare>, Vec<Fare>) {
    fares.sort_by(|a, b| a.amount.total_cmp(&b.amount));
    let mut picked: Vec<usize> = Vec::new();
    if let Some(fastest) = (0..fares.len()).min_by_key(|i| total_minutes(&fares[*i])) {
        picked.push(0);
        if fastest != 0 {
            picked.push(fastest);
        }
    }
    let mut seen: HashSet<&str> = picked.iter().map(|i| airline(&fares[*i])).collect();
    for (i, fare) in fares.iter().enumerate() {
        if picked.len() < MAX_FARES && seen.insert(airline(fare)) {
            picked.push(i);
        }
    }
    for i in 0..fares.len() {
        if picked.len() < MAX_FARES && !picked.contains(&i) {
            picked.push(i);
        }
    }

    let (mut tiles, mut more) = (Vec::new(), Vec::new());
    let mut per_airline: HashMap<String, usize> = HashMap::new();
    for (i, fare) in fares.into_iter().enumerate() {
        if picked.contains(&i) {
            tiles.push(fare);
            continue;
        }
        let count = per_airline.entry(airline(&fare).to_owned()).or_default();
        if *count < MAX_MORE_PER_AIRLINE && more.len() < MAX_MORE {
            *count += 1;
            more.push(fare);
        }
    }
    (tiles, more)
}

fn parse_fares(body: &Value) -> Vec<Fare> {
    let all = body.get("itineraries").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    all.iter().filter_map(parse_fare).collect()
}

fn observed_at(body: &Value) -> Option<String> {
    body.get("observed_at").and_then(Value::as_str).map(str::to_owned)
}

fn results_of(fares: Vec<Fare>, observed_at: Option<String>) -> FlightResults {
    let total = fares.len();
    let (fares, more) = pick_fares(fares);
    FlightResults { total, fares, more, observed_at }
}

/// Every airline code on these fares, from flight numbers like "EK 225".
fn carrier_codes(fares: &[Fare]) -> Vec<String> {
    let legs = fares.iter().flat_map(|fare| std::iter::once(&fare.outbound).chain(fare.inbound.as_ref()));
    let codes: HashSet<&str> = legs.flat_map(|leg| &leg.flights).filter_map(|flight| flight.split(' ').next()).collect();
    let mut codes: Vec<String> = codes.into_iter().map(str::to_owned).collect();
    codes.sort_unstable();
    codes
}

/// Adds the fares not already there, and says whether there were any.
fn add_new_fares(fares: &mut Vec<Fare>, found: Vec<Fare>) -> bool {
    let before = fares.len();
    for fare in found {
        if !fares.iter().any(|f| f.id == fare.id) {
            fares.push(fare);
        }
    }
    fares.len() > before
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
        .map_err(|e| if e.is_timeout() { TOO_LONG.to_string() } else { "couldn't reach Ignav".to_string() })?;
    let status = resp.status().as_u16();
    Ok((status, resp.json().await.unwrap_or(Value::Null)))
}

/// Ignav's `unable_to_complete_request` (424) and a dropped connection are worth trying
/// again. A timeout has already waited long enough, and any other answer won't change.
fn worth_retrying(answer: &Result<(u16, Value), String>) -> bool {
    match answer {
        Ok((status, _)) => *status == 424,
        Err(message) => message != TOO_LONG,
    }
}

async fn search_once(http: &reqwest::Client, key: &str, url: &str, body: &Value, timeout: Duration) -> Result<(u16, Value), String> {
    let mut waits = RETRY_WAITS.iter();
    loop {
        let answer = send(http.post(url).timeout(timeout).json(body), key).await;
        match waits.next() {
            Some(wait) if worth_retrying(&answer) => tokio::time::sleep(*wait).await,
            _ => return answer,
        }
    }
}

pub async fn search_flights(http: &reqwest::Client, key: &str, search: &FlightSearch) -> Result<FlightResults, String> {
    let path = if search.return_date.is_some() { "round-trip" } else { "one-way" };
    let url = format!("{API}/fares/{path}");
    let body = match search_once(http, key, &url, &search_body(search), SEARCH_TIMEOUT).await? {
        (200..=299, body) => body,
        (status, body) => return Err(error_message(status, &body)),
    };
    let mut fares = parse_fares(&body);
    let observed = observed_at(&body);
    if search.wide {
        for _ in 0..EXTRA_SEARCHES {
            let found = carrier_codes(&fares);
            if found.is_empty() {
                break;
            }
            let mut without = search_body(search);
            without["airlines_exclude"] = json!(found);
            let Ok((200..=299, body)) = search_once(http, key, &url, &without, EXTRA_TIMEOUT).await else { break };
            if !add_new_fares(&mut fares, parse_fares(&body)) {
                break;
            }
        }
    }
    Ok(results_of(fares, observed))
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

/// What one US dollar buys in each currency, by code.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRates {
    pub rates: BTreeMap<String, f64>,
    /// When the provider last updated them, in seconds.
    pub updated_at: Option<i64>,
}

fn parse_rates(body: &Value) -> Option<ExchangeRates> {
    let rates: BTreeMap<String, f64> =
        body.get("rates")?.as_object()?.iter().filter_map(|(code, rate)| Some((code.clone(), rate.as_f64().filter(|r| *r > 0.0)?))).collect();
    (!rates.is_empty()).then(|| ExchangeRates { rates, updated_at: body.get("time_last_update_unix").and_then(Value::as_i64) })
}

/// Today's exchange rates. Needs no key and sends nothing about the trip.
pub async fn exchange_rates(http: &reqwest::Client) -> Result<ExchangeRates, String> {
    let resp = http.get(RATES_API).timeout(LOOKUP_TIMEOUT).send().await.map_err(|_| "couldn't get exchange rates".to_string())?;
    let body: Value = resp.json().await.map_err(|_| "couldn't read exchange rates".to_string())?;
    parse_rates(&body).ok_or_else(|| "couldn't read exchange rates".to_string())
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
            wide: false,
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
        assert_eq!(fare.outbound.via, ["SLC"]);
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
    fn only_temporary_failures_are_tried_again() {
        assert!(worth_retrying(&Ok((424, Value::Null))));
        assert!(worth_retrying(&Err("couldn't reach Ignav".into())));
        assert!(!worth_retrying(&Err(TOO_LONG.into())));
        for status in [200, 400, 401, 402, 404, 429] {
            assert!(!worth_retrying(&Ok((status, Value::Null))));
        }
    }

    fn parse_results(body: &Value) -> FlightResults {
        results_of(parse_fares(body), observed_at(body))
    }

    #[test]
    fn asking_again_excludes_what_was_found_and_adds_only_new_fares() {
        let mut fares = parse_fares(&json!({ "itineraries": [itinerary("a", 100.0, 600), itinerary("b", 200.0, 600)] }));
        assert_eq!(carrier_codes(&fares), ["AA"]);
        assert!(!add_new_fares(&mut fares, parse_fares(&json!({ "itineraries": [itinerary("a", 100.0, 600)] }))));
        assert!(add_new_fares(&mut fares, parse_fares(&json!({ "itineraries": [itinerary("a", 100.0, 600), itinerary("c", 300.0, 600)] }))));
        assert_eq!(fares.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    fn on_airline(id: &str, amount: f64, carrier: &str) -> Value {
        let mut fare = itinerary(id, amount, 600);
        fare["outbound"]["carrier"] = carrier.into();
        fare
    }

    #[test]
    fn dearer_airlines_get_a_tile_and_the_rest_go_in_the_list() {
        let mut all: Vec<Value> = (0..9).map(|i| on_airline(&format!("cx{i}"), 100.0 + f64::from(i), "Cathay Pacific")).collect();
        all.push(on_airline("ua", 500.0, "United"));
        all.push(on_airline("sq", 800.0, "Singapore Airlines"));
        let results = parse_results(&json!({ "itineraries": all }));
        assert_eq!(results.total, 11);
        let tiles: Vec<&str> = results.fares.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(tiles, ["cx0", "cx1", "cx2", "cx3", "ua", "sq"]);
        // One airline's departures stop at the limit.
        let more: Vec<&str> = results.more.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(more, ["cx4", "cx5", "cx6"]);
    }

    #[test]
    fn exchange_rates_need_positive_figures() {
        let rates = parse_rates(&json!({ "time_last_update_unix": 5, "rates": { "USD": 1, "INR": 94.8, "XXX": 0, "YYY": "no" } })).unwrap();
        assert_eq!(rates.updated_at, Some(5));
        assert_eq!(rates.rates.keys().map(String::as_str).collect::<Vec<_>>(), ["INR", "USD"]);
        assert_eq!(parse_rates(&json!({ "result": "error" })), None);
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
