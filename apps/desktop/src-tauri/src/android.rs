//! What Sush asks of Android, through the Kotlin in `gen/android/.../com/sush/app`:
//! picking and sharing files (`SushPlugin.kt`), keeping runs going with the app
//! in the background (`RunService.kt`), and the key for the secrets file (`Vault.kt`).

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::OnceLock;

use jni::objects::{JByteArray, JObject};
use jni::JNIEnv;
use serde::{Deserialize, Serialize};
use tauri::plugin::mobile::PluginInvokeError;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

use crate::error::{AppError, AppResult};

struct Native(PluginHandle<Wry>);

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("sush-android")
        .setup(|app, api| {
            app.manage(Native(api.register_android_plugin("com.sush.app", "SushPlugin")?));
            Ok(())
        })
        .build()
}

/// A plugin call that failed. A rejection from Kotlin is already a sentence for the user.
fn plugin_err(fallback: &'static str) -> impl FnOnce(PluginInvokeError) -> AppError {
    move |e| match e {
        PluginInvokeError::InvokeRejected(r) => AppError::Invalid(r.to_string()),
        other => {
            eprintln!("sush: android plugin: {other}");
            AppError::Invalid(fallback.into())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickArgs {
    mime_types: Vec<String>,
    multiple: bool,
}

#[derive(Deserialize)]
struct Picked {
    paths: Vec<PathBuf>,
}

/// Ask for files. Android hands over content links rather than paths, so Kotlin
/// copies what was picked into the app's cache, under its own name. Blocks.
pub fn pick_files(app: &AppHandle, mime_types: Vec<String>, multiple: bool) -> AppResult<Vec<PathBuf>> {
    app.state::<Native>()
        .0
        .run_mobile_plugin::<Picked>("pickFiles", PickArgs { mime_types, multiple })
        .map(|p| p.paths)
        .map_err(plugin_err("Couldn't open the file picker. Try again."))
}

#[derive(Serialize)]
struct ShareArgs {
    path: PathBuf,
}

/// Hand a file in the app's cache to the share sheet, where it can be saved or sent. Blocks.
pub fn share_file(app: &AppHandle, path: PathBuf) -> AppResult<()> {
    app.state::<Native>()
        .0
        .run_mobile_plugin::<serde_json::Value>("shareFile", ShareArgs { path })
        .map(drop)
        .map_err(plugin_err("Couldn't open the share sheet. Try again."))
}

#[derive(Serialize)]
struct BarsArgs {
    dark: bool,
}

/// Match the system bars to Sush's theme, which may not be the phone's.
#[tauri::command]
pub async fn android_bars(app: AppHandle, dark: bool) -> AppResult<()> {
    app.state::<Native>()
        .0
        .run_mobile_plugin::<serde_json::Value>("bars", BarsArgs { dark })
        .map(drop)
        .map_err(plugin_err("Couldn't change the system bars."))
}

/// The runs in flight, for the service's notification.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Activity {
    /// Titles of the sessions working now.
    pub working: Vec<String>,
    /// Sessions with nothing left but calls waiting for the user.
    pub waiting: Vec<Waiting>,
    /// A session that has just finished; shown only if the app isn't on screen.
    pub finished: Option<Finished>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Waiting {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finished {
    pub id: String,
    pub title: String,
    pub failed: bool,
}

/// Tell the service what's running. Returns at once: plugin calls wait for the
/// main thread, so they're made in order from a thread of their own.
pub fn runs_changed(app: &AppHandle, activity: Activity) {
    static QUEUE: OnceLock<mpsc::Sender<Activity>> = OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Activity>();
        let app = app.clone();
        std::thread::spawn(move || {
            let mut last = Activity::default();
            for activity in rx {
                if activity == last {
                    continue;
                }
                let Some(native) = app.try_state::<Native>() else { continue };
                if let Err(e) = native.0.run_mobile_plugin::<serde_json::Value>("runs", activity.clone()) {
                    eprintln!("sush: couldn't update the run service: {e}");
                }
                last = Activity { finished: None, ..activity };
            }
        });
        tx
    });
    let _ = queue.send(activity);
}

/// The secrets file's key, unwrapped by the Android Keystore (`Vault.kt`), before Tauri starts.
#[no_mangle]
pub extern "system" fn Java_com_sush_app_SushNative_unlock<'l>(env: JNIEnv<'l>, _this: JObject<'l>, key: JByteArray<'l>) {
    match env.convert_byte_array(&key).map(<[u8; 32]>::try_from) {
        Ok(Ok(key)) => crate::secrets::unlock(key),
        _ => eprintln!("sush: the secrets file's key wasn't 32 bytes"),
    }
}
