//! The optional Ignav key (Settings → Flights) and the fares and booking links it
//! unlocks on a flight card. The key stays in the keyring; the webview only learns
//! whether there is one.

use sush_core::flights::{booking_links, check_key, exchange_rates, search_flights, BookingLink, ExchangeRates, FlightResults, FlightSearch};
use sush_core::weather::{day_weather, locate, DayWeather, GeoPoint};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

#[tauri::command]
pub async fn flights_key_status() -> AppResult<bool> {
    Ok(secrets::flights_key_get()?.is_some())
}

/// Save a key and try it. Returns what's wrong with it, if anything: it's kept
/// either way, so a network failure doesn't lose what was pasted.
#[tauri::command]
pub async fn flights_key_set(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Invalid("Paste your Ignav API key.".into()));
    }
    secrets::flights_key_set(key)?;
    Ok(check_key(&state.http, key).await)
}

#[tauri::command]
pub async fn flights_key_delete() -> AppResult<()> {
    secrets::flights_key_delete()
}

/// Fares for a flight card, or nothing without a key.
#[tauri::command]
pub async fn flights_search(state: State<'_, AppState>, search: FlightSearch) -> AppResult<Option<FlightResults>> {
    let Some(key) = secrets::flights_key_get()? else { return Ok(None) };
    search_flights(&state.http, &key, &search).await.map(Some).map_err(AppError::Invalid)
}

/// Where a fare on a card can be bought. Looked up when the user asks, since
/// each lookup is a billed request.
#[tauri::command]
pub async fn flights_booking_links(state: State<'_, AppState>, fare_id: String) -> AppResult<Vec<BookingLink>> {
    let Some(key) = secrets::flights_key_get()? else {
        return Err(AppError::Invalid("Add your Ignav key in Settings → Flights.".into()));
    };
    booking_links(&state.http, &key, &fare_id).await.map_err(AppError::Invalid)
}

/// Rates for showing a card's prices in the user's currency. Needs no key.
#[tauri::command]
pub async fn flights_rates(state: State<'_, AppState>) -> AppResult<ExchangeRates> {
    exchange_rates(&state.http).await.map_err(AppError::Invalid)
}

/// Where a city is, for the card's globe. Needs no key.
#[tauri::command]
pub async fn flights_locate(state: State<'_, AppState>, city: String) -> AppResult<Option<GeoPoint>> {
    locate(&state.http, &city).await.map_err(AppError::Invalid)
}

/// The weather tile's figures. Needs no key.
#[tauri::command]
pub async fn flights_weather(state: State<'_, AppState>, city: String, date: String) -> AppResult<Option<DayWeather>> {
    day_weather(&state.http, &city, &date).await.map_err(AppError::Invalid)
}
