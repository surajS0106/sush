//! `sush://` links from other apps. Yammer's "Ask in Sush" on a meeting opens
//! `sush://ask?meeting=<id>&title=<title>`, and Sush opens a new chat with the
//! composer prefilled to ask about that meeting (through the Yammer connector).
//!
//! macOS hands a link to the running app. Windows and Linux start a second
//! copy with the link as an argument, so the single-instance plugin (with its
//! `deep-link` feature) forwards it here and that copy exits. A link that
//! started Sush arrives before the page listens, so links wait in `Pending`
//! until the page takes them (`deep_link_take`); later ones also go out as a
//! `deep-link` event.
//!
//! Links come from anywhere (a web page can open one), so they only ever fill
//! in the composer: nothing is sent or changed without the user.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

/// What a link asks for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LinkRequest {
    /// Ask about a Yammer meeting.
    #[serde(rename_all = "camelCase")]
    AskMeeting { meeting: u64, title: String },
}

#[derive(Default)]
pub struct Pending(Mutex<Vec<LinkRequest>>);

pub fn init(app: &AppHandle) {
    app.manage(Pending::default());
    // Installers register the scheme; a dev build or an AppImage has to do it at runtime.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(e) = app.deep_link().register_all() {
        eprintln!("couldn't register sush:// links: {e}");
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, &urls);
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| receive(&handle, &event.urls()));
}

fn receive(app: &AppHandle, urls: &[Url]) {
    let requests: Vec<LinkRequest> = urls.iter().filter_map(parse).collect();
    if requests.is_empty() {
        return;
    }
    focus(app);
    app.state::<Pending>().0.lock().unwrap().extend(requests.iter().cloned());
    let _ = app.emit("deep-link", ());
}

/// Bring Sush to the front: a link, or a second launch, is the user wanting it.
pub fn focus(app: &AppHandle) {
    let window = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next());
    if let Some(w) = window {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn parse(url: &Url) -> Option<LinkRequest> {
    if url.scheme() != "sush" || url.host_str() != Some("ask") {
        return None;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let meeting = param("meeting")?.parse().ok()?;
    // Shown in the composer, so kept short and on one line.
    let title: String = param("title").unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
    Some(LinkRequest::AskMeeting { meeting, title })
}

/// The links that arrived since the page last asked, oldest first.
#[tauri::command]
pub fn deep_link_take(pending: tauri::State<'_, Pending>) -> Vec<LinkRequest> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ask_links() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert_eq!(
            parse(&url("sush://ask?meeting=1794819600000&title=Weekly%20%0Async")),
            Some(LinkRequest::AskMeeting { meeting: 1_794_819_600_000, title: "Weekly sync".into() })
        );
        assert_eq!(parse(&url("sush://ask?meeting=5")), Some(LinkRequest::AskMeeting { meeting: 5, title: String::new() }));
        assert_eq!(parse(&url("sush://ask?meeting=abc")), None);
        assert_eq!(parse(&url("sush://delete?meeting=5")), None);
        assert_eq!(parse(&url("https://ask?meeting=5")), None);
        let long = format!("sush://ask?meeting=1&title={}", "a".repeat(500));
        let Some(LinkRequest::AskMeeting { title, .. }) = parse(&url(&long)) else { panic!() };
        assert_eq!(title.len(), 120);
    }
}
