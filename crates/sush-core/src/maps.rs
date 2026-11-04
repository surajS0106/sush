//! Live details for a map card, with the user's own Google Maps Platform key:
//! the destination from Places (Text Search) and the trip from Routes
//! (`computeRoutes`). The key goes in a header, never a URL, so it can't turn up
//! in an error message.
//!
//! Google bills by the fields and features asked for: `rating` and
//! `currentOpeningHours` make a search Enterprise, and traffic-aware routing makes
//! a route Pro. Change `PLACE_FIELDS` or `route_body` with that in mind.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PLACES_URL: &str = "https://places.googleapis.com/v1/places:searchText";
const ROUTES_URL: &str = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACE_FIELDS: &str = "places.id,places.displayName,places.formattedAddress,places.primaryTypeDisplayName,places.rating,places.userRatingCount,places.currentOpeningHours.openNow";
const ROUTE_FIELDS: &str = "routes.localizedValues";
const TIMEOUT: Duration = Duration::from_secs(10);
/// Google's largest bias radius, in meters.
const BIAS_RADIUS: f64 = 50_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TravelMode {
    Driving,
    Walking,
    Bicycling,
    Transit,
}

impl TravelMode {
    fn wire(self) -> &'static str {
        match self {
            TravelMode::Driving => "DRIVE",
            TravelMode::Walking => "WALK",
            TravelMode::Bicycling => "BICYCLE",
            TravelMode::Transit => "TRANSIT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    /// In the destination country's words and units, e.g. "13 mins".
    pub duration: Option<String>,
    /// e.g. "5.2 km".
    pub distance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceInfo {
    pub name: Option<String>,
    pub address: Option<String>,
    /// e.g. "Marriage celebrant".
    pub kind: Option<String>,
    pub rating: Option<f64>,
    pub rating_count: Option<u64>,
    pub open_now: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDetails {
    pub route: Option<RouteInfo>,
    pub place: Option<PlaceInfo>,
    /// What went wrong, when part or all of the above is missing because of a failure.
    pub error: Option<String>,
}

/// The place Google found, and its id to route to.
fn parse_place(body: &Value) -> Option<(Option<String>, PlaceInfo)> {
    let p = body.pointer("/places/0")?;
    let text = |path: &str| p.pointer(path).and_then(Value::as_str).map(str::to_owned);
    Some((
        text("/id"),
        PlaceInfo {
            name: text("/displayName/text"),
            address: text("/formattedAddress"),
            kind: text("/primaryTypeDisplayName/text"),
            rating: p.get("rating").and_then(Value::as_f64),
            rating_count: p.get("userRatingCount").and_then(Value::as_u64),
            open_now: p.pointer("/currentOpeningHours/openNow").and_then(Value::as_bool),
        },
    ))
}

fn parse_route(body: &Value) -> Option<RouteInfo> {
    let values = body.pointer("/routes/0/localizedValues")?;
    let text = |path: &str| values.pointer(path).and_then(Value::as_str).map(str::to_owned);
    Some(RouteInfo { duration: text("/duration/text"), distance: text("/distance/text") })
}

/// A `latitude,longitude` place, as `location_get` gives it.
fn coordinates(place: &str) -> Option<(f64, f64)> {
    let (lat, lng) = place.split_once(',')?;
    let (lat, lng) = (lat.trim().parse::<f64>().ok()?, lng.trim().parse::<f64>().ok()?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng)).then_some((lat, lng))
}

fn waypoint(place: &str) -> Value {
    match coordinates(place) {
        Some((latitude, longitude)) => json!({ "location": { "latLng": { "latitude": latitude, "longitude": longitude } } }),
        None => json!({ "address": place }),
    }
}

/// Finds places near the route's start when that's a position. An address isn't
/// looked up first, since that would be another billed call.
fn place_body(destination: &str, origin: Option<&str>) -> Value {
    let mut body = json!({ "textQuery": destination, "pageSize": 1 });
    if let Some((latitude, longitude)) = origin.and_then(coordinates) {
        body["locationBias"] = json!({ "circle": { "center": { "latitude": latitude, "longitude": longitude }, "radius": BIAS_RADIUS } });
    }
    body
}

fn route_body(origin: Value, destination: Value, mode: TravelMode) -> Value {
    let mut body = json!({ "origin": origin, "destination": destination, "travelMode": mode.wire() });
    // Google takes a routing preference only for road vehicles.
    if mode == TravelMode::Driving {
        body["routingPreference"] = "TRAFFIC_AWARE".into();
    }
    body
}

/// Google's own message for a failed call, e.g. that an API isn't enabled.
fn error_message(status: u16, body: &Value) -> String {
    match body.pointer("/error/message").and_then(Value::as_str) {
        Some(message) => message.to_string(),
        None => format!("HTTP {status}"),
    }
}

async fn post(http: &reqwest::Client, url: &str, key: &str, fields: &str, body: &Value) -> Result<Value, String> {
    let resp = http
        .post(url)
        .timeout(TIMEOUT)
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", fields)
        .json(body)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "it took too long to answer".to_string() } else { "couldn't reach Google".to_string() })?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(error_message(status.as_u16(), &body))
    }
}

/// The destination, and the trip when there's a start. Each part can fail alone,
/// and a map is worth showing either way, so failures come back as `error`.
pub async fn map_details(http: &reqwest::Client, key: &str, origin: Option<&str>, destination: &str, mode: TravelMode) -> MapDetails {
    let mut errors = Vec::new();
    let mut place = None;
    let mut place_id = None;
    if coordinates(destination).is_none() {
        match post(http, PLACES_URL, key, PLACE_FIELDS, &place_body(destination, origin)).await {
            Ok(body) => {
                if let Some((id, info)) = parse_place(&body) {
                    place_id = id;
                    place = Some(info);
                }
            }
            Err(e) => errors.push(format!("Places API: {e}")),
        }
    }
    let mut route = None;
    if let Some(origin) = origin {
        // The place just found, so the trip goes where the card says it goes.
        let to = place_id.map_or_else(|| waypoint(destination), |id| json!({ "placeId": id }));
        match post(http, ROUTES_URL, key, ROUTE_FIELDS, &route_body(waypoint(origin), to, mode)).await {
            Ok(body) => route = parse_route(&body),
            Err(e) => errors.push(format!("Routes API: {e}")),
        }
    }
    MapDetails { route, place, error: (!errors.is_empty()).then(|| errors.join(" ")) }
}

/// Try a key against both APIs. Returns what's wrong, if anything. The search asks
/// only for ids, which Google doesn't charge for; the route counts as one basic request.
pub async fn check_key(http: &reqwest::Client, key: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let search = json!({ "textQuery": "Eiffel Tower", "pageSize": 1 });
    if let Err(e) = post(http, PLACES_URL, key, "places.id", &search).await {
        problems.push(format!("Places API: {e}"));
    }
    let route = json!({
        "origin": waypoint("48.8584,2.2945"),
        "destination": waypoint("48.8606,2.3376"),
        "travelMode": TravelMode::Driving.wire(),
    });
    if let Err(e) = post(http, ROUTES_URL, key, "routes.distanceMeters", &route).await {
        problems.push(format!("Routes API: {e}"));
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_parse_with_or_without_the_optional_fields() {
        let body = json!({ "places": [{
            "id": "abc",
            "displayName": { "text": "Sri Lakshmi Mahal" },
            "formattedAddress": "1 Main Rd, Chennai",
            "primaryTypeDisplayName": { "text": "Wedding venue" },
            "rating": 4.1,
            "userRatingCount": 120,
            "currentOpeningHours": { "openNow": true },
        }] });
        let (id, place) = parse_place(&body).unwrap();
        assert_eq!(id.as_deref(), Some("abc"));
        assert_eq!(place.name.as_deref(), Some("Sri Lakshmi Mahal"));
        assert_eq!(place.rating, Some(4.1));
        assert_eq!(place.open_now, Some(true));
        let (_, bare) = parse_place(&json!({ "places": [{ "id": "x" }] })).unwrap();
        assert_eq!(bare.rating, None);
        assert_eq!(bare.open_now, None);
        assert!(parse_place(&json!({})).is_none());
    }

    #[test]
    fn routes_parse_their_localized_values() {
        let body = json!({ "routes": [{ "localizedValues": { "duration": { "text": "13 mins" }, "distance": { "text": "5.2 km" } } }] });
        let route = parse_route(&body).unwrap();
        assert_eq!(route.duration.as_deref(), Some("13 mins"));
        assert_eq!(route.distance.as_deref(), Some("5.2 km"));
        // Google answers with an empty object when it finds no route.
        assert!(parse_route(&json!({})).is_none());
    }

    #[test]
    fn coordinates_become_positions_and_names_stay_addresses() {
        assert!(waypoint("12.96151, 80.19864").pointer("/location/latLng/latitude").is_some());
        assert_eq!(waypoint("Adyar, Chennai"), json!({ "address": "Adyar, Chennai" }));
        // Out of range isn't a position, and a house number isn't a latitude.
        assert_eq!(waypoint("95.0,80.0"), json!({ "address": "95.0,80.0" }));
        assert_eq!(waypoint("12, Main Road"), json!({ "address": "12, Main Road" }));
    }

    #[test]
    fn only_driving_asks_for_traffic() {
        let (a, b) = (waypoint("A"), waypoint("B"));
        let driving = route_body(a.clone(), b.clone(), TravelMode::Driving);
        assert_eq!(driving["routingPreference"], "TRAFFIC_AWARE");
        assert_eq!(driving["travelMode"], "DRIVE");
        for mode in [TravelMode::Walking, TravelMode::Bicycling, TravelMode::Transit] {
            assert!(route_body(a.clone(), b.clone(), mode).get("routingPreference").is_none());
        }
    }

    #[test]
    fn searches_lean_towards_a_known_position() {
        assert!(place_body("Adyar", Some("Madipakkam")).get("locationBias").is_none());
        assert!(place_body("Adyar", None).get("locationBias").is_none());
        let body = place_body("Adyar", Some("12.96,80.19"));
        assert_eq!(body["locationBias"]["circle"]["radius"], BIAS_RADIUS);
    }

    #[test]
    fn errors_use_googles_message() {
        let body = json!({ "error": { "code": 403, "message": "Routes API has not been used in project 1" } });
        assert_eq!(error_message(403, &body), "Routes API has not been used in project 1");
        assert_eq!(error_message(502, &Value::Null), "HTTP 502");
    }
}
