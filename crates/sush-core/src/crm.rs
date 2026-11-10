//! The CRM: companies, contacts and deals the user keeps in Sush, with a log of
//! activities on each, saved views and the pipeline's stages. Everything lives
//! in `sush.db`; nothing is synced anywhere.
//!
//! The three kinds share one flat [`Record`] (a company can carry a stage and a
//! value too, as a pipeline of accounts), stored as JSON so fields can be added
//! without migrations. Renewals aren't a table of their own: they're the deals
//! with a renewal date. A full-text index over each record and its activities
//! backs search (and, later, the CRM tools the model gets).
//!
//! Saving a record returns the [`CrmEvent`] it caused, which workflows trigger on.

use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::agent::ui::new_id;
use crate::store::{Store, StoreError, StoreResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Company,
    Contact,
    Deal,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "company" => Some(Self::Company),
            "contact" => Some(Self::Contact),
            "deal" => Some(Self::Deal),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Company => "company",
            Self::Contact => "contact",
            Self::Deal => "deal",
        }
    }
}

/// A company, contact or deal. Which fields mean something depends on `kind`;
/// the rest stay empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Empty on a new record; saving gives it one.
    #[serde(default)]
    pub id: String,
    pub kind: Kind,
    pub name: String,
    /// A contact's or deal's company.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_id: Option<String>,
    /// A company's or deal's main contact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    /// A contact's job title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// A stage id from [`CrmSettings`] (companies' or deals' list by kind).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// In the settings' currency.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_date: Option<String>,
    /// `YYYY-MM-DD`. A deal with one is listed under Renewals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renewal_date: Option<String>,
    /// 0–100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probability: Option<u8>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    /// Columns imported from a CSV that have no field of their own.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

impl Record {
    pub fn new(kind: Kind, name: impl Into<String>) -> Self {
        Self {
            id: String::new(),
            kind,
            name: name.into(),
            company_id: None,
            contact_id: None,
            domain: None,
            category: None,
            email: None,
            phone: None,
            title: None,
            owner: None,
            stage: None,
            value: None,
            close_date: None,
            renewal_date: None,
            probability: None,
            notes: String::new(),
            fields: BTreeMap::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    /// Trim text, drop empty optionals, and check what can be checked alone.
    fn tidy(&mut self) -> Result<(), String> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            return Err(format!("Give the {} a name.", self.kind.as_str()));
        }
        for f in [
            &mut self.company_id,
            &mut self.contact_id,
            &mut self.domain,
            &mut self.category,
            &mut self.email,
            &mut self.phone,
            &mut self.title,
            &mut self.owner,
            &mut self.stage,
            &mut self.close_date,
            &mut self.renewal_date,
        ] {
            *f = f.take().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        }
        self.domain = self.domain.take().map(|d| clean_domain(&d)).filter(|d| !d.is_empty());
        for d in [&self.close_date, &self.renewal_date].into_iter().flatten() {
            if !is_iso_date(d) {
                return Err(format!("“{d}” isn't a date. Use YYYY-MM-DD."));
            }
        }
        if self.value.is_some_and(|v| !v.is_finite()) {
            self.value = None;
        }
        self.probability = self.probability.map(|p| p.min(100));
        self.fields.retain(|k, v| !k.trim().is_empty() && !v.trim().is_empty());
        Ok(())
    }

    /// What search matches against.
    fn search_text(&self) -> String {
        let mut parts: Vec<&str> = vec![&self.name];
        for f in [&self.domain, &self.category, &self.email, &self.title, &self.owner, &self.phone].into_iter().flatten() {
            parts.push(f);
        }
        parts.push(&self.notes);
        parts.extend(self.fields.values().map(String::as_str));
        parts.join("\n")
    }
}

/// `https://www.Example.com/about` → `example.com`.
pub fn clean_domain(input: &str) -> String {
    let s = input.trim().to_lowercase();
    let s = s.rsplit("://").next().unwrap_or("");
    let s = s.split(['/', '?', '#']).next().unwrap_or("");
    s.strip_prefix("www.").unwrap_or(s).to_string()
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && s[..4].parse::<u32>().is_ok()
        && s[5..7].parse::<u32>().is_ok_and(|m| (1..=12).contains(&m))
        && s[8..].parse::<u32>().is_ok_and(|d| (1..=31).contains(&d))
}

// --- stages and settings ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Tone {
    /// Still in play.
    #[default]
    Open,
    Won,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tone: Tone,
}

impl Stage {
    fn new(id: &str, name: &str, tone: Tone) -> Self {
        Self { id: id.into(), name: name.into(), tone }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrmSettings {
    pub company_stages: Vec<Stage>,
    pub deal_stages: Vec<Stage>,
    /// ISO 4217, for showing values.
    pub currency: String,
}

impl Default for CrmSettings {
    fn default() -> Self {
        Self {
            company_stages: vec![
                Stage::new("lead", "Lead", Tone::Open),
                Stage::new("qualified", "Qualified", Tone::Open),
                Stage::new("customer", "Customer", Tone::Won),
                Stage::new("churned", "Churned", Tone::Lost),
            ],
            deal_stages: vec![
                Stage::new("discovery", "Discovery", Tone::Open),
                Stage::new("proposal", "Proposal", Tone::Open),
                Stage::new("negotiation", "Negotiation", Tone::Open),
                Stage::new("won", "Closed won", Tone::Won),
                Stage::new("lost", "Closed lost", Tone::Lost),
            ],
            currency: "USD".into(),
        }
    }
}

impl CrmSettings {
    pub fn stages(&self, kind: Kind) -> &[Stage] {
        match kind {
            Kind::Company => &self.company_stages,
            Kind::Deal => &self.deal_stages,
            Kind::Contact => &[],
        }
    }

    fn stages_mut(&mut self, kind: Kind) -> Option<&mut Vec<Stage>> {
        match kind {
            Kind::Company => Some(&mut self.company_stages),
            Kind::Deal => Some(&mut self.deal_stages),
            Kind::Contact => None,
        }
    }

    fn stage_name(&self, kind: Kind, id: Option<&str>) -> String {
        match id {
            None => "none".into(),
            Some(id) => self.stages(kind).iter().find(|s| s.id == id).map_or_else(|| id.to_string(), |s| s.name.clone()),
        }
    }

    /// The stage named `name` (any case), added at the end as an open stage if there's none.
    fn stage_for(&mut self, kind: Kind, name: &str) -> Option<String> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let stages = self.stages_mut(kind)?;
        let lower = name.to_lowercase();
        if let Some(s) = stages.iter().find(|s| s.name.to_lowercase() == lower || s.id == lower) {
            return Some(s.id.clone());
        }
        let id = unique_stage_id(stages, &lower);
        stages.push(Stage { id: id.clone(), name: name.to_string(), tone: Tone::Open });
        Some(id)
    }

    fn check(&self) -> Result<(), String> {
        for (what, stages) in [("company", &self.company_stages), ("deal", &self.deal_stages)] {
            if stages.is_empty() {
                return Err(format!("Keep at least one {what} stage."));
            }
            let mut seen = std::collections::HashSet::new();
            for s in stages {
                if s.name.trim().is_empty() {
                    return Err("Give every stage a name.".into());
                }
                if !seen.insert(&s.id) {
                    return Err(format!("Two {what} stages share the id “{}”.", s.id));
                }
            }
        }
        Ok(())
    }
}

fn unique_stage_id(stages: &[Stage], name: &str) -> String {
    let base: String = name.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "stage".to_string() } else { base };
    let mut id = base.clone();
    let mut n = 2;
    while stages.iter().any(|s| s.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

// --- views -----------------------------------------------------------------------------

/// The page's four built-in tables. A saved view starts from one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tab {
    Companies,
    Contacts,
    Deals,
    Renewals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilterOp {
    Is,
    IsNot,
    Contains,
    Gt,
    Lt,
    Empty,
    NotEmpty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub field: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    #[default]
    Table,
    Board,
}

/// A saved view: one of the tables with a search, filters, a sort and hidden columns.
/// The UI applies it; Rust only keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(default)]
    pub id: String,
    pub tab: Tab,
    pub name: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sort: Option<Sort>,
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub layout: Layout,
    #[serde(default)]
    pub created_at: i64,
}

// --- activities --------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityKind {
    Note,
    Email,
    Meeting,
    Call,
    /// Written by the model.
    Ai,
    /// A change Sush recorded, such as a stage move.
    Change,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    #[serde(default)]
    pub id: String,
    pub record_id: String,
    pub kind: ActivityKind,
    pub body: String,
    pub at: i64,
    /// The session that wrote it, for AI activities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

// --- events ----------------------------------------------------------------------------

/// What saving or deleting a record did, for workflow triggers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum CrmEvent {
    Created { record: Record },
    Updated { record: Record, changed: Vec<String> },
    /// Also an update; `changed` includes `stage`.
    StageChanged { record: Record, from: Option<String>, to: Option<String>, changed: Vec<String> },
    Deleted { record: Record },
}

/// The fields that differ between two versions of a record (timestamps aside).
pub fn changed_fields(old: &Record, new: &Record) -> Vec<String> {
    let (Ok(serde_json::Value::Object(a)), Ok(serde_json::Value::Object(b))) = (serde_json::to_value(old), serde_json::to_value(new)) else {
        return vec![];
    };
    let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|k| !matches!(k.as_str(), "createdAt" | "updatedAt"))
        .filter(|k| a.get(*k) != b.get(*k))
        .cloned()
        .collect()
}

/// The event saving `new` over `old` causes; `None` when nothing changed.
pub fn event(old: Option<&Record>, new: &Record) -> Option<CrmEvent> {
    let Some(old) = old else { return Some(CrmEvent::Created { record: new.clone() }) };
    let changed = changed_fields(old, new);
    if changed.is_empty() {
        None
    } else if old.stage != new.stage {
        Some(CrmEvent::StageChanged { record: new.clone(), from: old.stage.clone(), to: new.stage.clone(), changed })
    } else {
        Some(CrmEvent::Updated { record: new.clone(), changed })
    }
}

/// A saved record, and what saving it did.
#[derive(Debug, Clone)]
pub struct Saved {
    pub record: Record,
    pub event: Option<CrmEvent>,
}

/// A deleted record with what's needed to put it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub record: Record,
    pub activities: Vec<Activity>,
    /// Records that pointed at it and were unlinked.
    pub unlinked: Vec<String>,
}

// --- CSV import --------------------------------------------------------------------------

/// Read CSV (or semicolon/tab separated) text into rows. Quotes, doubled
/// quotes, line breaks inside quotes, CRLF and a BOM are handled; blank lines dropped.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let first = text.lines().next().unwrap_or("");
    let delim = [',', ';', '\t'].into_iter().max_by_key(|d| first.matches(*d).count()).unwrap_or(',');
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == delim {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r: &Vec<String>| r.iter().any(|f| !f.trim().is_empty()));
    rows
}

/// The fields an imported column can go to. `company` names a company to link
/// (made if missing); `custom` keeps the column under its header in `fields`.
pub const IMPORT_FIELDS: &[&str] = &[
    "name", "company", "domain", "category", "email", "phone", "title", "owner", "stage", "value", "closeDate", "renewalDate",
    "probability", "notes", "custom", "skip",
];

/// A guess at the field a column header means, for `kind`.
pub fn guess_field(kind: Kind, header: &str) -> &'static str {
    let h: String = header.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    let any = |words: &[&str]| words.iter().any(|w| h == *w);
    let has = |words: &[&str]| words.iter().any(|w| h.contains(w));
    match () {
        _ if any(&["company", "companyname", "account", "accountname", "organization", "organisation", "org"]) => {
            if kind == Kind::Company { "name" } else { "company" }
        }
        _ if any(&["name", "fullname", "contactname", "deal", "dealname", "opportunity", "opportunityname"]) => "name",
        // First and last name in two columns are joined.
        _ if has(&["firstname", "lastname", "givenname", "surname"]) && kind == Kind::Contact => "name",
        _ if has(&["email", "mail"]) => "email",
        _ if has(&["phone", "mobile", "tel"]) => "phone",
        _ if has(&["domain", "website", "url", "site"]) => "domain",
        _ if any(&["title", "jobtitle", "role", "position"]) => "title",
        _ if has(&["industry", "category", "sector", "segment", "type"]) => "category",
        _ if has(&["owner", "rep", "assignee", "accountmanager"]) => "owner",
        _ if has(&["stage", "status", "pipeline"]) => "stage",
        _ if has(&["renewal"]) => "renewalDate",
        _ if has(&["closedate", "close", "expectedclose"]) => "closeDate",
        _ if has(&["probability", "likelihood", "chance"]) => "probability",
        _ if has(&["value", "amount", "arr", "mrr", "revenue", "dealsize", "price"]) => "value",
        _ if has(&["note", "description", "comment"]) => "notes",
        _ => "custom",
    }
}

/// `$12,500`, `12.5k`, `€1.2M`, `(300)` → a number.
pub fn parse_value(s: &str) -> Option<f64> {
    let s = s.trim().to_lowercase();
    let negative = s.starts_with('(') && s.ends_with(')') || s.starts_with('-');
    let mult = match s.trim_end_matches(')').chars().last() {
        Some('k') => 1e3,
        Some('m') => 1e6,
        Some('b') => 1e9,
        _ => 1.0,
    };
    let digits: String = s.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let n: f64 = digits.parse().ok()?;
    Some(if negative { -n * mult } else { n * mult })
}

/// `2026-03-01`, `2026/3/1`, `3/1/2026` (month first, unless the first part is over 12) → `2026-03-01`.
pub fn parse_date(s: &str) -> Option<String> {
    let s = s.trim();
    let s = s.split(['T', ' ']).next().unwrap_or(s);
    let parts: Vec<u32> = s.split(['-', '/', '.']).map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [a, b, c] = parts[..] else { return None };
    let (y, m, d) = if a > 999 {
        (a, b, c)
    } else if c > 999 {
        if a > 12 { (c, b, a) } else { (c, a, b) }
    } else {
        return None;
    };
    let out = format!("{y:04}-{m:02}-{d:02}");
    is_iso_date(&out).then_some(out)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    /// Companies made for contacts or deals that named one we didn't have.
    pub companies_created: usize,
}

// --- store ------------------------------------------------------------------------------

pub(crate) const MIGRATION: &str = r#"
    -- `data` is the whole `Record` as JSON.
    CREATE TABLE crm_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        company_id TEXT,
        contact_id TEXT,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX crm_records_company ON crm_records (company_id);
    CREATE INDEX crm_records_contact ON crm_records (contact_id);
    CREATE TABLE crm_activities (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX crm_activities_record ON crm_activities (record_id, at);
    CREATE TABLE crm_views (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    -- Settings and the like, one JSON value per key.
    CREATE TABLE crm_meta (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
    );
    -- A record's own text and its activities'.
    CREATE VIRTUAL TABLE crm_fts USING fts5(
        record_id UNINDEXED, kind UNINDEXED, name, body, tokenize = 'porter unicode61'
    );
"#;

const SETTINGS_KEY: &str = "settings";

fn invalid(msg: impl Into<String>) -> StoreError {
    StoreError::Invalid(msg.into())
}

fn get_record(conn: &Connection, id: &str) -> StoreResult<Option<Record>> {
    let data: Option<String> = conn.query_row("SELECT data FROM crm_records WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
}

fn write_record(conn: &Connection, r: &Record) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO crm_records (id, kind, company_id, contact_id, updated_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET company_id = ?3, contact_id = ?4, updated_at = ?5, data = ?6",
        params![r.id, r.kind.as_str(), r.company_id, r.contact_id, r.updated_at, serde_json::to_string(r)?],
    )?;
    reindex(conn, r)
}

fn reindex(conn: &Connection, r: &Record) -> StoreResult<()> {
    conn.execute("DELETE FROM crm_fts WHERE record_id = ?1", [&r.id])?;
    let mut body = r.search_text();
    for a in activities_of(conn, &r.id)? {
        body.push('\n');
        body.push_str(&a.body);
    }
    conn.execute("INSERT INTO crm_fts (record_id, kind, name, body) VALUES (?1, ?2, ?3, ?4)", params![r.id, r.kind.as_str(), r.name, body])?;
    Ok(())
}

fn activities_of(conn: &Connection, record_id: &str) -> StoreResult<Vec<Activity>> {
    let mut stmt = conn.prepare("SELECT data FROM crm_activities WHERE record_id = ?1 ORDER BY at DESC, id")?;
    let rows = stmt.query_map([record_id], |r| r.get::<_, String>(0))?;
    rows.map(|d| Ok(serde_json::from_str(&d?)?)).collect()
}

fn insert_activity(conn: &Connection, a: &Activity) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO crm_activities (id, record_id, at, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET data = ?4",
        params![a.id, a.record_id, a.at, serde_json::to_string(a)?],
    )?;
    Ok(())
}

fn settings_of(conn: &Connection) -> StoreResult<CrmSettings> {
    let data: Option<String> = conn.query_row("SELECT data FROM crm_meta WHERE key = ?1", [SETTINGS_KEY], |r| r.get(0)).optional()?;
    // Damaged or from a later version: the defaults.
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or_default())
}

fn write_settings(conn: &Connection, s: &CrmSettings) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO crm_meta (key, data) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET data = ?2",
        params![SETTINGS_KEY, serde_json::to_string(s)?],
    )?;
    Ok(())
}

/// Check a record's links and stage, and save it with its stage-change activity.
fn save_in(conn: &Connection, mut record: Record, now: i64) -> StoreResult<Saved> {
    record.tidy().map_err(StoreError::Invalid)?;
    if record.id.is_empty() {
        record.id = new_id();
    }
    let old = get_record(conn, &record.id)?;
    match &old {
        Some(o) if o.kind != record.kind => return Err(invalid("A record can't change what kind it is.")),
        Some(o) => record.created_at = o.created_at,
        None => record.created_at = if record.created_at > 0 { record.created_at } else { now },
    }
    if record.kind == Kind::Company {
        record.company_id = None;
    }
    if record.kind == Kind::Contact {
        record.contact_id = None;
    }
    if let Some(cid) = &record.company_id {
        match get_record(conn, cid)? {
            Some(c) if c.kind == Kind::Company => {}
            _ => return Err(invalid("That company no longer exists.")),
        }
    }
    if let Some(pid) = &record.contact_id {
        match get_record(conn, pid)? {
            Some(c) if c.kind == Kind::Contact => {}
            _ => return Err(invalid("That contact no longer exists.")),
        }
    }
    let settings = settings_of(conn)?;
    if record.kind == Kind::Contact {
        record.stage = None;
    } else if let Some(stage) = &record.stage {
        if !settings.stages(record.kind).iter().any(|s| &s.id == stage) {
            return Err(invalid(format!("There's no stage “{stage}”.")));
        }
    }
    record.updated_at = now;
    let event = event(old.as_ref(), &record);
    if event.is_none() {
        // Nothing changed: keep the stored copy and its time.
        return Ok(Saved { record: old.unwrap_or(record), event: None });
    }
    write_record(conn, &record)?;
    if let Some(CrmEvent::StageChanged { from, to, .. }) = &event {
        let body = format!(
            "Stage: {} → {}",
            settings.stage_name(record.kind, from.as_deref()),
            settings.stage_name(record.kind, to.as_deref())
        );
        let a = Activity { id: new_id(), record_id: record.id.clone(), kind: ActivityKind::Change, body, at: now, thread_id: None };
        insert_activity(conn, &a)?;
        reindex(conn, &record)?;
    }
    Ok(Saved { record, event })
}

impl Store {
    /// Every company, contact and deal.
    pub fn crm_records(&self) -> StoreResult<Vec<Record>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM crm_records ORDER BY updated_at DESC, id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|d| Ok(serde_json::from_str(&d?)?)).collect()
    }

    pub fn crm_record(&self, id: &str) -> StoreResult<Option<Record>> {
        get_record(&self.conn.lock().unwrap(), id)
    }

    /// Add or update a record (an empty id adds one). A stage change is logged as an activity.
    pub fn crm_save(&self, record: Record, now: i64) -> StoreResult<Saved> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let saved = save_in(&tx, record, now)?;
        tx.commit()?;
        Ok(saved)
    }

    /// Save several records at once; all or none.
    pub fn crm_save_many(&self, records: Vec<Record>, now: i64) -> StoreResult<Vec<Saved>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let saved = records.into_iter().map(|r| save_in(&tx, r, now)).collect::<StoreResult<Vec<_>>>()?;
        tx.commit()?;
        Ok(saved)
    }

    /// Delete a record and its activities. Records linking to it are unlinked, not deleted.
    pub fn crm_delete(&self, id: &str, now: i64) -> StoreResult<(Removed, Vec<Record>)> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let record = get_record(&tx, id)?.ok_or_else(|| invalid("That record no longer exists."))?;
        let activities = activities_of(&tx, id)?;
        let linked: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM crm_records WHERE company_id = ?1 OR contact_id = ?1")?;
            let ids = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            ids
        };
        let mut changed = Vec::new();
        for lid in &linked {
            if let Some(mut r) = get_record(&tx, lid)? {
                if r.company_id.as_deref() == Some(id) {
                    r.company_id = None;
                }
                if r.contact_id.as_deref() == Some(id) {
                    r.contact_id = None;
                }
                r.updated_at = now;
                write_record(&tx, &r)?;
                changed.push(r);
            }
        }
        tx.execute("DELETE FROM crm_activities WHERE record_id = ?1", [id])?;
        tx.execute("DELETE FROM crm_fts WHERE record_id = ?1", [id])?;
        tx.execute("DELETE FROM crm_records WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok((Removed { record, activities, unlinked: linked }, changed))
    }

    /// Put a deleted record back, with its activities and links. Returns every record it touched.
    pub fn crm_restore(&self, removed: &Removed, now: i64) -> StoreResult<Vec<Record>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut record = removed.record.clone();
        // Its own links may be gone by now.
        if record.company_id.as_deref().is_some_and(|c| get_record(&tx, c).ok().flatten().is_none()) {
            record.company_id = None;
        }
        if record.contact_id.as_deref().is_some_and(|c| get_record(&tx, c).ok().flatten().is_none()) {
            record.contact_id = None;
        }
        write_record(&tx, &record)?;
        for a in &removed.activities {
            insert_activity(&tx, a)?;
        }
        reindex(&tx, &record)?;
        let mut touched = vec![record.clone()];
        for lid in &removed.unlinked {
            let Some(mut r) = get_record(&tx, lid)? else { continue };
            match record.kind {
                Kind::Company if r.company_id.is_none() && r.kind != Kind::Company => r.company_id = Some(record.id.clone()),
                Kind::Contact if r.contact_id.is_none() && r.kind != Kind::Contact => r.contact_id = Some(record.id.clone()),
                _ => continue,
            }
            r.updated_at = now;
            write_record(&tx, &r)?;
            touched.push(r);
        }
        tx.commit()?;
        Ok(touched)
    }

    /// A record's activities, newest first.
    pub fn crm_activities(&self, record_id: &str) -> StoreResult<Vec<Activity>> {
        activities_of(&self.conn.lock().unwrap(), record_id)
    }

    /// Log an activity on a record (an empty id adds one).
    pub fn crm_add_activity(&self, mut activity: Activity) -> StoreResult<Activity> {
        activity.body = activity.body.trim().to_string();
        if activity.body.is_empty() {
            return Err(invalid("Write something first."));
        }
        if activity.id.is_empty() {
            activity.id = new_id();
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let record = get_record(&tx, &activity.record_id)?.ok_or_else(|| invalid("That record no longer exists."))?;
        insert_activity(&tx, &activity)?;
        reindex(&tx, &record)?;
        tx.commit()?;
        Ok(activity)
    }

    /// Delete an activity; returns the record it was on.
    pub fn crm_delete_activity(&self, id: &str) -> StoreResult<Option<String>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let record_id: Option<String> =
            tx.query_row("SELECT record_id FROM crm_activities WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        tx.execute("DELETE FROM crm_activities WHERE id = ?1", [id])?;
        if let Some(record) = record_id.as_deref().map(|r| get_record(&tx, r)).transpose()?.flatten() {
            reindex(&tx, &record)?;
        }
        tx.commit()?;
        Ok(record_id)
    }

    pub fn crm_views(&self) -> StoreResult<Vec<View>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM crm_views ORDER BY created_at, id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        // A view this version can't read is skipped, not fatal.
        Ok(rows.filter_map(|d| d.ok().and_then(|d| serde_json::from_str(&d).ok())).collect())
    }

    /// Add or update a saved view (an empty id adds one).
    pub fn crm_save_view(&self, mut view: View, now: i64) -> StoreResult<View> {
        view.name = view.name.trim().to_string();
        if view.name.is_empty() {
            return Err(invalid("Give the view a name."));
        }
        if view.id.is_empty() {
            view.id = new_id();
            view.created_at = now;
        }
        self.conn.lock().unwrap().execute(
            "INSERT INTO crm_views (id, created_at, data) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO UPDATE SET data = ?3",
            params![view.id, view.created_at, serde_json::to_string(&view)?],
        )?;
        Ok(view)
    }

    pub fn crm_delete_view(&self, id: &str) -> StoreResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM crm_views WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn crm_settings(&self) -> StoreResult<CrmSettings> {
        settings_of(&self.conn.lock().unwrap())
    }

    /// Replace the settings. Records on a stage that's gone lose their stage;
    /// returns the records that changed.
    pub fn crm_save_settings(&self, settings: &CrmSettings, now: i64) -> StoreResult<Vec<Record>> {
        settings.check().map_err(StoreError::Invalid)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut changed = Vec::new();
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM crm_records WHERE kind != 'contact'")?;
            let ids = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            ids
        };
        for id in ids {
            let Some(mut r) = get_record(&tx, &id)? else { continue };
            if r.stage.as_ref().is_some_and(|s| !settings.stages(r.kind).iter().any(|x| &x.id == s)) {
                r.stage = None;
                r.updated_at = now;
                write_record(&tx, &r)?;
                changed.push(r);
            }
        }
        write_settings(&tx, settings)?;
        tx.commit()?;
        Ok(changed)
    }

    /// Records matching `query` best first (BM25 over each record and its activities).
    pub fn crm_search(&self, query: &str, kind: Option<Kind>, limit: usize) -> StoreResult<Vec<Record>> {
        let terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric() && c != '@' && c != '.')
            .map(|t| t.trim_matches('.'))
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"*", t.replace('"', "")))
            .collect();
        if terms.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT r.data FROM crm_fts f JOIN crm_records r ON r.id = f.record_id
             WHERE crm_fts MATCH ?1 AND (?2 IS NULL OR f.kind = ?2)
             ORDER BY bm25(crm_fts, 0.0, 0.0, 4.0, 1.0) LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![terms.join(" "), kind.map(Kind::as_str), limit as i64], |r| r.get::<_, String>(0))?;
        rows.map(|d| Ok(serde_json::from_str(&d?)?)).collect()
    }

    /// Import rows as `kind` records. `mapping[i]` is the field (from
    /// [`IMPORT_FIELDS`]) for column `i`, named `headers[i]`. Rows matching a
    /// record we have (a company by domain or name, a contact by email or
    /// name, a deal by name and company) update it; the rest are added.
    /// Returns what happened and every record it touched.
    pub fn crm_import(
        &self,
        kind: Kind,
        headers: &[String],
        mapping: &[String],
        rows: &[Vec<String>],
        now: i64,
    ) -> StoreResult<(ImportResult, Vec<Record>)> {
        if !mapping.iter().any(|m| m == "name") {
            return Err(invalid("Pick the column that holds each row's name."));
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut settings = settings_of(&tx)?;
        let mut all: Vec<Record> = {
            let mut stmt = tx.prepare("SELECT data FROM crm_records")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|d| Ok(serde_json::from_str(&d?)?)).collect::<StoreResult<_>>()?
        };
        let mut result = ImportResult::default();
        let mut touched: HashMap<String, Record> = HashMap::new();
        for row in rows {
            let cell = |i: usize| row.get(i).map(|s| s.trim()).unwrap_or("");
            let mut draft = Record::new(kind, "");
            let mut company_name = None;
            let stages_before = settings.stages(kind).len();
            for (i, field) in mapping.iter().enumerate() {
                let v = cell(i);
                if v.is_empty() {
                    continue;
                }
                let s = Some(v.to_string());
                match field.as_str() {
                    "name" => {
                        if draft.name.is_empty() {
                            draft.name = v.to_string();
                        } else {
                            // First and last name in two columns.
                            draft.name = format!("{} {v}", draft.name);
                        }
                    }
                    "company" => company_name = s,
                    "domain" => draft.domain = s,
                    "category" => draft.category = s,
                    "email" => draft.email = s,
                    "phone" => draft.phone = s,
                    "title" => draft.title = s,
                    "owner" => draft.owner = s,
                    "stage" => draft.stage = settings.stage_for(kind, v),
                    "value" => draft.value = parse_value(v),
                    "closeDate" => draft.close_date = parse_date(v),
                    "renewalDate" => draft.renewal_date = parse_date(v),
                    "probability" => draft.probability = parse_value(v).map(|p| p.clamp(0.0, 100.0) as u8),
                    "notes" => draft.notes = v.to_string(),
                    "custom" => {
                        if let Some(h) = headers.get(i) {
                            draft.fields.insert(h.trim().to_string(), v.to_string());
                        }
                    }
                    _ => {}
                }
            }
            if draft.name.trim().is_empty() {
                result.skipped += 1;
                continue;
            }
            // `save_in` checks the stage against the stored settings, so a
            // stage this row added has to be stored before the record is.
            if settings.stages(kind).len() != stages_before {
                write_settings(&tx, &settings)?;
            }
            if let (Some(name), true) = (&company_name, kind != Kind::Company) {
                let lower = name.to_lowercase();
                let found = all.iter().find(|r| r.kind == Kind::Company && r.name.to_lowercase() == lower).map(|r| r.id.clone());
                let id = match found {
                    Some(id) => id,
                    None => {
                        let saved = save_in(&tx, Record::new(Kind::Company, name.clone()), now)?;
                        result.companies_created += 1;
                        all.push(saved.record.clone());
                        touched.insert(saved.record.id.clone(), saved.record.clone());
                        saved.record.id
                    }
                };
                draft.company_id = Some(id);
            }
            let existing = all.iter().position(|r| same_record(r, &draft));
            let record = match existing {
                Some(i) => {
                    let mut r = all[i].clone();
                    merge_into(&mut r, draft);
                    r
                }
                None => draft,
            };
            match save_in(&tx, record, now) {
                Ok(saved) => {
                    if existing.is_some() {
                        result.updated += 1;
                    } else {
                        result.created += 1;
                    }
                    match existing {
                        Some(i) => all[i] = saved.record.clone(),
                        None => all.push(saved.record.clone()),
                    }
                    touched.insert(saved.record.id.clone(), saved.record);
                }
                // A row with a bad date and the like: skip it, keep the rest.
                Err(StoreError::Invalid(_)) => result.skipped += 1,
                Err(e) => return Err(e),
            }
        }
        write_settings(&tx, &settings)?;
        tx.commit()?;
        Ok((result, touched.into_values().collect()))
    }
}

/// Does an imported row describe this record?
fn same_record(r: &Record, draft: &Record) -> bool {
    if r.kind != draft.kind {
        return false;
    }
    let eq = |a: &Option<String>, b: &Option<String>| matches!((a, b), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b));
    let name = r.name.trim().eq_ignore_ascii_case(draft.name.trim());
    match r.kind {
        Kind::Company => eq(&r.domain.as_deref().map(clean_domain), &draft.domain.as_deref().map(clean_domain)) || name,
        Kind::Contact => eq(&r.email, &draft.email) || (name && (draft.email.is_none() || r.email.is_none())),
        Kind::Deal => name && r.company_id == draft.company_id,
    }
}

/// Fill a record from an imported row: the row's non-empty cells win.
fn merge_into(r: &mut Record, d: Record) {
    macro_rules! take {
        ($($f:ident),*) => { $( if d.$f.is_some() { r.$f = d.$f; } )* };
    }
    take!(company_id, domain, category, email, phone, title, owner, stage, value, close_date, renewal_date, probability);
    if !d.notes.is_empty() {
        r.notes = d.notes;
    }
    r.fields.extend(d.fields);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn company(store: &Store, name: &str) -> Record {
        let mut r = Record::new(Kind::Company, name);
        r.domain = Some(format!("https://www.{}.com/", name.to_lowercase()));
        store.crm_save(r, 1).unwrap().record
    }

    #[test]
    fn saving_tidies_and_round_trips() {
        let (_d, store) = store();
        let c = company(&store, "Northwind");
        assert!(!c.id.is_empty());
        assert_eq!(c.domain.as_deref(), Some("northwind.com"));
        assert_eq!(store.crm_record(&c.id).unwrap().unwrap(), c);
        assert_eq!(store.crm_records().unwrap().len(), 1);
        let err = store.crm_save(Record::new(Kind::Deal, "  "), 2).unwrap_err();
        assert!(err.to_string().contains("name"));
        let mut bad = Record::new(Kind::Deal, "Pilot");
        bad.close_date = Some("next week".into());
        assert!(store.crm_save(bad, 2).is_err());
    }

    #[test]
    fn links_must_exist_and_kind_is_fixed() {
        let (_d, store) = store();
        let c = company(&store, "Northwind");
        let mut deal = Record::new(Kind::Deal, "Pilot");
        deal.company_id = Some("missing".into());
        assert!(store.crm_save(deal.clone(), 2).is_err());
        deal.company_id = Some(c.id.clone());
        let deal = store.crm_save(deal, 2).unwrap().record;
        let mut changed = deal.clone();
        changed.kind = Kind::Contact;
        assert!(store.crm_save(changed, 3).is_err());
    }

    #[test]
    fn events_and_stage_change_activity() {
        let (_d, store) = store();
        let mut deal = Record::new(Kind::Deal, "Pilot");
        deal.stage = Some("discovery".into());
        let saved = store.crm_save(deal, 1).unwrap();
        assert!(matches!(saved.event, Some(CrmEvent::Created { .. })));
        let same = store.crm_save(saved.record.clone(), 2).unwrap();
        assert!(same.event.is_none());
        assert_eq!(same.record.updated_at, 1);
        let mut moved = saved.record.clone();
        moved.stage = Some("proposal".into());
        moved.value = Some(5000.0);
        let saved = store.crm_save(moved, 3).unwrap();
        match saved.event {
            Some(CrmEvent::StageChanged { from, to, changed, .. }) => {
                assert_eq!((from.as_deref(), to.as_deref()), (Some("discovery"), Some("proposal")));
                assert_eq!(changed, vec!["stage".to_string(), "value".to_string()]);
            }
            e => panic!("{e:?}"),
        }
        let log = store.crm_activities(&saved.record.id).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].body, "Stage: Discovery → Proposal");
        let mut unknown = saved.record;
        unknown.stage = Some("nope".into());
        assert!(store.crm_save(unknown, 4).is_err());
    }

    #[test]
    fn delete_unlinks_and_restore_relinks() {
        let (_d, store) = store();
        let c = company(&store, "Northwind");
        let mut contact = Record::new(Kind::Contact, "Ravi");
        contact.company_id = Some(c.id.clone());
        let contact = store.crm_save(contact, 2).unwrap().record;
        store
            .crm_add_activity(Activity { id: String::new(), record_id: c.id.clone(), kind: ActivityKind::Note, body: "Met at expo".into(), at: 3, thread_id: None })
            .unwrap();
        let (removed, changed) = store.crm_delete(&c.id, 4).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(store.crm_record(&contact.id).unwrap().unwrap().company_id, None);
        assert!(store.crm_record(&c.id).unwrap().is_none());
        let touched = store.crm_restore(&removed, 5).unwrap();
        assert_eq!(touched.len(), 2);
        assert_eq!(store.crm_record(&contact.id).unwrap().unwrap().company_id, Some(c.id.clone()));
        assert_eq!(store.crm_activities(&c.id).unwrap().len(), 1);
    }

    #[test]
    fn search_finds_records_and_activities() {
        let (_d, store) = store();
        let c = company(&store, "Northwind");
        company(&store, "Contoso");
        store
            .crm_add_activity(Activity { id: String::new(), record_id: c.id.clone(), kind: ActivityKind::Call, body: "Asked about invoicing".into(), at: 2, thread_id: None })
            .unwrap();
        assert_eq!(store.crm_search("north", None, 10).unwrap()[0].id, c.id);
        assert_eq!(store.crm_search("invoice", None, 10).unwrap()[0].id, c.id);
        assert!(store.crm_search("invoice", Some(Kind::Deal), 10).unwrap().is_empty());
        assert!(store.crm_search("  \"  ", None, 10).unwrap().is_empty());
    }

    #[test]
    fn settings_drop_missing_stages() {
        let (_d, store) = store();
        let mut deal = Record::new(Kind::Deal, "Pilot");
        deal.stage = Some("proposal".into());
        store.crm_save(deal, 1).unwrap();
        let mut s = store.crm_settings().unwrap();
        s.deal_stages.retain(|x| x.id != "proposal");
        let changed = store.crm_save_settings(&s, 2).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].stage, None);
        s.deal_stages.clear();
        assert!(store.crm_save_settings(&s, 3).is_err());
    }

    #[test]
    fn csv_parses_quotes_and_delimiters() {
        let rows = parse_csv("\u{feff}Name,Notes\r\n\"Acme, Inc\",\"said \"\"hi\"\"\nthen left\"\r\n\r\nBeta,\n");
        assert_eq!(rows, vec![vec!["Name", "Notes"], vec!["Acme, Inc", "said \"hi\"\nthen left"], vec!["Beta", ""]]);
        assert_eq!(parse_csv("a;b\n1;2")[1], vec!["1", "2"]);
    }

    #[test]
    fn values_dates_and_guesses() {
        assert_eq!(parse_value("$12,500"), Some(12500.0));
        assert_eq!(parse_value("12.5k"), Some(12500.0));
        assert_eq!(parse_value("€1.2M"), Some(1_200_000.0));
        assert_eq!(parse_value("n/a"), None);
        assert_eq!(parse_date("2026-3-1").as_deref(), Some("2026-03-01"));
        assert_eq!(parse_date("3/1/2026").as_deref(), Some("2026-03-01"));
        assert_eq!(parse_date("25/12/2026").as_deref(), Some("2026-12-25"));
        assert_eq!(parse_date("soon"), None);
        assert_eq!(guess_field(Kind::Company, "Company Name"), "name");
        assert_eq!(guess_field(Kind::Contact, "Company"), "company");
        assert_eq!(guess_field(Kind::Contact, "E-mail"), "email");
        assert_eq!(guess_field(Kind::Deal, "Amount"), "value");
        assert_eq!(guess_field(Kind::Deal, "Renewal date"), "renewalDate");
        assert_eq!(guess_field(Kind::Company, "Employees"), "custom");
    }

    #[test]
    fn import_links_companies_adds_stages_and_updates() {
        let (_d, store) = store();
        let headers: Vec<String> = ["Deal", "Account", "Amount", "Stage", "Region"].map(String::from).to_vec();
        let mapping: Vec<String> = ["name", "company", "value", "stage", "custom"].map(String::from).to_vec();
        let rows = vec![
            ["Pilot", "Northwind", "$5k", "Proposal", "EU"].map(String::from).to_vec(),
            ["Expansion", "Northwind", "20000", "Verbal yes", ""].map(String::from).to_vec(),
            ["", "Nobody", "1", "", ""].map(String::from).to_vec(),
        ];
        let (res, touched) = store.crm_import(Kind::Deal, &headers, &mapping, &rows, 1).unwrap();
        assert_eq!(res, ImportResult { created: 2, updated: 0, skipped: 1, companies_created: 1 });
        assert_eq!(touched.len(), 3);
        let settings = store.crm_settings().unwrap();
        assert!(settings.deal_stages.iter().any(|s| s.name == "Verbal yes"));
        let pilot = store.crm_records().unwrap().into_iter().find(|r| r.name == "Pilot").unwrap();
        assert_eq!(pilot.value, Some(5000.0));
        assert_eq!(pilot.fields.get("Region").map(String::as_str), Some("EU"));
        // Again, with a new amount: same deal, updated.
        let rows = vec![["Pilot", "northwind", "7000", "", ""].map(String::from).to_vec()];
        let (res, _) = store.crm_import(Kind::Deal, &headers, &mapping, &rows, 2).unwrap();
        assert_eq!((res.created, res.updated, res.companies_created), (0, 1, 0));
        let pilot = store.crm_record(&pilot.id).unwrap().unwrap();
        assert_eq!(pilot.value, Some(7000.0));
        assert_eq!(pilot.stage.as_deref(), Some("proposal"));
        assert!(store.crm_import(Kind::Deal, &headers, &["skip".to_string()], &rows, 3).is_err());
    }
}
