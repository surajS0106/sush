//! A day's weather in a city, and the weather right now in a place, from Open-Meteo
//! (https://open-meteo.com), which takes no key. Its forecast reaches about two
//! weeks ahead, and most trips are further off, so a later date gets the same date
//! last year, marked as such. Open-Meteo's free tier is for non-commercial use and
//! asks for attribution.

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastDay {
    /// `YYYY-MM-DD`, in the place's own time zone.
    pub date: String,
    /// WMO weather code.
    pub code: u64,
    pub condition: String,
    pub high_c: f64,
    pub low_c: f64,
    /// The day's highest chance of rain or snow, in percent.
    pub precipitation_chance: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastHour {
    /// `YYYY-MM-DDTHH:MM`, in the place's own time zone.
    pub time: String,
    pub temperature_c: f64,
    /// WMO weather code.
    pub code: u64,
    pub is_day: bool,
    /// In percent.
    pub precipitation_chance: Option<f64>,
}

/// Where the sun is, at the place itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Day,
    Night,
    Dawn,
    Dusk,
}

/// The weather right now in a place, and the days ahead.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWeather {
    /// The place found for a name. Coordinates have no name: nothing here looks one up.
    pub place: Option<String>,
    pub temperature_c: f64,
    pub feels_like_c: f64,
    /// WMO weather code.
    pub code: u64,
    pub condition: String,
    pub is_day: bool,
    pub phase: Phase,
    /// In percent.
    pub humidity: Option<f64>,
    pub wind_kmh: Option<f64>,
    /// Today's highest.
    pub uv_index: Option<f64>,
    /// Today's, as `YYYY-MM-DDTHH:MM` in the place's own time zone.
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
    /// Today and the next seven days.
    pub days: Vec<ForecastDay>,
    /// The next 24 hours, starting with this one.
    pub hours: Vec<ForecastHour>,
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

/// A `latitude,longitude` place, as the `location_get` tool gives it.
fn parse_coordinates(place: &str) -> Option<(f64, f64)> {
    let (latitude, longitude) = place.split_once(',')?;
    let latitude: f64 = latitude.trim().parse().ok()?;
    let longitude: f64 = longitude.trim().parse().ok()?;
    ((-90.0..=90.0).contains(&latitude) && (-180.0..=180.0).contains(&longitude)).then_some((latitude, longitude))
}

/// The names to try for a place. The geocoder only knows places, so it finds nothing
/// for a street address or "Adyar, Chennai"; each comma's tail is a broader place.
fn place_attempts(place: &str) -> Vec<&str> {
    let mut attempts = vec![place.trim()];
    let mut rest = place;
    while let Some((_, tail)) = rest.split_once(',') {
        rest = tail;
        attempts.push(tail.trim());
    }
    attempts.retain(|name| !name.is_empty());
    attempts.truncate(5);
    attempts
}

fn column<'a>(daily: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    daily.get(key)?.as_array()
}

/// `HH:MM` as minutes, if `time` (`YYYY-MM-DDTHH:MM`) falls on `date`.
fn minute_of_day(time: &str, date: &str) -> Option<i64> {
    let (day, clock) = time.split_once('T')?;
    if day != date {
        return None;
    }
    let (hour, minute) = clock.split_once(':')?;
    Some(hour.parse::<i64>().ok()? * 60 + minute.parse::<i64>().ok()?)
}

/// Dawn runs from 45 minutes before sunrise to 30 after, dusk from 30 before sunset
/// to 45 after. All three times are the place's own. Where the sun doesn't rise or
/// set today, Open-Meteo gives the same time for both, so only day and night apply.
fn phase_of(now: &str, sunrise: Option<&str>, sunset: Option<&str>, is_day: bool) -> Phase {
    let around_the_sun = || {
        let date = now.split_once('T')?.0;
        let now = minute_of_day(now, date)?;
        let rise = minute_of_day(sunrise?, date)?;
        let set = minute_of_day(sunset?, date)?;
        if rise == set {
            return None;
        }
        if (rise - 45..=rise + 30).contains(&now) {
            return Some(Phase::Dawn);
        }
        (set - 30..=set + 45).contains(&now).then_some(Phase::Dusk)
    };
    around_the_sun().unwrap_or(if is_day { Phase::Day } else { Phase::Night })
}

/// The hours ahead. An hour with a figure missing is left out.
fn parse_hours(hourly: &Value) -> Option<Vec<ForecastHour>> {
    let (temperatures, codes, days) = (column(hourly, "temperature_2m")?, column(hourly, "weather_code")?, column(hourly, "is_day")?);
    let chances = column(hourly, "precipitation_probability");
    let hours = column(hourly, "time")?
        .iter()
        .enumerate()
        .filter_map(|(i, time)| {
            Some(ForecastHour {
                time: time.as_str()?.to_owned(),
                temperature_c: temperatures.get(i)?.as_f64()?,
                code: codes.get(i)?.as_u64()?,
                is_day: days.get(i)?.as_u64()? == 1,
                precipitation_chance: chances.and_then(|c| c.get(i)).and_then(Value::as_f64),
            })
        })
        .collect();
    Some(hours)
}

/// The figures from a forecast. A day with a figure missing is left out.
fn parse_now(body: &Value) -> Option<LocalWeather> {
    let current = body.get("current")?;
    let code = current.get("weather_code")?.as_u64()?;
    let daily = body.get("daily")?;
    let (codes, highs, lows) = (column(daily, "weather_code")?, column(daily, "temperature_2m_max")?, column(daily, "temperature_2m_min")?);
    let chances = column(daily, "precipitation_probability_max");
    let days = column(daily, "time")?
        .iter()
        .enumerate()
        .filter_map(|(i, date)| {
            let code = codes.get(i)?.as_u64()?;
            Some(ForecastDay {
                date: date.as_str()?.to_owned(),
                code,
                condition: condition(code).to_owned(),
                high_c: highs.get(i)?.as_f64()?,
                low_c: lows.get(i)?.as_f64()?,
                precipitation_chance: chances.and_then(|c| c.get(i)).and_then(Value::as_f64),
            })
        })
        .collect();
    let is_day = current.get("is_day")?.as_u64()? == 1;
    let first = |key: &str| Some(column(daily, key)?.first()?.as_str()?.to_owned());
    let (sunrise, sunset) = (first("sunrise"), first("sunset"));
    let phase = phase_of(current.get("time")?.as_str()?, sunrise.as_deref(), sunset.as_deref(), is_day);
    Some(LocalWeather {
        place: None,
        temperature_c: current.get("temperature_2m")?.as_f64()?,
        feels_like_c: current.get("apparent_temperature")?.as_f64()?,
        code,
        condition: condition(code).to_owned(),
        is_day,
        phase,
        humidity: current.get("relative_humidity_2m").and_then(Value::as_f64),
        wind_kmh: current.get("wind_speed_10m").and_then(Value::as_f64),
        uv_index: column(daily, "uv_index_max").and_then(|c| c.first()).and_then(Value::as_f64),
        sunrise,
        sunset,
        days,
        hours: body.get("hourly").and_then(parse_hours).unwrap_or_default(),
    })
}

/// The weather now in `place`, a name or `latitude,longitude`, or nothing if the
/// place or the figures can't be found.
pub async fn local_weather(http: &reqwest::Client, place: &str) -> Result<Option<LocalWeather>, String> {
    let (name, latitude, longitude) = if let Some((latitude, longitude)) = parse_coordinates(place) {
        (None, latitude, longitude)
    } else {
        let mut found = None;
        for attempt in place_attempts(place) {
            found = find_place(http, attempt).await?;
            if found.is_some() {
                break;
            }
        }
        let Some((name, latitude, longitude)) = found else { return Ok(None) };
        (Some(name), latitude, longitude)
    };
    let params = [
        ("latitude", latitude.to_string()),
        ("longitude", longitude.to_string()),
        ("current", "temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m".to_owned()),
        ("hourly", "temperature_2m,weather_code,precipitation_probability,is_day".to_owned()),
        ("daily", "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max".to_owned()),
        ("timezone", "auto".to_owned()),
        ("forecast_days", "8".to_owned()),
        ("forecast_hours", "24".to_owned()),
    ];
    let body = get(http, FORECAST_URL, &params).await?;
    Ok(parse_now(&body).map(|weather| LocalWeather { place: name, ..weather }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coordinates_are_told_from_names() {
        assert_eq!(parse_coordinates("13.03120,80.21000"), Some((13.0312, 80.21)));
        assert_eq!(parse_coordinates(" -33.9, 151.2 "), Some((-33.9, 151.2)));
        assert_eq!(parse_coordinates("Portland, Maine"), None);
        assert_eq!(parse_coordinates("Chennai"), None);
        assert_eq!(parse_coordinates("95.0,10.0"), None);
    }

    #[test]
    fn an_address_falls_back_to_broader_places() {
        assert_eq!(place_attempts("Chennai"), ["Chennai"]);
        assert_eq!(place_attempts("Adyar, Chennai"), ["Adyar, Chennai", "Chennai"]);
        assert_eq!(place_attempts("12 Main Road, Adyar, Chennai, "), ["12 Main Road, Adyar, Chennai,", "Adyar, Chennai,", "Chennai,"]);
    }

    #[test]
    fn the_phase_follows_the_sun_at_the_place() {
        let at = |now: &str, is_day| phase_of(&format!("2026-11-04T{now}"), Some("2026-11-04T06:00"), Some("2026-11-04T18:00"), is_day);
        assert_eq!(at("05:14", false), Phase::Night);
        assert_eq!(at("05:15", false), Phase::Dawn);
        assert_eq!(at("06:30", true), Phase::Dawn);
        assert_eq!(at("06:31", true), Phase::Day);
        assert_eq!(at("17:29", true), Phase::Day);
        assert_eq!(at("17:30", true), Phase::Dusk);
        assert_eq!(at("18:45", false), Phase::Dusk);
        assert_eq!(at("18:46", false), Phase::Night);
        // Polar night and midnight sun: the same time for both, or nothing to go on.
        let polar = Some("2026-11-04T00:00");
        assert_eq!(phase_of("2026-11-04T00:10", polar, polar, false), Phase::Night);
        assert_eq!(phase_of("2026-11-04T00:10", None, None, true), Phase::Day);
    }

    #[test]
    fn the_weather_now_reads_a_forecast() {
        let body = json!({
            "current": { "time": "2026-11-04T16:00", "temperature_2m": 28.8, "apparent_temperature": 34.8, "weather_code": 1, "is_day": 1, "relative_humidity_2m": 77, "wind_speed_10m": 2.2 },
            "hourly": {
                "time": ["2026-11-04T16:00", "2026-11-04T17:00", "2026-11-04T18:00"],
                "temperature_2m": [28.8, 28.1, null],
                "weather_code": [51, 0, 0],
                "precipitation_probability": [84, null, 49],
                "is_day": [1, 1, 0],
            },
            "daily": {
                "time": ["2026-11-04", "2026-11-05", "2026-11-06"],
                "weather_code": [95, 55, null],
                "temperature_2m_max": [31.4, 29.9, 29.3],
                "temperature_2m_min": [24.1, 24.3, 24.0],
                "sunrise": ["2026-11-04T06:05", "2026-11-05T06:05", "2026-11-06T06:06"],
                "sunset": ["2026-11-04T16:20", "2026-11-05T16:20", "2026-11-06T16:19"],
                "precipitation_probability_max": [98, 33, 10],
                "uv_index_max": [7.45, 7.85, 6.0],
            },
        });
        let now = parse_now(&body).unwrap();
        assert_eq!((now.temperature_c, now.feels_like_c, now.code, now.is_day), (28.8, 34.8, 1, true));
        assert_eq!(now.condition, "Partly cloudy");
        assert_eq!(now.phase, Phase::Dusk);
        // The day with no code is dropped; the rest are kept.
        assert_eq!(now.days.len(), 2);
        assert_eq!(now.days[1], ForecastDay { date: "2026-11-05".into(), code: 55, condition: "Drizzle".into(), high_c: 29.9, low_c: 24.3, precipitation_chance: Some(33.0) });
        assert_eq!((now.humidity, now.wind_kmh, now.uv_index), (Some(77.0), Some(2.2), Some(7.45)));
        assert_eq!(now.sunrise.as_deref(), Some("2026-11-04T06:05"));
        // The hour with no temperature is dropped; a missing chance of rain isn't a reason to.
        assert_eq!(now.hours.len(), 2);
        assert_eq!(now.hours[1], ForecastHour { time: "2026-11-04T17:00".into(), temperature_c: 28.1, code: 0, is_day: true, precipitation_chance: None });
        assert_eq!(parse_now(&json!({ "error": true })), None);
    }

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
