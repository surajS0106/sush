# CRM — Design Notes

Last updated: 2026-11-10

## What changed

### 2026-11-10 (later)
- The CRM's currency moved from the Pipeline dialog to Settings → Units → Currency: a searchable dropdown listing each currency with its symbol on a tile, its code and its name. It still lives in the CRM settings, so the table, the AI tools and workflows read one value. Changing it relabels amounts; it doesn't convert them (`components/settings-dialog.tsx`, `CurrencySelect` with `value`/`onChange` in `components/currency-select.tsx`, `currencySign` in `lib/currency.ts`). Symbols use the standard form (US$, CA$, A$), so dollar currencies stay distinct, in the money field too.
- Amounts are typed in a money field (`components/money-input.tsx`): the currency symbol in front, thousands separators in the reader's locale as you type with the cursor kept in place, and "250k" / "1.2m" filled out on Enter or leaving the field. Used for a new deal's value, the Value cell and drawer field, and the Value filter.
- Stage pills mark their kind with a coloured dot (neutral, accent, coral) instead of a check on won stages, so a check in a menu only ever means "selected" (`StagePill` in `components/crm-fields.tsx`).

### 2026-11-10
- Records, activities, saved views, stages and CSV import in `sush.db`: one flat `Record` (company, contact or deal) stored as JSON, an activity log, an FTS5 index over each record and its activities, and the `CrmEvent` each save causes (`crates/sush-core/src/crm.rs`, migration appended in `store.rs`). Inline tests cover saving, links, stage-change logging, delete/restore, search, settings and import.
- Tauri commands (`crm_load`, `crm_save`, `crm_save_many`, `crm_delete`/`crm_restore`, activities, views, settings, `crm_import_pick`/`crm_import`, `crm_sample`, `crm_search`) and `crm-*` run frames, so every window stays in step (`apps/desktop/src-tauri/src/crm.rs`, `runs.rs`).
- The page: tabs for Companies, Contacts, Deals and Renewals plus saved views; search, filters, sort, columns, a table/pipeline toggle, unsaved view drafts per tab; cells edited in place; a pipeline board dragged with pointer events; a record drawer with fields, linked records, notes and the activity log; import, stages, new-record and view-name dialogs (`components/crm-page.tsx`, `crm-table.tsx`, `crm-board.tsx`, `crm-record.tsx`, `crm-fields.tsx`, `crm-dialogs.tsx`, `lib/crm.ts`).
- Model tools `crm_search`, `crm_read`, `crm_write`, `crm_log` (deferred in ordinary chats) and `crm_view_propose` (CRM page only), run in the UI. Writes show a before/after card to apply or discard (`lib/crm-tools.ts`, `components/crm-tool-part.tsx`, `lib/agent.ts`).
- "Ask Sush" panel on the page, and Enrich, Catch up and Next step in the drawer, which send their instructions to that panel's chat (`components/crm-ask.tsx`). `@crm` in any chat offers the tools (`lib/sessions.ts`).
- Deal health: 0 to 100 with its reasons, as a column, filter and drawer row (`dealHealth` in `lib/crm.ts`).
- CRM tool calls are redacted for shared-session guests (`crates/sush-core/src/share/redact.rs`).

## Why

The reference CRM screen is a table over one `companies` list. Keeping one flat record with JSON data matched that, let CSV columns land as custom fields without migrations, and lets Renewals be a view over deals instead of a fourth store. Local storage follows the user's choice: no account and no sync to set up.

Rust owns the data and broadcasts every change, the same way Notebooks do, so the UI never has to broadcast and a second window can't fall behind. Saving returns a `CrmEvent`, so stage moves are logged as activities in one place and workflows trigger on the same events.

The AI features go through ordinary chat runs instead of one-shot calls. That way they stream, use the user's connectors and web search, can be followed up, and every write passes the same approval card. The only exception is Auto permission mode, which the user chose. Proposed changes are planned against the loaded CRM before the card shows, so the card shows real before/after values and refuses unknown stages or ambiguous names.

Deal health is a heuristic rather than a model call: it is free, instant, and its reasons can be checked. A model score would cost a request per deal on every change.

## What makes it stand out

- Undo for deletes restores the record, its activities and the links other records had to it (`crm_restore`), not just the row.
- CSV import guesses each column per kind, can be corrected before running, matches existing records (company by domain or name, contact by email, deal by name and company), creates missing companies and adds unknown stage names as new stages.
- Saved views are full view state (search, filters, sort, hidden columns, layout); edits stay a per-tab draft with Save, Save as new and Reset.
- Model writes are one batched call shown as a per-record diff with checkboxes to drop individual changes; the model is told which ones the user left out.
- Colours follow the user's accent; coral is kept for lost stages, overdue close dates and low health.
