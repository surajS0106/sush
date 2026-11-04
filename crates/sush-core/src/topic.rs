//! What's known about a person, place or thing, from English Wikipedia, which takes
//! no key: the article's text, its photos (hosted by Wikimedia, each linking to its
//! file page for credit and licence) and the news and web articles it cites. Only
//! the summary is required: an article whose photos or citations can't be read still
//! gives an answer.

use std::collections::HashSet;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

const SITE: &str = "https://en.wikipedia.org";
const TIMEOUT: Duration = Duration::from_secs(12);
const MAX_IMAGES: usize = 16;
const MAX_REFERENCES: usize = 8;
const MAX_EXTRACT: usize = 6000;
/// Words in a file's name that mean a diagram or emblem rather than a picture of the subject.
const NOT_PHOTOS: [&str; 10] = ["seal", "flag", "signature", "icon", "logo", "map", "coat", "election", "electoral", "results"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicImage {
    pub thumb: String,
    pub full: String,
    pub caption: Option<String>,
    /// The file's page, with its credit and licence.
    pub page: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicReference {
    pub title: String,
    pub url: String,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub title: String,
    pub description: Option<String>,
    pub extract: String,
    pub url: String,
    pub images: Vec<TopicImage>,
    pub references: Vec<TopicReference>,
}

/// `(` and `)` encoded, since a URL goes inside a markdown citation marker.
fn marker_safe(url: &str) -> String {
    url.replace('(', "%28").replace(')', "%29")
}

fn page_url(path: &[&str], title: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(SITE).map_err(|e| e.to_string())?;
    url.path_segments_mut().map_err(|_| "bad site address".to_string())?.extend(path).push(title);
    Ok(url)
}

/// `Ok(None)` for a page that doesn't exist.
async fn get(http: &reqwest::Client, url: reqwest::Url) -> Result<Option<reqwest::Response>, String> {
    let resp = http.get(url).timeout(TIMEOUT).send().await.map_err(|_| "couldn't reach Wikipedia".to_string())?;
    match resp.status() {
        s if s.is_success() => Ok(Some(resp)),
        reqwest::StatusCode::NOT_FOUND => Ok(None),
        s => Err(format!("Wikipedia answered HTTP {}", s.as_u16())),
    }
}

async fn get_json(http: &reqwest::Client, url: reqwest::Url) -> Result<Option<Value>, String> {
    let Some(resp) = get(http, url).await? else { return Ok(None) };
    resp.json().await.map(Some).map_err(|_| "Wikipedia sent an unreadable answer".to_string())
}

/// A summary that's an article, not a page listing several things of that name.
async fn summary(http: &reqwest::Client, title: &str) -> Result<Option<Value>, String> {
    let body = get_json(http, page_url(&["api", "rest_v1", "page", "summary"], title)?).await?;
    Ok(body.filter(|b| b["type"] == "standard"))
}

fn first_match(search: &Value) -> Option<&str> {
    search["pages"].get(0)?["key"].as_str()
}

async fn find(http: &reqwest::Client, query: &str) -> Result<Option<Value>, String> {
    if let Some(found) = summary(http, query).await? {
        return Ok(Some(found));
    }
    let url = reqwest::Url::parse_with_params(&format!("{SITE}/w/rest.php/v1/search/page"), [("q", query), ("limit", "1")]).map_err(|e| e.to_string())?;
    let Some(results) = get_json(http, url).await? else { return Ok(None) };
    match first_match(&results) {
        Some(key) => summary(http, key).await,
        None => Ok(None),
    }
}

/// The start of the article's text, cut at the end of a paragraph where it can be.
fn trim_extract(text: &str) -> String {
    if text.len() <= MAX_EXTRACT {
        return text.trim().to_owned();
    }
    let mut end = MAX_EXTRACT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = &text[..end];
    cut[..cut.rfind("\n").unwrap_or(end)].trim().to_owned()
}

fn parse_extract(body: &Value) -> Option<String> {
    let text = body["query"]["pages"].get(0)?["extract"].as_str()?;
    Some(trim_extract(text)).filter(|t| !t.is_empty())
}

async fn extract(http: &reqwest::Client, title: &str) -> Option<String> {
    let params = [
        ("action", "query"),
        ("prop", "extracts"),
        ("explaintext", "1"),
        ("exsectionformat", "plain"),
        ("redirects", "1"),
        ("titles", title),
        ("format", "json"),
        ("formatversion", "2"),
    ];
    let url = reqwest::Url::parse_with_params(&format!("{SITE}/w/api.php"), params).ok()?;
    parse_extract(&get_json(http, url).await.ok()??)
}

fn looks_like_photo(file: &str) -> bool {
    let name = file.to_lowercase();
    !name.ends_with(".svg") && !name.split(|c: char| !c.is_alphanumeric()).any(|word| NOT_PHOTOS.contains(&word))
}

fn absolute(src: &str) -> String {
    match src.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => src.to_owned(),
    }
}

fn parse_images(media: &Value) -> Vec<TopicImage> {
    let items = media["items"].as_array().map(Vec::as_slice).unwrap_or_default();
    items
        .iter()
        .filter(|i| i["type"] == "image" && i["showInGallery"] == true)
        .filter_map(|item| {
            let file = item["title"].as_str().filter(|f| looks_like_photo(f))?;
            let sizes = item["srcset"].as_array()?;
            let src = |size: Option<&Value>| size.and_then(|s| s["src"].as_str()).map(absolute);
            Some(TopicImage {
                thumb: src(sizes.first())?,
                full: src(sizes.last())?,
                caption: item["caption"]["text"].as_str().map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned),
                page: page_url(&["wiki"], file).ok()?.to_string(),
            })
        })
        .take(MAX_IMAGES)
        .collect()
}

/// The article's lead image, for an article with nothing in its gallery.
fn lead_image(summary: &Value) -> Option<TopicImage> {
    let thumb = summary["thumbnail"]["source"].as_str()?;
    Some(TopicImage {
        thumb: thumb.to_owned(),
        full: summary["originalimage"]["source"].as_str().unwrap_or(thumb).to_owned(),
        caption: None,
        page: summary["content_urls"]["desktop"]["page"].as_str()?.to_owned(),
    })
}

async fn images(http: &reqwest::Client, title: &str) -> Vec<TopicImage> {
    let Ok(url) = page_url(&["api", "rest_v1", "page", "media-list"], title) else { return Vec::new() };
    get_json(http, url).await.ok().flatten().map(|m| parse_images(&m)).unwrap_or_default()
}

/// Markup as plain text.
fn plain(html: &str) -> String {
    let tags = Regex::new(r"<[^>]*>").expect("valid pattern");
    tags.replace_all(html, "")
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .trim()
        .to_owned()
}

fn host(url: &str) -> Option<String> {
    Some(reqwest::Url::parse(url).ok()?.host_str()?.trim_start_matches("www.").to_owned())
}

/// The news, web, journal and magazine articles an article's HTML cites: at most one
/// from a site, those naming their publisher first, since they're mostly the press
/// rather than stray pages. Books and saved copies are left out.
fn parse_references(html: &str) -> Vec<TopicReference> {
    let cite = Regex::new(r#"(?s)<cite\b[^>]*class="citation (?:news|web|journal|magazine)\b[^"]*"[^>]*>(.*?)</cite>"#).expect("valid pattern");
    let link = Regex::new(r#"(?s)<a\b[^>]*rel="mw:ExtLink[^"]*"[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>"#).expect("valid pattern");
    let work = Regex::new(r"(?s)<i\b[^>]*>(.*?)</i>").expect("valid pattern");
    let mut hosts = HashSet::new();
    let mut found: Vec<TopicReference> = cite
        .captures_iter(html)
        .filter_map(|c| {
            let body = c.get(1)?.as_str();
            let m = link.captures(body)?;
            let url = plain(m.get(1)?.as_str());
            let site = host(&url)?;
            if site.ends_with("archive.org") || site.ends_with("wikipedia.org") || !hosts.insert(site) {
                return None;
            }
            // Quotes come off the ends, and any left inside can't go in a citation marker.
            let title = plain(m.get(2)?.as_str()).trim_matches('"').replace('"', "'");
            if title.is_empty() {
                return None;
            }
            let after = &body[m.get(0)?.end()..];
            let publisher = work.captures(after).and_then(|w| Some(plain(w.get(1)?.as_str()))).filter(|p| !p.is_empty());
            Some(TopicReference { title, url: marker_safe(&url), publisher })
        })
        .collect();
    found.sort_by_key(|r| r.publisher.is_none());
    found.truncate(MAX_REFERENCES);
    found
}

async fn references(http: &reqwest::Client, title: &str) -> Vec<TopicReference> {
    let Ok(url) = page_url(&["api", "rest_v1", "page", "html"], title) else { return Vec::new() };
    let Ok(Some(resp)) = get(http, url).await else { return Vec::new() };
    resp.text().await.map(|html| parse_references(&html)).unwrap_or_default()
}

/// The article best matching `query`, if there is one.
pub async fn lookup(http: &reqwest::Client, query: &str) -> Result<Option<Topic>, String> {
    let Some(summary) = find(http, query).await? else { return Ok(None) };
    let Some(title) = summary["title"].as_str() else { return Ok(None) };
    let Some(url) = summary["content_urls"]["desktop"]["page"].as_str() else { return Ok(None) };
    let (text, mut pictures, cited) = futures::future::join3(extract(http, title), images(http, title), references(http, title)).await;
    if pictures.is_empty() {
        pictures.extend(lead_image(&summary));
    }
    Ok(Some(Topic {
        title: title.to_owned(),
        description: summary["description"].as_str().map(str::to_owned),
        extract: text.or_else(|| summary["extract"].as_str().map(str::to_owned)).unwrap_or_default(),
        url: marker_safe(url),
        images: pictures,
        references: cited,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_gallery_holds_photos_not_diagrams_or_audio() {
        let media = json!({ "items": [
            { "title": "File:Portrait.jpg", "type": "image", "showInGallery": true,
              "caption": { "text": " At his desk " },
              "srcset": [{ "src": "//thumb.wikimedia.org/a/500.jpg", "scale": "1x" }, { "src": "//thumb.wikimedia.org/a/1280.jpg", "scale": "2x" }] },
            { "title": "File:Speech.ogg", "type": "audio", "showInGallery": false },
            { "title": "File:Results.svg", "type": "image", "showInGallery": true, "srcset": [{ "src": "//t/r.png" }] },
            { "title": "File:Flag_of_Ireland.png", "type": "image", "showInGallery": true, "srcset": [{ "src": "//t/f.png" }] },
            { "title": "File:Mapleton_house.jpg", "type": "image", "showInGallery": true, "srcset": [{ "src": "//t/h.jpg" }] },
        ] });
        let images = parse_images(&media);
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].thumb, "https://thumb.wikimedia.org/a/500.jpg");
        assert_eq!(images[0].full, "https://thumb.wikimedia.org/a/1280.jpg");
        assert_eq!(images[0].caption.as_deref(), Some("At his desk"));
        assert_eq!(images[0].page, "https://en.wikipedia.org/wiki/File:Portrait.jpg");
        assert_eq!(images[1].caption, None);
    }

    #[test]
    fn references_are_titled_one_per_site_with_the_press_first() {
        let html = r##"
<cite class="citation web cs1"><a rel="mw:ExtLink nofollow" href="https://web.archive.org/web/1/x" class="external text">"Saved"</a></cite>
<cite class="citation web cs1" about="#a"><a rel="mw:ExtLink nofollow" href="https://www.jfklibrary.org/a_(b)" class="external text" id="x">"Alliance &amp; Progress"</a>. Library.</cite>
<cite class="citation news cs1">Doe, J. <a rel="mw:WikiLink" href="./Doe">Doe</a> <a rel="mw:ExtLink nofollow" href="https://www.nytimes.com/1" class="external text">"The <b>"big"</b> day"</a>. <i id="i"><a href="./NYT">The New York Times</a></i>.</cite>
<cite class="citation news cs1"><a rel="mw:ExtLink nofollow" href="https://www.nytimes.com/2" class="external text">"Second"</a>. <i>The New York Times</i>.</cite>
<cite class="citation book cs1"><a rel="mw:ExtLink nofollow" href="https://books.example/1" class="external text">A book</a></cite>"##;
        let refs = parse_references(html);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].url, "https://www.nytimes.com/1");
        assert_eq!(refs[0].title, "The 'big' day");
        assert_eq!(refs[0].publisher.as_deref(), Some("The New York Times"));
        assert_eq!(refs[1].url, "https://www.jfklibrary.org/a_%28b%29");
        assert_eq!(refs[1].title, "Alliance & Progress");
        assert_eq!(refs[1].publisher, None);
    }

    #[test]
    fn long_text_is_cut_between_paragraphs() {
        let text = format!("{}\nsecond", "é".repeat(MAX_EXTRACT / 2 - 1));
        assert!(trim_extract(&text).ends_with('é'));
        let long = format!("first\n{}", "x".repeat(MAX_EXTRACT));
        assert_eq!(trim_extract(&long), "first");
        assert_eq!(trim_extract(" short "), "short");
    }

    #[test]
    fn a_title_is_encoded_as_one_path_segment() {
        let url = page_url(&["api", "rest_v1", "page", "summary"], "AC/DC (band)").unwrap();
        assert_eq!(url.as_str(), "https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC%20(band)");
    }

    #[test]
    fn a_search_gives_its_first_page_or_nothing() {
        assert_eq!(first_match(&json!({ "pages": [{ "key": "A_b" }, { "key": "C" }] })), Some("A_b"));
        assert_eq!(first_match(&json!({ "pages": [] })), None);
    }

    #[test]
    fn the_lead_image_needs_a_thumbnail() {
        let page = json!({ "desktop": { "page": "https://en.wikipedia.org/wiki/A" } });
        assert_eq!(lead_image(&json!({ "content_urls": page })), None);
        let image = lead_image(&json!({ "content_urls": page, "thumbnail": { "source": "https://t/a.jpg" } })).unwrap();
        assert_eq!(image.full, "https://t/a.jpg");
    }
}
