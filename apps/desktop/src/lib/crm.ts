// The CRM: companies, contacts and deals kept in `sush.db` (`crm.rs`,
// `sush_core::crm`). Rust sends every change to every window as a `crm-*`
// frame, so nothing here is broadcast; this module keeps an in-memory copy,
// read once when the page first opens, and applies the frames to it.
//
// Views (a table plus search, filters, sort and hidden columns) are applied
// here; Rust only stores the saved ones.

import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { createStore } from "@/lib/store";
import {
  api,
  errorMessage,
  type CrmActivity,
  type CrmActivityKind,
  type CrmEvent,
  type CrmFilter,
  type CrmKind,
  type CrmRecord,
  type CrmRemoved,
  type CrmSettings,
  type CrmStage,
  type CrmTab,
  type CrmView,
} from "@/lib/tauri";

export interface CrmData {
  loaded: boolean;
  records: CrmRecord[];
  views: CrmView[];
  settings: CrmSettings;
}

const DEFAULT_SETTINGS: CrmSettings = { companyStages: [], dealStages: [], currency: "USD" };

const data = createStore<CrmData>("sush.crm", { loaded: false, records: [], views: [], settings: DEFAULT_SETTINGS }, false);
const activities = createStore<Record<string, CrmActivity[]>>("sush.crm-activities", {}, false);

export const useCrm = () => useSyncExternalStore(data.subscribe, data.get);
export const getCrm = () => data.get();

let loading: Promise<void> | null = null;

/** Read the CRM from Rust once; later changes arrive as frames. */
export function loadCrm(): Promise<void> {
  if (data.get().loaded) return Promise.resolve();
  loading ??= api
    .crmLoad()
    .then((loaded) => {
      data.set((cur) => {
        // A frame that came in while this was loading may be newer than what was read.
        const byId = new Map(loaded.records.map((r) => [r.id, r]));
        for (const r of cur.records) {
          const had = byId.get(r.id);
          if (!had || had.updatedAt < r.updatedAt) byId.set(r.id, r);
        }
        return { loaded: true, records: [...byId.values()], views: loaded.views, settings: loaded.settings };
      });
    })
    .catch((e) => {
      loading = null;
      toast.error("Couldn’t open the CRM", { description: errorMessage(e) });
    });
  return loading;
}

// --- frames (`sessions.ts`) -----------------------------------------------------------

export function applyCrmRecords(records: CrmRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]));
  data.set((cur) => {
    const kept = cur.records.map((r) => byId.get(r.id) ?? r);
    const added = records.filter((r) => !cur.records.some((x) => x.id === r.id));
    return { ...cur, records: [...added, ...kept] };
  });
}

export function applyCrmGone(ids: string[]) {
  const gone = new Set(ids);
  data.set((cur) => ({ ...cur, records: cur.records.filter((r) => !gone.has(r.id)) }));
  activities.set((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !gone.has(id))));
}

export const applyCrmActivities = (recordId: string, list: CrmActivity[]) => activities.set((cur) => ({ ...cur, [recordId]: list }));
export const applyCrmViews = (views: CrmView[]) => data.set((cur) => ({ ...cur, views }));
export const applyCrmSettings = (settings: CrmSettings) => data.set((cur) => ({ ...cur, settings }));

// --- lookups -----------------------------------------------------------------------------

export const recordById = (id: string | undefined) => (id ? data.get().records.find((r) => r.id === id) : undefined);

export function stagesFor(settings: CrmSettings, kind: CrmKind): CrmStage[] {
  return kind === "company" ? settings.companyStages : kind === "deal" ? settings.dealStages : [];
}

export const stageOf = (settings: CrmSettings, r: CrmRecord) => stagesFor(settings, r.kind).find((s) => s.id === r.stage);

/** The kind of record a tab lists. */
export const kindOf = (tab: CrmTab): CrmKind => (tab === "companies" ? "company" : tab === "contacts" ? "contact" : "deal");

/** A record's activities, read from Rust the first time they're asked for. */
export function useActivities(recordId: string | undefined): CrmActivity[] | undefined {
  const all = useSyncExternalStore(activities.subscribe, activities.get);
  useEffect(() => {
    if (!recordId || activities.get()[recordId]) return;
    api
      .crmActivities(recordId)
      .then((list) => applyCrmActivities(recordId, list))
      .catch(() => {});
  }, [recordId]);
  return recordId ? all[recordId] : undefined;
}

// --- fields ------------------------------------------------------------------------------

/** A column the table can show and views can filter or sort on. */
export interface FieldDef {
  id: string;
  label: string;
  type: "text" | "number" | "money" | "date" | "stage" | "link" | "percent" | "health";
  /** Kinds it applies to. */
  kinds: CrmKind[];
}

export const FIELDS: FieldDef[] = [
  { id: "name", label: "Name", type: "text", kinds: ["company", "contact", "deal"] },
  { id: "company", label: "Company", type: "link", kinds: ["contact", "deal"] },
  { id: "contact", label: "Contact", type: "link", kinds: ["company", "deal"] },
  { id: "stage", label: "Stage", type: "stage", kinds: ["company", "deal"] },
  { id: "value", label: "Value", type: "money", kinds: ["company", "deal"] },
  { id: "health", label: "Health", type: "health", kinds: ["deal"] },
  { id: "probability", label: "Probability", type: "percent", kinds: ["deal"] },
  { id: "closeDate", label: "Close date", type: "date", kinds: ["deal"] },
  { id: "renewalDate", label: "Renewal", type: "date", kinds: ["deal"] },
  { id: "title", label: "Title", type: "text", kinds: ["contact"] },
  { id: "email", label: "Email", type: "text", kinds: ["contact"] },
  { id: "phone", label: "Phone", type: "text", kinds: ["contact"] },
  { id: "domain", label: "Domain", type: "text", kinds: ["company"] },
  { id: "category", label: "Category", type: "text", kinds: ["company"] },
  { id: "owner", label: "Owner", type: "text", kinds: ["company", "contact", "deal"] },
  { id: "updatedAt", label: "Updated", type: "date", kinds: ["company", "contact", "deal"] },
];

/** The built-in fields for a kind, then the imported ones its records carry. */
export function fieldsFor(kind: CrmKind, records: CrmRecord[]): FieldDef[] {
  const custom = new Set<string>();
  for (const r of records) if (r.kind === kind) for (const k of Object.keys(r.fields ?? {})) custom.add(k);
  return [
    ...FIELDS.filter((f) => f.kinds.includes(kind)),
    ...[...custom].sort().map((k): FieldDef => ({ id: `fields.${k}`, label: k, type: "text", kinds: [kind] })),
  ];
}

/** A field's value as shown and searched: names for links and stages. */
export function fieldText(r: CrmRecord, field: string, settings: CrmSettings): string {
  switch (field) {
    case "company":
      return recordById(r.companyId)?.name ?? "";
    case "contact":
      return recordById(r.contactId)?.name ?? "";
    case "stage":
      return stageOf(settings, r)?.name ?? "";
    case "updatedAt":
      return new Date(r.updatedAt).toISOString().slice(0, 10);
    case "health": {
      const h = dealHealth(r, settings);
      return h ? String(h.score) : "";
    }
    default: {
      if (field.startsWith("fields.")) return r.fields?.[field.slice(7)] ?? "";
      const v = (r as unknown as Record<string, unknown>)[field];
      return v == null ? "" : String(v);
    }
  }
}

/** A field's value for sorting: numbers stay numbers, stages sort in pipeline order. */
function sortKey(r: CrmRecord, field: string, settings: CrmSettings): string | number | null {
  if (field === "stage") {
    const i = stagesFor(settings, r.kind).findIndex((s) => s.id === r.stage);
    return i < 0 ? null : i;
  }
  if (field === "health") return dealHealth(r, settings)?.score ?? null;
  if (field === "value" || field === "probability" || field === "updatedAt") return (r[field as keyof CrmRecord] as number | undefined) ?? null;
  const t = fieldText(r, field, settings);
  return t ? t.toLowerCase() : null;
}

function matches(r: CrmRecord, f: CrmFilter, settings: CrmSettings): boolean {
  const text = fieldText(r, f.field, settings);
  const want = f.value.trim().toLowerCase();
  const num = (s: string) => Number(s.replace(/[^0-9.-]/g, ""));
  const def = FIELDS.find((x) => x.id === f.field);
  // Stages are compared by id, so a renamed stage keeps its filters.
  const value = f.field === "stage" ? (r.stage ?? "") : text;
  switch (f.op) {
    case "empty":
      return !value;
    case "not-empty":
      return !!value;
    case "is":
      return f.field === "stage" ? value === f.value : value.toLowerCase() === want;
    case "is-not":
      return f.field === "stage" ? value !== f.value : value.toLowerCase() !== want;
    case "contains":
      return value.toLowerCase().includes(want);
    case "gt":
    case "lt": {
      if (!value || !want) return false;
      const numeric = def && def.type !== "date" && def.type !== "text";
      const c = numeric ? num(value) - num(want) : value.toLowerCase().localeCompare(want);
      return f.op === "gt" ? c > 0 : c < 0;
    }
  }
}

/** What a tab or view starts from, before its own filters. */
export const BUILT_IN_TABS: { tab: CrmTab; label: string }[] = [
  { tab: "companies", label: "Companies" },
  { tab: "contacts", label: "Contacts" },
  { tab: "deals", label: "Deals" },
  { tab: "renewals", label: "Renewals" },
];

/** A built-in tab as an unsaved view. */
export function baseView(tab: CrmTab): CrmView {
  return {
    id: "",
    tab,
    name: BUILT_IN_TABS.find((t) => t.tab === tab)!.label,
    query: "",
    filters: [],
    sort: tab === "renewals" ? { field: "renewalDate", desc: false } : null,
    hidden: [],
    layout: "table",
    createdAt: 0,
  };
}

/** The records a view shows, in its order. */
export function applyView(view: CrmView, records: CrmRecord[], settings: CrmSettings): CrmRecord[] {
  const kind = kindOf(view.tab);
  const q = view.query.trim().toLowerCase();
  const fields = fieldsFor(kind, records);
  let rows = records.filter(
    (r) =>
      r.kind === kind &&
      (view.tab !== "renewals" || !!r.renewalDate) &&
      view.filters.every((f) => matches(r, f, settings)) &&
      (!q || fields.some((f) => fieldText(r, f.id, settings).toLowerCase().includes(q)) || (r.notes ?? "").toLowerCase().includes(q)),
  );
  const sort = view.sort ?? { field: "updatedAt", desc: true };
  rows = [...rows].sort((a, b) => {
    const x = sortKey(a, sort.field, settings);
    const y = sortKey(b, sort.field, settings);
    // Empty values go last whichever way it's sorted.
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.desc ? -c : c;
  });
  return rows;
}

/** Does `view` differ from what it was saved as (or its tab's defaults)? */
export function viewChanged(view: CrmView, saved: CrmView): boolean {
  const pick = (v: CrmView) => JSON.stringify([v.query, v.filters, v.sort, v.hidden, v.layout]);
  return pick(view) !== pick(saved);
}

// --- formatting ----------------------------------------------------------------------------

export function formatMoney(value: number | undefined, currency: string, compact = false): string {
  if (value == null) return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 0,
    }).format(value);
  } catch {
    return value.toLocaleString();
  }
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Days from today to an ISO date (negative when past). */
export function daysUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000);
}

// --- changes -------------------------------------------------------------------------------

export function newRecord(kind: CrmKind, patch: Partial<CrmRecord> = {}): CrmRecord {
  return { id: "", kind, name: "", createdAt: 0, updatedAt: 0, ...patch };
}

/** Save a record; the saved copy, or null if it failed (the reason is toasted). */
export async function saveRecord(record: CrmRecord): Promise<CrmRecord | null> {
  try {
    const saved = await api.crmSave(record);
    applyCrmRecords([saved]);
    return saved;
  } catch (e) {
    toast.error(record.id ? "Couldn’t save that change" : `Couldn’t add the ${record.kind}`, { description: errorMessage(e) });
    return null;
  }
}

/** Change one field of a record. */
export function updateRecord(id: string, patch: Partial<CrmRecord>) {
  const r = recordById(id);
  if (r) return saveRecord({ ...r, ...patch });
}

/** Apply the same change to several records at once. */
export async function updateMany(ids: string[], patch: Partial<CrmRecord>) {
  const records = ids.flatMap((id) => {
    const r = recordById(id);
    return r ? [{ ...r, ...patch }] : [];
  });
  if (records.length === 0) return;
  try {
    applyCrmRecords(await api.crmSaveMany(records));
  } catch (e) {
    toast.error("Couldn’t change those records", { description: errorMessage(e) });
  }
}

/** Delete records, with an Undo in the toast. */
export async function deleteRecords(ids: string[]) {
  if (ids.length === 0) return;
  let removed: CrmRemoved[];
  try {
    removed = await api.crmDelete(ids);
  } catch (e) {
    toast.error("Couldn’t delete that", { description: errorMessage(e) });
    return;
  }
  applyCrmGone(removed.map((r) => r.record.id));
  if (removed.length === 0) return;
  const what = removed.length === 1 ? `“${removed[0].record.name}”` : `${removed.length} records`;
  toast(`Deleted ${what}`, {
    action: {
      label: "Undo",
      onClick: () => {
        api.crmRestore(removed).catch((e) => toast.error("Couldn’t bring it back", { description: errorMessage(e) }));
      },
    },
  });
}

export async function addActivity(recordId: string, kind: CrmActivityKind, body: string): Promise<boolean> {
  try {
    await api.crmActivityAdd(recordId, kind, body);
    return true;
  } catch (e) {
    toast.error("Couldn’t log that", { description: errorMessage(e) });
    return false;
  }
}

export function deleteActivity(id: string) {
  api.crmActivityDelete(id).catch((e) => toast.error("Couldn’t delete that", { description: errorMessage(e) }));
}

export async function saveView(view: CrmView): Promise<CrmView | null> {
  try {
    const saved = await api.crmViewSave(view);
    data.set((cur) => ({ ...cur, views: [...cur.views.filter((v) => v.id !== saved.id), saved].sort((a, b) => a.createdAt - b.createdAt) }));
    return saved;
  } catch (e) {
    toast.error("Couldn’t save the view", { description: errorMessage(e) });
    return null;
  }
}

export function deleteView(id: string) {
  data.set((cur) => ({ ...cur, views: cur.views.filter((v) => v.id !== id) }));
  api.crmViewDelete(id).catch((e) => toast.error("Couldn’t delete the view", { description: errorMessage(e) }));
}

export async function saveSettings(settings: CrmSettings): Promise<boolean> {
  try {
    applyCrmSettings(await api.crmSettingsSave(settings));
    return true;
  } catch (e) {
    toast.error("Couldn’t save the stages", { description: errorMessage(e) });
    return false;
  }
}

export async function addSampleData() {
  try {
    await api.crmSample();
  } catch (e) {
    toast.error("Couldn’t add the sample data", { description: errorMessage(e) });
  }
}

/** Owners already in use, for suggestions. */
export function knownOwners(records: CrmRecord[]): string[] {
  return [...new Set(records.flatMap((r) => (r.owner ? [r.owner] : [])))].sort((a, b) => a.localeCompare(b));
}

// --- page state ------------------------------------------------------------------------------

/** The open tab (a built-in tab's name, or `view:<id>`) and each tab's unsaved changes; this window's only. */
export const crmPage = createStore<{ active: string; drafts: Record<string, CrmView>; ask?: boolean }>(
  "sush.crm.page",
  { active: "companies", drafts: {} },
  true,
  false,
);

/** Open `view` on the CRM page as its tab's unsaved changes, for the user to keep or save. */
export function openCrmDraft(view: CrmView) {
  crmPage.set((s) => ({ ...s, active: view.tab, drafts: { ...s.drafts, [view.tab]: { ...view, id: "", createdAt: 0 } } }));
}

// --- the page's chats ---------------------------------------------------------------------------

/**
 * Threads of the CRM page's "Ask" panel, newest last. They're ordinary
 * threads, kept out of the session list; `sessions.ts` gives their runs the
 * CRM's instructions and tools.
 */
const crmThreads = createStore<string[]>("sush.crm.threads", []);

export const useCrmThreadIds = () => useSyncExternalStore(crmThreads.subscribe, crmThreads.get);
export const isCrmThread = (id: string) => crmThreads.get().includes(id);
export const getCrmThreadIds = () => crmThreads.get();
const threadSets = new WeakMap<string[], ReadonlySet<string>>();
/** The CRM page's threads as a set, for the session list's filter. */
export function useCrmThreads(): ReadonlySet<string> {
  const ids = useCrmThreadIds();
  let set = threadSets.get(ids);
  if (!set) threadSets.set(ids, (set = new Set(ids)));
  return set;
}

export function addCrmThread(id: string) {
  crmThreads.set((ids) => [...ids.filter((x) => x !== id), id].slice(-50));
}

// --- events --------------------------------------------------------------------------------------

const eventListeners = new Set<(event: CrmEvent) => void>();

/** Hear every CRM change made by hand or by Sush (imports aside), in every window; workflows trigger on them. */
export function onCrmEvent(listener: (event: CrmEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** A `crm-event` frame (`sessions.ts`). */
export function applyCrmEvent(event: CrmEvent) {
  for (const l of eventListeners) l(event);
}

// --- deal health -----------------------------------------------------------------------------

export interface Health {
  score: number;
  reasons: string[];
}

const DAY = 86_400_000;

/**
 * How likely an open deal is to close, 0–100, with the reasons: its stage (or
 * probability), how long since anyone touched it (record edits and logged
 * activity), a close date that's passed or near, and a missing contact or
 * value. Closed deals and other records have none.
 */
export function dealHealth(r: CrmRecord, settings: CrmSettings): Health | null {
  if (r.kind !== "deal") return null;
  const stages = settings.dealStages;
  const stage = stages.find((s) => s.id === r.stage);
  if (stage && stage.tone !== "open") return null;
  const reasons: string[] = [];
  const open = stages.filter((s) => s.tone === "open");
  const at = stage ? open.findIndex((s) => s.id === stage.id) : -1;
  let score = r.probability ?? (at < 0 ? 30 : Math.round(25 + (at / Math.max(1, open.length - 1)) * 50));
  reasons.push(r.probability != null ? `${r.probability}% likely` : stage ? `In ${stage.name}` : "No stage yet");
  const logged = activities.get()[r.id]?.find((a) => a.kind !== "change")?.at ?? 0;
  const idle = Math.floor((Date.now() - Math.max(r.updatedAt, logged)) / DAY);
  if (idle > 30) {
    score -= 30;
    reasons.push(`Untouched for ${idle} days`);
  } else if (idle > 14) {
    score -= 15;
    reasons.push(`Quiet for ${idle} days`);
  } else if (idle <= 3) {
    score += 5;
    reasons.push("Active this week");
  }
  if (r.closeDate) {
    const days = daysUntil(r.closeDate);
    if (days < 0) {
      score -= 25;
      reasons.push(`Close date passed ${-days} days ago`);
    } else if (days <= 7 && score < 50) {
      score -= 10;
      reasons.push(`Closes in ${days} days, still early`);
    }
  } else {
    score -= 5;
    reasons.push("No close date");
  }
  if (!r.contactId) {
    score -= 10;
    reasons.push("No main contact");
  }
  if (r.value == null) {
    score -= 5;
    reasons.push("No value");
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}
