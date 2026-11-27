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

// --- updates ---------------------------------------------------------------------
//
// The Tauri updater has no Android support, so the phone updates itself from the
// `android-v<version>` releases that `release-android.yml` publishes. Those are never the
// repo's "latest" release (that's the desktop's), so the check lists releases and takes the
// newest `android-v*` one. Android's installer only accepts an APK signed with the same key as
// the installed app, which is what keeps a tampered download out; the size and GitHub's
// SHA-256 digest of the asset are checked too, so a cut-short download never reaches it.

const RELEASES_URL: &str = "https://api.github.com/repos/surajS0106/sush/releases?per_page=30";
const DOWNLOAD_PREFIX: &str = "https://github.com/surajS0106/sush/releases/download/android-v";

/// A newer Android release than the one running.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdate {
    pub version: String,
    /// The release's notes (its section of CHANGELOG-android.md), in Markdown.
    pub notes: String,
    #[serde(skip)]
    url: String,
    #[serde(skip)]
    size: u64,
    /// `sha256:<hex>`, when GitHub gave one.
    #[serde(skip)]
    digest: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

/// `0.2.1` → `[0, 2, 1]`; anything else (a pre-release tag) isn't a version to offer.
fn parse_version(v: &str) -> Option<Vec<u64>> {
    v.split('.').map(|p| p.parse().ok()).collect()
}

/// What the last check found, for `android_update_install`.
static FOUND: std::sync::Mutex<Option<AndroidUpdate>> = std::sync::Mutex::new(None);

/// The newest Android release, if it's newer than this app.
#[tauri::command]
pub async fn android_update_check(app: AppHandle, state: tauri::State<'_, crate::state::AppState>) -> AppResult<Option<AndroidUpdate>> {
    let resp = state
        .http
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| AppError::Invalid("Couldn't reach the update server. Check your connection and try again.".into()))?;
    if !resp.status().is_success() {
        return Err(AppError::Invalid("The update server didn't respond properly. Try again in a few minutes.".into()));
    }
    let releases: Vec<GhRelease> = resp
        .json()
        .await
        .map_err(|_| AppError::Invalid("The update server didn't respond properly. Try again in a few minutes.".into()))?;
    let current = parse_version(&app.package_info().version.to_string()).unwrap_or_default();
    let newest = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let version = r.tag_name.strip_prefix("android-v")?.to_string();
            let parsed = parse_version(&version)?;
            let asset = r.assets.into_iter().find(|a| {
                a.name.ends_with("_android.apk") && a.browser_download_url.starts_with(&format!("{DOWNLOAD_PREFIX}{version}/"))
            })?;
            Some((parsed, version, r.body.unwrap_or_default(), asset))
        })
        .max_by(|a, b| a.0.cmp(&b.0));
    let update = newest.filter(|(parsed, ..)| *parsed > current).map(|(_, version, notes, asset)| AndroidUpdate {
        version,
        notes,
        url: asset.browser_download_url,
        size: asset.size,
        digest: asset.digest,
    });
    *FOUND.lock().unwrap() = update.clone();
    Ok(update)
}

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    received: u64,
    total: u64,
}

/// Download the release the last check found, then open Android's installer on it.
/// Resolves once the installer is up; installing replaces this process.
#[tauri::command]
pub async fn android_update_install(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    on_progress: tauri::ipc::Channel<UpdateProgress>,
) -> AppResult<()> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let update = FOUND.lock().unwrap().clone().ok_or_else(|| AppError::Invalid("Check for updates first.".into()))?;
    // In the cache (FileProvider serves it from there), one APK at a time; SushPlugin clears it after a day.
    let dir = app.path().app_cache_dir().map_err(|e| AppError::Invalid(e.to_string()))?.join("updates");
    std::fs::create_dir_all(&dir)?;
    let apk = dir.join(format!("Sush_{}_android.apk", update.version));
    let have = std::fs::metadata(&apk).map(|m| m.len() == update.size).unwrap_or(false);
    if !have {
        for old in std::fs::read_dir(&dir)?.flatten() {
            let _ = std::fs::remove_file(old.path());
        }
        let failed = || AppError::Invalid("The download didn't finish. Check your connection and try again.".into());
        let resp = state.http.get(&update.url).send().await.map_err(|_| failed())?;
        if !resp.status().is_success() {
            return Err(failed());
        }
        let part = apk.with_extension("apk.part");
        let mut file = tokio::fs::File::create(&part).await?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| failed())?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            let _ = on_progress.send(UpdateProgress { received, total: update.size });
        }
        file.flush().await?;
        drop(file);
        let digest = format!("sha256:{:x}", hasher.finalize());
        if received != update.size || update.digest.as_ref().is_some_and(|d| !d.eq_ignore_ascii_case(&digest)) {
            let _ = std::fs::remove_file(&part);
            return Err(AppError::Invalid("The update download was corrupted. Try again.".into()));
        }
        std::fs::rename(&part, &apk)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Native>()
            .0
            .run_mobile_plugin::<serde_json::Value>("installApk", ShareArgs { path: apk })
            .map(drop)
            .map_err(plugin_err("Couldn't open Android's installer. Try again."))
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// The secrets file's key, unwrapped by the Android Keystore (`Vault.kt`), before Tauri starts.
#[no_mangle]
pub extern "system" fn Java_com_sush_app_SushNative_unlock<'l>(env: JNIEnv<'l>, _this: JObject<'l>, key: JByteArray<'l>) {
    match env.convert_byte_array(&key).map(<[u8; 32]>::try_from) {
        Ok(Ok(key)) => crate::secrets::unlock(key),
        _ => eprintln!("sush: the secrets file's key wasn't 32 bytes"),
    }
}
