//! The device's position for the `location_get` card, on macOS. Other platforms
//! read it through the webview (`lib/location.ts`).

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
mod macos;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy_meters: f64,
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn location_read(app: tauri::AppHandle) -> AppResult<Position> {
    // Long enough for the user to answer the system's permission prompt.
    const WAIT: std::time::Duration = std::time::Duration::from_secs(60);

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        macos::read(Box::new(move |result| {
            let _ = sender.send(result);
        }))
    })
    .map_err(|e| AppError::Invalid(e.to_string()))?;
    match tokio::time::timeout(WAIT, receiver).await {
        Ok(Ok(result)) => result.map_err(AppError::Invalid),
        _ => Err(AppError::Invalid("Finding your location took too long.".into())),
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn location_read() -> AppResult<Position> {
    Err(AppError::Invalid("Location isn't available this way on this device.".into()))
}
