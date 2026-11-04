//! A day's weather in a city, from Open-Meteo (https://open-meteo.com), which takes
//! no key. Its forecast reaches about two weeks ahead, and most trips are further
//! off, so a later date gets the same date last year, marked as such. Open-Meteo's
//! free tier is for non-commercial use and asks for attribution.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const GEOCODING_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL: &str = "https://archive-api.open-meteo.com/v1/archive";
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayWeather {
    /// The place found for the name asked about.
    pub place: String,
    /// The date asked about, `YYYY-MM-DD`.
    pub date: String,
    /// WMO weather code.
    pub code: u64,
    pub condition: String,
    pub high_c: f64,
    pub low_c: f64,
    /// These are the same date last year's figures, not a forecast.
    pub last_year: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GeoPoint {
    pub latitude: f64,
    pub longitude: f64,
}

/// WMO codes, as Open-Meteo documents them.
fn condition(code: u64) -> &'static str {
    match code {
        0 => "Clear",
        1 | 2 => "Partly cloudy",
        3 => "Cloudy",
        45 | 48 => "Fog",
        51..=57 => "Drizzle",
        61..=67 | 80..=82 => "Rain",
        71..=77 | 85 | 86 => "Snow",
        95..=99 => "Thunderstorms",
        _ => "Mixed",
    }
}

fn parse_place(body: &Value) -> Option<(String, f64, f64)> {
    let place = body.pointer("/results/0")?;
    Some((place.get("name")?.as_str()?.to_owned(), place.get("latitude")?.as_f64()?, place.get("longitude")?.as_f64()?))
}

/// The first day's code, high and low. Recent days in the archive can still be null.
fn parse_day(body: &Value) -> Option<(u64, f64, f64)> {
    let daily = body.get("daily")?;
    let first = |key: &str| daily.get(key)?.get(0).cloned();
    Some((first("weather_code")?.as_u64()?, first("temperature_2m_max")?.as_f64()?, first("temperature_2m_min")?.as_f64()?))
}

fn previous_year(date: &str) -> Option<String> {
    let (year, rest) = date.split_once('-')?;
    Some(format!("{}-{rest}", year.parse::<u32>().ok()?.checked_sub(1)?))
}

fn day_params(latitude: f64, longitude: f64, date: &str) -> Vec<(&'static str, String)> {
    vec![
        ("latitude", latitude.to_string()),
        ("longitude", longitude.to_string()),
        ("daily", "weather_code,temperature_2m_max,temperature_2m_min".to_owned()),
        ("timezone", "auto".to_owned()),
        ("start_date", date.to_owned()),
        ("end_date", date.to_owned()),
    ]
}

async fn get(http: &reqwest::Client, url: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let url = reqwest::Url::parse_with_params(url, params.iter().map(|(k, v)| (*k, v.as_str()))).map_err(|e| e.to_string())?;
    let resp = http.get(url).timeout(TIMEOUT).send().await.map_err(|_| "couldn't reach Open-Meteo".to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    resp.json().await.map_err(|_| "Open-Meteo sent an unreadable answer".to_string())
}

async fn find_place(http: &reqwest::Client, city: &str) -> Result<Option<(String, f64, f64)>, String> {
    let params = [("name", city.to_owned()), ("count", "1".to_owned()), ("language", "en".to_owned())];
    Ok(parse_place(&get(http, GEOCODING_URL, &params).await?))
}

/// Where a city is, or nothing if it can't be found.
pub async fn locate(http: &reqwest::Client, city: &str) -> Result<Option<GeoPoint>, String> {
    Ok(find_place(http, city).await?.map(|(_, latitude, longitude)| GeoPoint { latitude, longitude }))
}

/// `date`'s weather in `city`, or nothing if the place or the figures can't be found.
pub async fn day_weather(http: &reqwest::Client, city: &str, date: &str) -> Result<Option<DayWeather>, String> {
    let Some((place, latitude, longitude)) = find_place(http, city).await? else { return Ok(None) };
    let found = |(code, high_c, low_c): (u64, f64, f64), last_year: bool| DayWeather {
        place: place.clone(),
        date: date.to_owned(),
        code,
        condition: condition(code).to_owned(),
        high_c,
        low_c,
        last_year,
    };
    // A date past the forecast's reach is an error from the forecast, not an empty answer.
    if let Ok(body) = get(http, FORECAST_URL, &day_params(latitude, longitude, date)).await {
        if let Some(day) = parse_day(&body) {
            return Ok(Some(found(day, false)));
        }
    }
    let Some(then) = previous_year(date) else { return Ok(None) };
    let body = get(http, ARCHIVE_URL, &day_params(latitude, longitude, &then)).await?;
    Ok(parse_day(&body).map(|day| found(day, true)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_place_is_the_first_match_or_none() {
        let body = json!({ "results": [{ "name": "New Delhi", "latitude": 28.62, "longitude": 77.21 }] });
        assert_eq!(parse_place(&body), Some(("New Delhi".to_owned(), 28.62, 77.21)));
        // Open-Meteo leaves `results` out when nothing matches.
        assert_eq!(parse_place(&json!({ "generationtime_ms": 0.1 })), None);
    }

    #[test]
    fn a_day_needs_all_its_figures() {
        let body = json!({ "daily": { "time": ["2026-11-10"], "weather_code": [0], "temperature_2m_max": [27.2], "temperature_2m_min": [16.0] } });
        assert_eq!(parse_day(&body), Some((0, 27.2, 16.0)));
        let unfinished = json!({ "daily": { "weather_code": [null], "temperature_2m_max": [null], "temperature_2m_min": [null] } });
        assert_eq!(parse_day(&unfinished), None);
        assert_eq!(parse_day(&json!({ "error": true, "reason": "out of range" })), None);
    }

    #[test]
    fn last_year_keeps_the_month_and_day() {
        assert_eq!(previous_year("2026-12-20").as_deref(), Some("2025-12-20"));
        assert_eq!(previous_year("not a date"), None);
    }

    #[test]
    fn codes_read_as_words() {
        assert_eq!(condition(0), "Clear");
        assert_eq!(condition(63), "Rain");
        assert_eq!(condition(81), "Rain");
        assert_eq!(condition(75), "Snow");
        assert_eq!(condition(95), "Thunderstorms");
        assert_eq!(condition(1000), "Mixed");
    }
}
