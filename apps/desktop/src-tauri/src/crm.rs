//! The CRM page's commands (`sush_core::crm`): companies, contacts and deals,
//! their activities, saved views, stages and CSV import. Every change reaches
//! every window as a `crm-*` frame, so the UI doesn't broadcast its own.

use serde::{Deserialize, Serialize};
use sush_core::crm::{self, Activity, ActivityKind, CrmEvent, CrmSettings, ImportResult, Kind, Record, Removed, Saved, View};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::runs::RunFrame;
use crate::state::AppState;
use crate::store::blocking;

/// Largest CSV the import reads.
const MAX_CSV: u64 = 20 * 1024 * 1024;
/// Rows one import takes.
const MAX_ROWS: usize = 20_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrmState {
    records: Vec<Record>,
    views: Vec<View>,
    settings: CrmSettings,
}

/// Tell every window these records changed, and re-send the activities of any whose stage moved.
fn announce(state: &AppState, saved: &[Saved]) {
    if saved.is_empty() {
        return;
    }
    state.runs.send(RunFrame::CrmRecords { records: saved.iter().map(|s| s.record.clone()).collect() });
    for s in saved {
        if let Some(event) = &s.event {
            state.runs.send(RunFrame::CrmEvent { event: event.clone() });
        }
        if matches!(s.event, Some(CrmEvent::StageChanged { .. })) {
            if let Ok(activities) = state.store.crm_activities(&s.record.id) {
                state.runs.send(RunFrame::CrmActivities { record_id: s.record.id.clone(), activities });
            }
        }
    }
}

fn announce_records(state: &AppState, records: Vec<Record>) {
    if !records.is_empty() {
        state.runs.send(RunFrame::CrmRecords { records });
    }
}

/// Everything the page shows, read once when it opens.
#[tauri::command]
pub async fn crm_load(state: State<'_, AppState>) -> AppResult<CrmState> {
    let store = state.store.clone();
    blocking(move || Ok(CrmState { records: store.crm_records()?, views: store.crm_views()?, settings: store.crm_settings()? })).await
}

/// Add or update a record (an empty id adds one).
#[tauri::command]
pub async fn crm_save(state: State<'_, AppState>, record: Record) -> AppResult<Record> {
    let store = state.store.clone();
    let saved = blocking(move || Ok(store.crm_save(record, now_ms())?)).await?;
    announce(&state, std::slice::from_ref(&saved));
    Ok(saved.record)
}

/// Save several records at once (a bulk edit); all or none.
#[tauri::command]
pub async fn crm_save_many(state: State<'_, AppState>, records: Vec<Record>) -> AppResult<Vec<Record>> {
    let store = state.store.clone();
    let saved = blocking(move || Ok(store.crm_save_many(records, now_ms())?)).await?;
    announce(&state, &saved);
    Ok(saved.into_iter().map(|s| s.record).collect())
}

/// Delete records. Returns what's needed to undo it (`crm_restore`).
#[tauri::command]
pub async fn crm_delete(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Vec<Removed>> {
    let store = state.store.clone();
    let (removed, changed) = blocking(move || {
        let (mut removed, mut changed) = (Vec::new(), Vec::new());
        for id in ids {
            // Unlinked by an earlier delete in this batch and then deleted itself: skip the stale copy.
            changed.retain(|r: &Record| r.id != id);
            match store.crm_delete(&id, now_ms()) {
                Ok((r, c)) => {
                    removed.push(r);
                    changed.extend(c);
                }
                // Already gone (another window): nothing to do.
                Err(sush_core::store::StoreError::Invalid(_)) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok((removed, changed))
    })
    .await?;
    if !removed.is_empty() {
        state.runs.send(RunFrame::CrmGone { ids: removed.iter().map(|r| r.record.id.clone()).collect() });
        for r in &removed {
            state.runs.send(RunFrame::CrmEvent { event: CrmEvent::Deleted { record: r.record.clone() } });
        }
    }
    announce_records(&state, changed);
    Ok(removed)
}

/// Undo `crm_delete`.
#[tauri::command]
pub async fn crm_restore(state: State<'_, AppState>, removed: Vec<Removed>) -> AppResult<()> {
    let store = state.store.clone();
    let touched = blocking(move || {
        let mut touched = Vec::new();
        for r in &removed {
            touched.extend(store.crm_restore(r, now_ms())?);
        }
        Ok(touched)
    })
    .await?;
    announce_records(&state, touched);
    Ok(())
}

/// Ids of the records matching `query` best first, over their fields and activities (the model's `crm_search`).
#[tauri::command]
pub async fn crm_search(state: State<'_, AppState>, query: String, kind: Option<Kind>, limit: Option<usize>) -> AppResult<Vec<String>> {
    let store = state.store.clone();
    let limit = limit.unwrap_or(50).clamp(1, 200);
    blocking(move || Ok(store.crm_search(&query, kind, limit)?.into_iter().map(|r| r.id).collect())).await
}

/// A record's activities, newest first.
#[tauri::command]
pub async fn crm_activities(state: State<'_, AppState>, record_id: String) -> AppResult<Vec<Activity>> {
    let store = state.store.clone();
    blocking(move || Ok(store.crm_activities(&record_id)?)).await
}

async fn send_activities(state: &AppState, record_id: String) -> AppResult<()> {
    let (store, id) = (state.store.clone(), record_id.clone());
    let activities = blocking(move || Ok(store.crm_activities(&id)?)).await?;
    state.runs.send(RunFrame::CrmActivities { record_id, activities });
    Ok(())
}

#[tauri::command]
pub async fn crm_activity_add(state: State<'_, AppState>, record_id: String, kind: ActivityKind, body: String) -> AppResult<Activity> {
    let store = state.store.clone();
    let activity = Activity { id: String::new(), record_id: record_id.clone(), kind, body, at: now_ms(), thread_id: None };
    let activity = blocking(move || Ok(store.crm_add_activity(activity)?)).await?;
    send_activities(&state, record_id).await?;
    Ok(activity)
}

#[tauri::command]
pub async fn crm_activity_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let store = state.store.clone();
    if let Some(record_id) = blocking(move || Ok(store.crm_delete_activity(&id)?)).await? {
        send_activities(&state, record_id).await?;
    }
    Ok(())
}

async fn send_views(state: &AppState) -> AppResult<()> {
    let store = state.store.clone();
    let views = blocking(move || Ok(store.crm_views()?)).await?;
    state.runs.send(RunFrame::CrmViews { views });
    Ok(())
}

/// Add or update a saved view (an empty id adds one).
#[tauri::command]
pub async fn crm_view_save(state: State<'_, AppState>, view: View) -> AppResult<View> {
    let store = state.store.clone();
    let view = blocking(move || Ok(store.crm_save_view(view, now_ms())?)).await?;
    send_views(&state).await?;
    Ok(view)
}

#[tauri::command]
pub async fn crm_view_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || Ok(store.crm_delete_view(&id)?)).await?;
    send_views(&state).await
}

/// Replace the stages and currency. Records on a removed stage lose it.
#[tauri::command]
pub async fn crm_settings_save(state: State<'_, AppState>, settings: CrmSettings) -> AppResult<CrmSettings> {
    let store = state.store.clone();
    let s = settings.clone();
    let changed = blocking(move || Ok(store.crm_save_settings(&s, now_ms())?)).await?;
    state.runs.send(RunFrame::CrmSettings { settings: settings.clone() });
    announce_records(&state, changed);
    Ok(settings)
}

/// A picked CSV, read for the import dialog, with a guess at each column's field per kind.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvFile {
    name: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    guesses: Guesses,
}

#[derive(Serialize)]
pub struct Guesses {
    company: Vec<&'static str>,
    contact: Vec<&'static str>,
    deal: Vec<&'static str>,
}

/// Ask for a CSV and read it. The dialog opens here so the webview never names a path. `None` if cancelled.
#[tauri::command]
pub async fn crm_import_pick(app: AppHandle) -> AppResult<Option<CsvFile>> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_title("Import a CSV").add_filter("Spreadsheet (CSV)", &["csv", "tsv", "txt"]).blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?;
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| AppError::Invalid(format!("That file can't be used: {e}")))?;
    blocking(move || {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file.csv").to_string();
        if std::fs::metadata(&path)?.len() > MAX_CSV {
            return Err(AppError::Invalid("That file is over 20 MB. Split it and import the parts.".into()));
        }
        let bytes = std::fs::read(&path)?;
        // Spreadsheets often save Latin-1; read what we can rather than refuse it.
        let text = String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        let mut rows = crm::parse_csv(&text);
        if rows.len() < 2 {
            return Err(AppError::Invalid("That file has no rows under its header.".into()));
        }
        let headers: Vec<String> = rows.remove(0).into_iter().map(|h| h.trim().to_string()).collect();
        if rows.len() > MAX_ROWS {
            return Err(AppError::Invalid(format!("That file has {} rows; an import takes up to {MAX_ROWS}.", rows.len())));
        }
        let guess = |kind| headers.iter().map(|h| crm::guess_field(kind, h)).collect();
        let guesses = Guesses { company: guess(Kind::Company), contact: guess(Kind::Contact), deal: guess(Kind::Deal) };
        Ok(Some(CsvFile { name, headers, rows, guesses }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    kind: Kind,
    headers: Vec<String>,
    mapping: Vec<String>,
    rows: Vec<Vec<String>>,
}

/// Import the rows of a picked CSV as `kind` records, with the user's column mapping.
#[tauri::command]
pub async fn crm_import(state: State<'_, AppState>, request: ImportRequest) -> AppResult<ImportResult> {
    if request.rows.len() > MAX_ROWS {
        return Err(AppError::Invalid(format!("An import takes up to {MAX_ROWS} rows.")));
    }
    if let Some(bad) = request.mapping.iter().find(|m| !crm::IMPORT_FIELDS.contains(&m.as_str())) {
        return Err(AppError::Invalid(format!("“{bad}” isn't a field.")));
    }
    let store = state.store.clone();
    let (result, touched, settings) = blocking(move || {
        let (result, touched) = store.crm_import(request.kind, &request.headers, &request.mapping, &request.rows, now_ms())?;
        Ok((result, touched, store.crm_settings()?))
    })
    .await?;
    // An import can add stages it found.
    state.runs.send(RunFrame::CrmSettings { settings });
    announce_records(&state, touched);
    Ok(result)
}

/// Fill an empty CRM with a few made-up companies, contacts and deals to try it with.
#[tauri::command]
pub async fn crm_sample(state: State<'_, AppState>) -> AppResult<()> {
    let store = state.store.clone();
    let records = blocking(move || {
        if !store.crm_records()?.is_empty() {
            return Err(AppError::Invalid("Sample data only goes into an empty CRM.".into()));
        }
        Ok(sample(&store)?)
    })
    .await?;
    announce_records(&state, records);
    Ok(())
}

fn sample(store: &sush_core::store::Store) -> Result<Vec<Record>, sush_core::store::StoreError> {
    let now = now_ms();
    let day = 86_400_000;
    let date = |days: i64| {
        let secs = (now + days * day) / 1000;
        // Civil date from days since the epoch (Howard Hinnant's algorithm).
        let z = secs.div_euclid(86_400) + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!("{y:04}-{m:02}-{d:02}")
    };
    let mut out = Vec::new();
    let companies = [
        ("Lumen Freight", "lumenfreight.example", "Logistics", "customer", 84_000.0),
        ("Juniper Health", "juniperhealth.example", "Healthcare", "qualified", 42_000.0),
        ("Orbit Studio", "orbitstudio.example", "Design", "lead", 12_000.0),
        ("Kestrel Bank", "kestrelbank.example", "Finance", "customer", 150_000.0),
        ("Tidewater Foods", "tidewaterfoods.example", "Retail", "churned", 18_000.0),
        ("Pinecone Labs", "pineconelabs.example", "Software", "qualified", 56_000.0),
    ];
    let mut ids = Vec::new();
    for (i, (name, domain, category, stage, value)) in companies.into_iter().enumerate() {
        let mut r = Record::new(Kind::Company, name);
        r.domain = Some(domain.into());
        r.category = Some(category.into());
        r.stage = Some(stage.into());
        r.value = Some(value);
        r.owner = Some(["Sam", "Priya", "Alex"][i % 3].into());
        let saved = store.crm_save(r, now)?.record;
        ids.push(saved.id.clone());
        out.push(saved);
    }
    let contacts = [
        ("Maya Chen", 0, "Head of Operations"),
        ("Leo Duarte", 1, "CTO"),
        ("Ines Park", 2, "Founder"),
        ("Tomas Reyes", 3, "VP Procurement"),
        ("Hana Ito", 3, "IT Director"),
        ("Owen Blake", 5, "Engineering Manager"),
    ];
    let mut contact_ids = Vec::new();
    for (name, company, title) in contacts {
        let mut r = Record::new(Kind::Contact, name);
        r.company_id = Some(ids[company].clone());
        r.title = Some(title.into());
        let first = name.split(' ').next().unwrap_or(name).to_lowercase();
        r.email = Some(format!("{first}@{}", companies[company].1));
        let saved = store.crm_save(r, now)?.record;
        contact_ids.push((company, saved.id.clone()));
        out.push(saved);
    }
    // Each company's first contact is its main one.
    for (company, contact) in &contact_ids {
        if let Some(c) = out.iter_mut().find(|r| r.id == ids[*company] && r.contact_id.is_none()) {
            c.contact_id = Some(contact.clone());
            *c = store.crm_save(c.clone(), now)?.record;
        }
    }
    let deals: [(&str, usize, &str, f64, i64, Option<i64>); 7] = [
        ("Fleet tracking rollout", 0, "negotiation", 48_000.0, 14, None),
        ("Annual renewal", 0, "won", 36_000.0, -40, Some(45)),
        ("Patient portal pilot", 1, "proposal", 42_000.0, 30, None),
        ("Brand refresh", 2, "discovery", 12_000.0, 60, None),
        ("Core banking support", 3, "won", 150_000.0, -120, Some(20)),
        ("Data platform", 5, "negotiation", 56_000.0, 7, None),
        ("Store analytics", 4, "lost", 18_000.0, -10, None),
    ];
    for (name, company, stage, value, close, renewal) in deals {
        let mut r = Record::new(Kind::Deal, name);
        r.company_id = Some(ids[company].clone());
        r.contact_id = contact_ids.iter().find(|(c, _)| *c == company).map(|(_, id)| id.clone());
        r.stage = Some(stage.into());
        r.value = Some(value);
        r.close_date = Some(date(close));
        r.renewal_date = renewal.map(date);
        r.probability = Some(match stage {
            "won" => 100,
            "lost" => 0,
            "negotiation" => 70,
            "proposal" => 40,
            _ => 15,
        });
        r.owner = out.iter().find(|c| c.id == ids[company]).and_then(|c| c.owner.clone());
        out.push(store.crm_save(r, now)?.record);
    }
    Ok(out)
}
