//! Web search and page reading for models whose provider has no search of its own.
//! Search goes through Ollama's web search API with the user's own Ollama key
//! (free with an Ollama account). A page is read through Ollama too when there is
//! a key, and otherwise fetched from this machine: then only public addresses are
//! allowed, checked at every redirect and pinned for the connection, so a model
//! can't use the tool to reach the user's router, local servers or cloud metadata.
//!
//! Anthropic and OpenAI models get their provider's own search instead: their
//! wire formats swap the tools named here for native ones (`providers/`).

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};

/// The tools' names, which providers with search of their own replace.
pub const SEARCH: &str = "web_search";
pub const FETCH: &str = "web_fetch";

/// Whether a provider can put its own search in place of Sush's tools for this request:
/// not when the conversation already holds calls to Sush's tools (from another model
/// earlier on), which would then name a tool the request no longer defines.
pub fn native_ok(req: &crate::ChatRequest) -> bool {
    !req.messages.iter().flat_map(|m| &m.parts).any(|p| matches!(p, crate::Part::ToolCall { name, .. } if name == SEARCH || name == FETCH))
}

const OLLAMA: &str = "https://ollama.com/api";
const TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_RESULTS: u32 = 5;
const MAX_RESULTS: u32 = 10;
const MAX_SNIPPET: usize = 1500;
/// How much of a page one call returns; `offset` reads on from there.
const MAX_PAGE: usize = 12_000;
const MAX_BODY: usize = 3 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    /// What the page says about the query.
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    pub url: String,
    pub title: Option<String>,
    pub content: String,
    /// Where the next call should start, when the page goes on.
    pub next_offset: Option<usize>,
}

/// At most `max` bytes of `text`, cut at a char boundary.
fn cut(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

async fn ollama(http: &reqwest::Client, key: &str, path: &str, body: Value) -> Result<Value, String> {
    let resp = http
        .post(format!("{OLLAMA}/{path}"))
        .bearer_auth(key)
        .json(&body)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|_| "couldn't reach Ollama's web search".to_string())?;
    match resp.status().as_u16() {
        200..=299 => resp.json().await.map_err(|_| "Ollama sent an unreadable answer".to_string()),
        401 | 403 => Err("Ollama didn't accept the key in Settings → Search".into()),
        429 => Err("the Ollama account's web search limit was reached; try again later".into()),
        s => Err(format!("Ollama's web search answered HTTP {s}")),
    }
}

/// Brackets and spaces encoded, since the model copies a URL into a `[cite](URL "TITLE")` marker.
fn marker_safe(url: &str) -> String {
    url.replace(' ', "%20").replace('(', "%28").replace(')', "%29")
}

fn parse_results(body: &Value) -> Vec<SearchResult> {
    let items = body["results"].as_array().map(Vec::as_slice).unwrap_or_default();
    items
        .iter()
        .filter_map(|r| {
            let url = r["url"].as_str().filter(|u| u.starts_with("http"))?;
            let snippet = r["content"].as_str().unwrap_or_default().trim();
            Some(SearchResult {
                title: r["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(url).to_owned(),
                url: marker_safe(url),
                snippet: cut(snippet, MAX_SNIPPET).to_owned(),
            })
        })
        .collect()
}

/// The pages best matching `query`.
pub async fn search(http: &reqwest::Client, key: &str, query: &str, max_results: Option<u32>) -> Result<Vec<SearchResult>, String> {
    let max = max_results.unwrap_or(DEFAULT_RESULTS).clamp(1, MAX_RESULTS);
    let body = ollama(http, key, "web_search", json!({ "query": query, "max_results": max })).await?;
    Ok(parse_results(&body))
}

/// A short search, to tell whether a key works. `None` when it does.
pub async fn check_key(http: &reqwest::Client, key: &str) -> Option<String> {
    search(http, key, "ollama", Some(1)).await.err()
}

/// `content` from `offset` on, at most a call's worth.
fn page(url: String, title: Option<String>, content: &str, offset: usize) -> WebPage {
    let mut start = offset.min(content.len());
    while !content.is_char_boundary(start) {
        start -= 1;
    }
    let part = cut(&content[start..], MAX_PAGE);
    let end = start + part.len();
    WebPage { url: marker_safe(&url), title, content: part.to_owned(), next_offset: (end < content.len()).then_some(end) }
}

/// The readable text of the page at `url`, from `offset` (a byte position a
/// previous call returned) on.
pub async fn fetch(http: &reqwest::Client, key: Option<&str>, url: &str, offset: usize) -> Result<WebPage, String> {
    let url = parse_url(url)?;
    match key {
        Some(key) => {
            let body = ollama(http, key, "web_fetch", json!({ "url": url.as_str() })).await?;
            let title = body["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
            Ok(page(url.to_string(), title, body["content"].as_str().unwrap_or_default().trim(), offset))
        }
        None => {
            let (url, title, text) = fetch_here(&url).await?;
            Ok(page(url, title, &text, offset))
        }
    }
}

fn parse_url(url: &str) -> Result<reqwest::Url, String> {
    let url = url.trim();
    let with_scheme = if url.contains("://") { url.to_owned() } else { format!("https://{url}") };
    let parsed = reqwest::Url::parse(&with_scheme).map_err(|_| format!("\"{url}\" isn't a web address"))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed),
        _ => Err("only http and https pages can be read".into()),
    }
}

/// Whether an address is on the public internet.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// A public address for the URL's host, or why it can't be used.
async fn public_address(url: &reqwest::Url) -> Result<SocketAddr, String> {
    const REFUSED: &str = "that address is on this computer or its local network, which web_fetch doesn't read";
    let host = url.host_str().ok_or("the address has no host")?;
    let port = url.port_or_known_default().unwrap_or(443);
    let name = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if name == "localhost" || [".localhost", ".local", ".internal", ".lan", ".home.arpa"].iter().any(|s| name.ends_with(s)) {
        return Err(REFUSED.into());
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), port))
        .await
        .map_err(|_| format!("couldn't find {host}"))?
        .collect();
    // Every address must be public, or a name could point at both kinds.
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(REFUSED.into());
    }
    Ok(addrs[0])
}

/// Fetches a public page from this machine, following redirects one at a time so
/// each hop's address is checked, and connecting to the address that was checked.
async fn fetch_here(start: &reqwest::Url) -> Result<(String, Option<String>, String), String> {
    let mut url = start.clone();
    for _ in 0..=MAX_REDIRECTS {
        let addr = public_address(&url).await?;
        let host = url.host_str().unwrap_or_default().to_owned();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .timeout(TIMEOUT)
            .user_agent(concat!("Sush/", env!("CARGO_PKG_VERSION"), " (web_fetch)"))
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client
            .get(url.clone())
            .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
            .send()
            .await
            .map_err(|_| format!("couldn't reach {host}"))?;
        let status = resp.status();
        if status.is_redirection() {
            let location = resp.headers().get("location").and_then(|l| l.to_str().ok()).ok_or("the page redirected nowhere")?;
            url = url.join(location).map_err(|_| "the page redirected to a bad address".to_string())?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("the page redirected away from the web".into());
            }
            continue;
        }
        if !status.is_success() {
            return Err(format!("{host} answered HTTP {}", status.as_u16()));
        }
        let kind = resp.headers().get("content-type").and_then(|t| t.to_str().ok()).unwrap_or("text/html").to_ascii_lowercase();
        let html = kind.contains("html") || kind.contains("xml");
        let text_like = html || kind.starts_with("text/") || kind.contains("json");
        if !text_like {
            return Err(format!("that's a {} file, not a page web_fetch can read", kind.split(';').next().unwrap_or("binary")));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| format!("{host} stopped sending the page"))? {
            body.extend_from_slice(&chunk);
            if body.len() >= MAX_BODY {
                break;
            }
        }
        let raw = String::from_utf8_lossy(&body);
        let final_url = url.to_string();
        return Ok(if html { (final_url, html_title(&raw), html_text(&raw)) } else { (final_url, None, raw.trim().to_owned()) });
    }
    Err("the page redirected too many times".into())
}

fn decode_entities(text: &str) -> String {
    let numeric = Regex::new(r"&#(x[0-9a-fA-F]+|[0-9]+);").expect("valid pattern");
    let text = numeric.replace_all(text, |c: &regex::Captures| {
        let n = &c[1];
        let code = match n.strip_prefix('x') {
            Some(hex) => u32::from_str_radix(hex, 16).ok(),
            None => n.parse().ok(),
        };
        code.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    text.replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
        .replace("&amp;", "&")
}

fn html_title(html: &str) -> Option<String> {
    let title = Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").expect("valid pattern");
    let text = decode_entities(title.captures(html)?.get(1)?.as_str().trim());
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// A page's readable text: no scripts, styles or page furniture, a line per block.
fn html_text(html: &str) -> String {
    // The article itself when the page marks it, so menus and footers stay out.
    let main = Regex::new(r"(?is)<(main|article)\b[^>]*>(.*)</(?:main|article)>").expect("valid pattern");
    let body = main.captures(html).and_then(|c| c.get(2)).map_or(html, |m| m.as_str());
    let hidden = Regex::new(r"(?is)<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[^>]*>.*?</(?:script|style|noscript|svg|template|iframe|head|nav|footer)>|<!--.*?-->")
        .expect("valid pattern");
    let text = hidden.replace_all(body, " ");
    let heading = Regex::new(r"(?i)<h([1-6])\b[^>]*>").expect("valid pattern");
    let text = heading.replace_all(&text, |c: &regex::Captures| format!("\n\n{} ", "#".repeat(c[1].parse().unwrap_or(2))));
    let item = Regex::new(r"(?i)<li\b[^>]*>").expect("valid pattern");
    let text = item.replace_all(&text, "\n- ");
    let block = Regex::new(r"(?i)<br\s*/?>|</?(p|div|section|tr|table|ul|ol|blockquote|pre|h[1-6]|dd|dt|figcaption)\b[^>]*>").expect("valid pattern");
    let text = block.replace_all(&text, "\n");
    let tags = Regex::new(r"<[^>]*>").expect("valid pattern");
    let text = decode_entities(&tags.replace_all(&text, ""));
    let mut out = String::new();
    let mut blank = false;
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() || line == "-" {
            blank = !out.is_empty();
            continue;
        }
        if blank {
            out.push('\n');
            blank = false;
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_keep_web_pages_and_cut_long_snippets() {
        let long = "x".repeat(MAX_SNIPPET + 50);
        let body = json!({ "results": [
            { "title": " Ollama ", "url": "https://ollama.com", "content": "Run models." },
            { "title": "", "url": "https://b.dev/A_(b)", "content": long },
            { "title": "Not a page", "url": "javascript:alert(1)", "content": "" },
        ] });
        let results = parse_results(&body);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], SearchResult { title: "Ollama".into(), url: "https://ollama.com".into(), snippet: "Run models.".into() });
        assert_eq!(results[1].title, "https://b.dev/A_(b)");
        assert_eq!(results[1].url, "https://b.dev/A_%28b%29");
        assert_eq!(results[1].snippet.len(), MAX_SNIPPET);
    }

    #[test]
    fn a_long_page_reads_on_from_its_offset() {
        let text = "é".repeat(MAX_PAGE);
        let first = page("u".into(), None, &text, 0);
        assert_eq!(first.content.len(), MAX_PAGE);
        let next = first.next_offset.unwrap();
        let second = page("u".into(), None, &text, next);
        assert_eq!(first.content.len() + second.content.len(), text.len());
        assert_eq!(second.next_offset, None);
        // An offset inside a character starts at that character.
        assert!(page("u".into(), None, &text, 1).content.starts_with('é'));
    }

    #[test]
    fn only_public_addresses_count() {
        for private in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
        for public in ["1.1.1.1", "93.184.216.34", "2606:4700::1111"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }

    #[test]
    fn addresses_need_the_web() {
        assert_eq!(parse_url("example.com/a").unwrap().as_str(), "https://example.com/a");
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("ftp://example.com").is_err());
    }

    #[tokio::test]
    async fn local_names_are_refused_before_any_lookup() {
        for url in ["http://localhost:3000", "http://printer.local", "http://[::1]/", "http://127.0.0.1/"] {
            assert!(public_address(&parse_url(url).unwrap()).await.is_err(), "{url}");
        }
    }

    #[test]
    fn html_becomes_readable_text() {
        let html = r#"<html><head><title>A &amp; B</title><style>p{}</style></head><body>
<nav><a href="/">Home</a></nav>
<article><h1>Heading</h1><p>First   para&nbsp;one.</p><script>evil()</script>
<ul><li>One</li><li>Two &#8212; 2</li></ul><!-- note --></article><footer>c</footer></body></html>"#;
        assert_eq!(html_title(html).as_deref(), Some("A & B"));
        assert_eq!(html_text(html), "# Heading\n\nFirst para one.\n\n- One\n- Two — 2");
    }
}
