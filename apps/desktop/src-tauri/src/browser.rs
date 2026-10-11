//! The built-in browser: a native webview laid over the Cowork panel.
//!
//! There is one, created the first time a page is opened. The UI reports
//! where its pane is (`browser_set_view`) and the webview is moved there, or
//! hidden while the pane isn't showing. The agent drives it with the
//! `sush_core::browser` tools, which run the page script through
//! `eval_with_callback`, so pages never get IPC: no capability grants a remote
//! origin anything, and navigation to the app's own origins is refused.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sush_core::agent::ui::STOPPED;
use sush_core::browser::{self as core, Action};
use tauri::ipc::Channel;
use tauri::webview::{NewWindowResponse, PageLoadEvent, Webview, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, WebviewUrl, Wry};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::{AppError, AppResult};

const LABEL: &str = "browser";

/// Hosts that serve the app itself (custom protocols on Windows and Android).
/// A page there would count as local and could call the app's commands.
const APP_HOSTS: [&str; 4] = ["tauri.localhost", "ipc.localhost", "sushblob.localhost", "asset.localhost"];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    url: String,
    title: String,
    loading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BrowserEvent {
    Page(Page),
    /// The agent is using the browser; the UI shows the pane.
    Reveal,
}

/// Where the pane is, in CSS (logical) pixels from the window's top left.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Default)]
struct Load {
    /// Bumped when a page starts loading.
    seq: u64,
    loading: bool,
}

pub struct Browser {
    webview: Mutex<Option<Webview<Wry>>>,
    creating: tokio::sync::Mutex<()>,
    channel: Mutex<Option<Channel<BrowserEvent>>>,
    page: Mutex<Page>,
    load: watch::Sender<Load>,
    /// None while the pane is hidden.
    view: Mutex<Option<Bounds>>,
    /// Sites the user let the agent open, by thread.
    allowed: Mutex<HashMap<String, HashSet<String>>>,
}

impl Default for Browser {
    fn default() -> Self {
        Self {
            webview: Mutex::default(),
            creating: tokio::sync::Mutex::default(),
            channel: Mutex::default(),
            page: Mutex::default(),
            load: watch::channel(Load::default()).0,
            view: Mutex::default(),
            allowed: Mutex::default(),
        }
    }
}

/// Whether the browser may show `url`: web pages only, never the app's own origins.
fn may_open(url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            let dev_server = cfg!(debug_assertions) && matches!(host, "localhost" | "127.0.0.1") && url.port() == Some(1420);
            !APP_HOSTS.contains(&host) && !dev_server
        }
        _ => false,
    }
}

impl Browser {
    fn emit(&self, event: BrowserEvent) {
        if let Some(channel) = self.channel.lock().unwrap().as_ref() {
            let _ = channel.send(event);
        }
    }

    fn update_page(&self, change: impl FnOnce(&mut Page)) {
        let page = {
            let mut page = self.page.lock().unwrap();
            change(&mut page);
            page.clone()
        };
        self.emit(BrowserEvent::Page(page));
    }

    fn current(&self) -> Option<Webview<Wry>> {
        self.webview.lock().unwrap().clone()
    }

    /// Show the webview at the pane's bounds, or hide it.
    fn apply_view(&self, webview: &Webview<Wry>) {
        let view = *self.view.lock().unwrap();
        let result = match view {
            Some(b) => webview
                .set_bounds(Rect {
                    position: LogicalPosition::new(b.x, b.y).into(),
                    size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into(),
                })
                .and_then(|()| webview.show()),
            None => webview.hide(),
        };
        if let Err(e) = result {
            eprintln!("sush: could not place the browser: {e}");
        }
    }

    /// Open `url`, creating the webview on first use.
    async fn open(&self, app: &AppHandle, url: Url) -> Result<(), String> {
        if !may_open(&url) {
            return Err(format!("The browser can't open {url}."));
        }
        if let Some(webview) = self.current() {
            return webview.navigate(url).map_err(|e| e.to_string());
        }
        let _creating = self.creating.lock().await;
        if let Some(webview) = self.current() {
            return webview.navigate(url).map_err(|e| e.to_string());
        }
        let window = app.get_window("main").ok_or("The app window is gone.")?;
        let new_window_app = app.clone();
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
            .on_navigation(may_open)
            // Links that open a new window open here instead.
            .on_new_window(move |url, _| {
                if may_open(&url) {
                    let app = new_window_app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(webview) = app.state::<Browser>().current() {
                            let _ = webview.navigate(url);
                        }
                    });
                }
                NewWindowResponse::Deny
            })
            .on_page_load(|webview, payload| {
                let browser = webview.state::<Browser>();
                let loading = matches!(payload.event(), PageLoadEvent::Started);
                browser.load.send_modify(|l| {
                    l.seq += u64::from(loading);
                    l.loading = loading;
                });
                let url = payload.url().to_string();
                browser.update_page(|p| {
                    p.url = url;
                    p.loading = loading;
                });
            })
            .on_document_title_changed(|webview, title| webview.state::<Browser>().update_page(|p| p.title = title));
        let bounds = self.view.lock().unwrap().unwrap_or(Bounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 });
        // `add_child` waits for the main thread, so not from an async worker.
        let webview = tauri::async_runtime::spawn_blocking(move || {
            window.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Couldn't open the browser: {e}"))?;
        self.apply_view(&webview);
        *self.webview.lock().unwrap() = Some(webview);
        Ok(())
    }

    /// Run the page script and return what it answered.
    async fn run(&self, action: Action<'_>) -> Result<Value, String> {
        let webview = self.current().ok_or("No page is open. Use browser_navigate first.")?;
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        webview
            .eval_with_callback(core::script(action), move |out| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(out);
                }
            })
            .map_err(|e| e.to_string())?;
        let raw = tokio::time::timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| "The page didn't respond in time.".to_string())?
            .map_err(|_| "The page went away.".to_string())?;
        core::decode(&raw)
    }

    async fn snapshot(&self, offset: usize) -> Result<Value, String> {
        let page = self.run(Action::Snapshot).await?;
        let text = core::page_text(&page, offset);
        let get = |k: &str| page.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        // Pages can change their address without loading (history.pushState).
        let (url, title) = (get("url"), get("title"));
        self.update_page(|p| {
            p.url = url;
            p.title = title;
        });
        Ok(Value::String(text))
    }

    /// Wait for a page load that started after `before` to finish.
    async fn wait_loaded(&self, before: u64, limit: Duration) {
        let mut rx = self.load.subscribe();
        let _ = tokio::time::timeout(limit, rx.wait_for(|l| l.seq > before && !l.loading)).await;
    }

    /// After a click or keystroke: give the page a moment, and if that started a load, let it finish.
    async fn settle(&self, before: u64) {
        tokio::time::sleep(Duration::from_millis(350)).await;
        let load = *self.load.borrow();
        if load.seq > before || load.loading {
            self.wait_loaded(before, Duration::from_secs(15)).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Sites the user let the agent open in this thread.
    pub fn allowed_sites(&self, thread_id: &str) -> HashSet<String> {
        self.allowed.lock().unwrap().get(thread_id).cloned().unwrap_or_default()
    }

    /// Run one of the agent's browser tools.
    pub async fn execute(&self, app: &AppHandle, thread_id: &str, name: &str, input: &Value, cancel: CancellationToken) -> Result<Value, String> {
        self.emit(BrowserEvent::Reveal);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(STOPPED.into()),
            result = self.dispatch(app, thread_id, name, input) => result,
        }
    }

    async fn dispatch(&self, app: &AppHandle, thread_id: &str, name: &str, input: &Value) -> Result<Value, String> {
        let before = self.load.borrow().seq;
        let reference = || input.get("ref").and_then(Value::as_u64).ok_or("ref must be an element's number.".to_string());
        match name {
            core::BROWSER_NAVIGATE => {
                let target = input.get("url").and_then(Value::as_str).unwrap_or_default();
                if let Some(script) = match target {
                    "back" => Some("history.back()"),
                    "forward" => Some("history.forward()"),
                    _ => None,
                } {
                    let webview = self.current().ok_or("No page is open.")?;
                    webview.eval(script).map_err(|e| e.to_string())?;
                    self.settle(before).await;
                } else if target == "reload" {
                    self.current().ok_or("No page is open.")?.reload().map_err(|e| e.to_string())?;
                    self.wait_loaded(before, Duration::from_secs(30)).await;
                } else {
                    let url = core::normalize_url(target)?;
                    // It's running, so the user allowed this site (or already had).
                    self.allowed.lock().unwrap().entry(thread_id.to_string()).or_default().insert(core::site(&url));
                    self.open(app, url).await?;
                    self.wait_loaded(before, Duration::from_secs(30)).await;
                }
                self.snapshot(0).await
            }
            core::BROWSER_READ => {
                let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.snapshot(offset).await
            }
            core::BROWSER_CLICK => {
                self.run(Action::Click { reference: reference()? }).await?;
                self.settle(before).await;
                self.snapshot(0).await
            }
            core::BROWSER_TYPE => {
                let text = input.get("text").and_then(Value::as_str).ok_or("text is required.")?;
                let submit = input.get("submit").and_then(Value::as_bool).unwrap_or(false);
                self.run(Action::Type { reference: reference()?, text, submit }).await?;
                self.settle(before).await;
                self.snapshot(0).await
            }
            other => Err(format!("Unknown browser tool {other}.")),
        }
    }
}

/// Receive the browser's events (replacing any earlier subscriber); returns the page shown now.
#[tauri::command]
pub fn browser_subscribe(browser: State<'_, Browser>, on_event: Channel<BrowserEvent>) -> Option<Page> {
    *browser.channel.lock().unwrap() = Some(on_event);
    browser.current().map(|_| browser.page.lock().unwrap().clone())
}

/// Open what the user typed in the address bar.
#[tauri::command]
pub async fn browser_open(app: AppHandle, browser: State<'_, Browser>, url: String) -> AppResult<()> {
    let url = core::normalize_url(&url).map_err(AppError::Invalid)?;
    browser.open(&app, url).await.map_err(AppError::Invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Go {
    Back,
    Forward,
    Reload,
}

#[tauri::command]
pub async fn browser_go(browser: State<'_, Browser>, to: Go) -> AppResult<()> {
    let Some(webview) = browser.current() else { return Ok(()) };
    match to {
        Go::Back => webview.eval("history.back()"),
        Go::Forward => webview.eval("history.forward()"),
        Go::Reload => webview.reload(),
    }
    .map_err(|e| AppError::Invalid(e.to_string()))
}

/// Where the pane is now, or None to hide the browser.
#[tauri::command]
pub async fn browser_set_view(browser: State<'_, Browser>, bounds: Option<Bounds>) -> AppResult<()> {
    *browser.view.lock().unwrap() = bounds;
    if let Some(webview) = browser.current() {
        browser.apply_view(&webview);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_pages_outside_the_app_open() {
        let ok = |s: &str| may_open(&Url::parse(s).unwrap());
        assert!(ok("https://example.com/"));
        assert!(ok("http://localhost:5173/"));
        assert!(ok("about:blank"));
        assert!(!ok("http://tauri.localhost/"));
        assert!(!ok("http://ipc.localhost/run_start"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("file:///C:/Windows/win.ini"));
    }
}
