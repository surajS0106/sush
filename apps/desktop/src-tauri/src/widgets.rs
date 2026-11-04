//! A connector's own UI: MCP servers can offer a `ui://` widget, an HTML page that shows a tool's
//! result. It's served here on a scheme of its own because the app's CSP would block its scripts in a
//! `srcdoc` frame. It gets its own CSP, from what the server declares, and the UI frames it sandboxed
//! with `allow-scripts` only, so it has an opaque origin and nothing of the app's.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{State, UriSchemeContext};

use crate::connectors::running_client;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const SCHEME: &str = "sushwidget";
/// Pages hold the tool's output, so only the latest few stay in memory.
const KEPT: usize = 8;

struct Page {
    token: String,
    html: String,
    csp: String,
}

static PAGES: Mutex<Vec<Page>> = Mutex::new(Vec::new());
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Only full https origins, without anything that could end the CSP directive.
fn domains(meta: &Value, camel: &str, snake: &str) -> String {
    let csp = if meta["ui"]["csp"].is_object() { &meta["ui"]["csp"] } else { &meta["openai/widgetCSP"] };
    let list = csp[camel].as_array().or_else(|| csp[snake].as_array());
    list.into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|d| d.starts_with("https://") && d.chars().all(|c| c.is_ascii_alphanumeric() || ".-:/*_".contains(c)))
        .fold(String::new(), |all, d| format!("{all} {d}"))
}

fn content_policy(meta: &Value) -> String {
    let resources = domains(meta, "resourceDomains", "resource_domains");
    let connect = domains(meta, "connectDomains", "connect_domains");
    format!(
        "default-src 'none'; script-src 'unsafe-inline'{resources}; style-src 'unsafe-inline'{resources}; \
         img-src data: blob: https://media-assets.swiggy.com https://instamart-media-assets.swiggy.com{resources}; \
         font-src data:{resources}; media-src{resources}; connect-src{connect}; base-uri 'none'; form-action 'none'"
    )
}

/// JSON that's safe inside a `<script>`.
fn script_json(value: &Value) -> String {
    value.to_string().replace('<', "\\u003c")
}

/// Widgets built for the Apps SDK read `window.openai` as they load; those built for MCP Apps talk
/// over `postMessage`, which the UI answers. Reports the page's height either way.
fn host_script(input: &Value, output: &Value, dark: bool) -> String {
    let (input, output) = (script_json(input), script_json(output));
    let theme = if dark { "dark" } else { "light" };
    format!(
        r#"<script>(function(){{
var post=function(m){{parent.postMessage(m,"*")}};
window.openai={{toolInput:{input},toolOutput:{output},toolResponseMetadata:null,widgetState:null,theme:"{theme}",displayMode:"inline",locale:"en-IN",maxHeight:720,
callTool:function(){{return Promise.reject(new Error("This view can't change anything yet."))}},
sendFollowUpMessage:function(){{return Promise.resolve()}},
openExternal:function(o){{post({{sushWidget:"open",href:o&&o.href}})}},
notifyIntrinsicHeight:function(h){{post({{sushWidget:"height",height:h}})}},
setWidgetState:function(){{return Promise.resolve()}},
requestDisplayMode:function(){{return Promise.resolve({{mode:"inline"}})}}}};
addEventListener("DOMContentLoaded",function(){{new ResizeObserver(function(){{post({{sushWidget:"height",height:document.documentElement.scrollHeight}})}}).observe(document.documentElement)}});
}})()</script>"#
    )
}

/// Put the script first, so it runs before the widget's own.
fn with_script(html: &str, script: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let at = lower.find("<head").and_then(|start| lower[start..].find('>').map(|end| start + end + 1));
    match at {
        Some(at) => format!("{}{script}{}", &html[..at], &html[at..]),
        None => format!("{script}{html}"),
    }
}

/// Fetch a tool's widget from its server and return the URL to frame it at.
#[tauri::command]
pub async fn connector_widget(state: State<'_, AppState>, id: String, uri: String, input: Value, output: Value, dark: bool) -> AppResult<String> {
    if !uri.starts_with("ui://") {
        return Err(AppError::Invalid("That isn't a widget.".into()));
    }
    let client = running_client(&state, &id).await?;
    let resource = client.read_resource(&uri).await?;
    let content = &resource["contents"][0];
    let html = content["text"].as_str().ok_or_else(|| AppError::Invalid("The server sent no page for this widget.".into()))?;

    let token = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let page = Page { token: token.clone(), html: with_script(html, &host_script(&input, &output, dark)), csp: content_policy(&content["_meta"]) };
    let mut pages = PAGES.lock().expect("widget pages");
    pages.push(page);
    if pages.len() > KEPT {
        pages.remove(0);
    }
    Ok(if cfg!(windows) { format!("http://{SCHEME}.localhost/{token}") } else { format!("{SCHEME}://localhost/{token}") })
}

pub fn serve<R: tauri::Runtime>(_: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');
    let pages = PAGES.lock().expect("widget pages");
    match pages.iter().find(|p| p.token == token) {
        Some(page) => Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, &page.csp)
            .body(page.html.clone().into_bytes()),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()),
    }
    .expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn policy_keeps_only_https_origins_it_can_quote() {
        let meta = json!({ "ui": { "csp": {
            "resourceDomains": ["https://cdn.swiggy.com", "http://plain.example", "https://x.com; script-src *"],
            "connectDomains": ["https://mcp.swiggy.com"],
        } } });
        let policy = content_policy(&meta);
        assert!(policy.contains("script-src 'unsafe-inline' https://cdn.swiggy.com;"));
        assert!(policy.contains("connect-src https://mcp.swiggy.com;"));
        assert!(!policy.contains("plain.example"));
        assert!(!policy.contains("x.com"));
    }

    #[test]
    fn script_goes_first_in_the_head_and_output_cant_close_it() {
        assert_eq!(with_script("<html><HEAD lang=\"en\"><title>a</title>", "S"), "<html><HEAD lang=\"en\">S<title>a</title>");
        assert_eq!(with_script("<div>a</div>", "S"), "S<div>a</div>");
        assert_eq!(script_json(&json!({ "a": "</script>" })), r#"{"a":"\u003c/script>"}"#);
    }
}
