// The model's CRM tools. They run in the UI (`runTool` in `agent.ts`) against
// the CRM Rust keeps (`lib/crm.ts`):
//
//   crm_search        runs at once: records by words, filters and sort, as compact rows
//   crm_read          runs at once: one record with its links and recent activity
//   crm_write         adds or changes records; asks with a card showing each change
//                     (runs at once in Auto mode), new companies made for names it doesn't know
//   crm_log           logs an activity on a record; asks like crm_write
//   crm_view_propose  only on the CRM page: a view (filters, sort) the user can open and save
//
// All but crm_view_propose are deferred: listed in the system prompt, loaded when needed.

import {
  addActivity,
  applyView,
  baseView,
  FIELDS,
  fieldText,
  formatMoney,
  getCrm,
  loadCrm,
  newRecord,
  recordById,
  saveRecord,
  stageOf,
  stagesFor,
  type CrmData,
} from "@/lib/crm";
import { api, errorMessage, type CrmActivityKind, type CrmFilter, type CrmFilterOp, type CrmKind, type CrmRecord, type CrmTab, type CrmView, type ToolSpec } from "@/lib/tauri";

export const CRM_SEARCH = "crm_search";
export const CRM_READ = "crm_read";
export const CRM_WRITE = "crm_write";
export const CRM_LOG = "crm_log";
export const CRM_VIEW = "crm_view_propose";
export const CRM_TOOL_NAMES = new Set([CRM_SEARCH, CRM_READ, CRM_WRITE, CRM_LOG, CRM_VIEW]);
/** Tools that change the CRM: they ask unless the user picked Auto. */
export const CRM_WRITES = new Set([CRM_WRITE, CRM_LOG]);

const KINDS = ["company", "contact", "deal"];
const OPS: CrmFilterOp[] = ["is", "is-not", "contains", "gt", "lt", "empty", "not-empty"];
const FIELD_IDS = FIELDS.map((f) => f.id);

const filterSchema = {
  type: "array",
  description:
    "Conditions that must all hold. `field` is one of " +
    FIELD_IDS.join(", ") +
    " (or `fields.<Imported column>`); `op` one of " +
    OPS.join(", ") +
    ". Stages by name; dates as YYYY-MM-DD (gt = after, lt = before); money as a plain number.",
  items: {
    type: "object",
    properties: { field: { type: "string" }, op: { type: "string", enum: OPS }, value: { type: "string" } },
    required: ["field", "op"],
  },
};
const sortSchema = {
  type: "object",
  properties: { field: { type: "string" }, desc: { type: "boolean" } },
  required: ["field"],
};

export const crmSearchTool: ToolSpec = {
  name: CRM_SEARCH,
  description:
    "Search the user's CRM in Sush (their companies, contacts and deals; renewals are deals with a renewal date). " +
    "Use it whenever they ask about their customers, pipeline, deals, contacts or renewals. `query` matches words in " +
    "any field and in logged activities; filters narrow it; the result also says today's date and the pipeline stages.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for. Leave out to list by filters alone." },
      kind: { type: "string", enum: KINDS },
      renewals: { type: "boolean", description: "Only deals with a renewal date." },
      filters: filterSchema,
      sort: sortSchema,
      limit: { type: "number", description: "Rows to return, up to 100 (default 25)." },
    },
  },
};

export const crmReadTool: ToolSpec = {
  name: CRM_READ,
  description:
    "Read one CRM record in full: its fields, linked company and contact, a company's contacts and deals, and its latest logged activities. " +
    "Pass the id from crm_search, or an exact name.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
  },
};

const recordSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "To change a record; leave out to add one." },
    kind: { type: "string", enum: KINDS, description: "Required when adding." },
    name: { type: "string" },
    company: { type: "string", description: "Company id or name; a name not in the CRM adds that company." },
    contact: { type: "string", description: "Main contact's id or name." },
    stage: { type: "string", description: "Stage name (companies and deals)." },
    value: { type: "number" },
    probability: { type: "number", description: "0–100, deals." },
    closeDate: { type: "string", description: "YYYY-MM-DD" },
    renewalDate: { type: "string", description: "YYYY-MM-DD" },
    owner: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    title: { type: "string", description: "A contact's job title." },
    domain: { type: "string" },
    category: { type: "string" },
    notes: { type: "string", description: "Replaces the notes; read them first to keep what's there." },
    fields: { type: "object", description: "Other named fields, as text.", additionalProperties: { type: "string" } },
  },
};

export const crmWriteTool: ToolSpec = {
  name: CRM_WRITE,
  description:
    "Add or change records in the user's CRM: one call for all the changes a request needs (up to 50). Only the fields you pass change; " +
    "pass an empty string to clear one. The user sees each change and approves it, so don't ask first; say what you changed after.",
  inputSchema: {
    type: "object",
    properties: { records: { type: "array", items: recordSchema } },
    required: ["records"],
  },
};

export const crmLogTool: ToolSpec = {
  name: CRM_LOG,
  description:
    "Log an activity on a CRM record: a summary of emails or meetings you read, research you did, or a call the user tells you about. " +
    "Kind `ai` for your own summaries. The user approves it.",
  inputSchema: {
    type: "object",
    properties: {
      record: { type: "string", description: "The record's id, or exact name." },
      kind: { type: "string", enum: ["ai", "note", "call", "meeting", "email"] },
      body: { type: "string", description: "Dated where it matters, a few lines at most." },
    },
    required: ["record", "body"],
  },
};

export const crmViewTool: ToolSpec = {
  name: CRM_VIEW,
  description:
    "Show the user a list of CRM records as a view they can open on this page and save: when they ask to see, list or keep track " +
    "of a set of records (\"deals closing this month\", \"enterprise accounts with no owner\"). Check it with crm_search first.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short, like a tab label." },
      tab: { type: "string", enum: ["companies", "contacts", "deals", "renewals"] },
      query: { type: "string" },
      filters: filterSchema,
      sort: sortSchema,
    },
    required: ["name", "tab"],
  },
};

/** What the CRM page's own chats are told. Fixed text, so the prompt caches. */
export const CRM_SECTION =
  "You're helping the user with their CRM in Sush: their companies, contacts and deals (renewals are deals with a renewal date), " +
  "kept on this computer. Answer from the records with crm_search and crm_read, naming the records you used. To give the user " +
  "a list they may want to keep, call crm_view_propose. Make changes they ask for with crm_write and crm_log; they approve " +
  "each one. Research companies with web_search and web_fetch. For their email and calendar, use the Gmail and Google " +
  "Calendar connectors if they're connected; write drafts, never send. Keep answers short: the records are on screen.";

/** Added to a message that mentions @crm, outside the CRM page. */
export const CRM_MENTION_NOTE =
  "<mentioned>\n- @crm is the user's CRM in Sush: use the crm_* tools (crm_search, crm_read, crm_write, crm_log) for this request.\n</mentioned>";

const CRM_MENTION = /(^|[\s([{"'])@crm\b/i;
export const mentionsCrm = (text: string) => CRM_MENTION.test(text);

// --- running -----------------------------------------------------------------------------

type Args = Record<string, unknown>;
type Result = { output: unknown } | { errorText: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A record as the model sees it: names for links and stages, nothing empty. */
function brief(r: CrmRecord, data: CrmData): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id, kind: r.kind, name: r.name };
  const company = recordById(r.companyId);
  const contact = recordById(r.contactId);
  if (company) out.company = company.name;
  if (contact) out.contact = contact.name;
  const stage = stageOf(data.settings, r);
  if (stage) out.stage = stage.tone === "open" ? stage.name : `${stage.name} (${stage.tone})`;
  if (r.value != null) out.value = formatMoney(r.value, data.settings.currency);
  for (const k of ["probability", "closeDate", "renewalDate", "owner", "email", "phone", "title", "domain", "category"] as const) {
    if (r[k] != null && r[k] !== "") out[k] = r[k];
  }
  if (r.fields && Object.keys(r.fields).length) out.fields = r.fields;
  out.updated = new Date(r.updatedAt).toISOString().slice(0, 10);
  return out;
}

/** Turn the model's filters into the page's: stage names become ids, unknown fields are reported. */
function toFilters(raw: unknown, kind: CrmKind, data: CrmData): CrmFilter[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return "`filters` must be a list.";
  const out: CrmFilter[] = [];
  for (const f of raw as Args[]) {
    const field = str(f.field) ?? "";
    const op = str(f.op) as CrmFilterOp;
    if (!FIELD_IDS.includes(field) && !field.startsWith("fields.")) return `Unknown field "${field}". Fields: ${FIELD_IDS.join(", ")}.`;
    if (!OPS.includes(op)) return `Unknown op "${f.op}". Ops: ${OPS.join(", ")}.`;
    let value = f.value == null ? "" : String(f.value);
    if (field === "stage" && value) {
      const stage = stagesFor(data.settings, kind).find((s) => s.name.toLowerCase() === value.toLowerCase() || s.id === value);
      if (!stage) return `No ${kind} stage "${value}". Stages: ${stagesFor(data.settings, kind).map((s) => s.name).join(", ")}.`;
      value = stage.id;
    }
    out.push({ field, op, value });
  }
  return out;
}

function toSort(raw: unknown): CrmView["sort"] | string {
  if (raw == null) return null;
  const s = raw as Args;
  const field = str(s.field) ?? "";
  if (!FIELD_IDS.includes(field) && !field.startsWith("fields.")) return `Unknown sort field "${field}".`;
  return { field, desc: s.desc === true };
}

async function search(args: Args): Promise<Result> {
  await loadCrm();
  const data = getCrm();
  const renewals = args.renewals === true;
  const kind = (renewals ? "deal" : (str(args.kind) ?? "")) as CrmKind | "";
  if (kind && !KINDS.includes(kind)) return { errorText: `kind must be one of ${KINDS.join(", ")}.` };
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const query = str(args.query) ?? "";
  const kinds: CrmKind[] = kind ? [kind] : ["company", "contact", "deal"];
  // Full-text over fields and activities when there are words; filters and sort here.
  const ranked = query ? await api.crmSearch(query, kind || null, 200) : null;
  let rows: CrmRecord[] = [];
  for (const k of kinds) {
    const filters = toFilters(args.filters, k, data);
    if (typeof filters === "string") return { errorText: filters };
    const sort = toSort(args.sort);
    if (typeof sort === "string") return { errorText: sort };
    const tab: CrmTab = renewals ? "renewals" : k === "company" ? "companies" : k === "contact" ? "contacts" : "deals";
    const view = { ...baseView(tab), filters, sort: sort ?? baseView(tab).sort };
    const pool = ranked ? data.records.filter((r) => ranked.includes(r.id)) : data.records;
    let found = applyView(view, pool, data.settings);
    if (ranked && !args.sort) found = [...found].sort((a, b) => ranked.indexOf(a.id) - ranked.indexOf(b.id));
    rows = rows.concat(found);
  }
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  return {
    output: JSON.stringify({
      today: today(),
      stages: { company: data.settings.companyStages.map((s) => s.name), deal: data.settings.dealStages.map((s) => s.name) },
      matched: rows.length,
      ...(total ? { totalValue: formatMoney(total, data.settings.currency) } : {}),
      records: rows.slice(0, limit).map((r) => brief(r, data)),
      ...(rows.length > limit ? { more: `${rows.length - limit} more; narrow the search or raise limit.` } : {}),
      ...(data.records.length === 0 ? { note: "The CRM is empty. The user can import a CSV or add records on the CRM page." } : {}),
    }),
  };
}

/** A record by id, or by an exact (any case) name. */
function find(data: CrmData, ref: string | undefined, kind?: CrmKind): CrmRecord | undefined | "ambiguous" {
  if (!ref) return undefined;
  const byId = data.records.find((r) => r.id === ref);
  if (byId) return byId;
  const named = data.records.filter((r) => r.name.toLowerCase() === ref.toLowerCase() && (!kind || r.kind === kind));
  return named.length > 1 ? "ambiguous" : named[0];
}

async function read(args: Args): Promise<Result> {
  await loadCrm();
  const data = getCrm();
  const r = find(data, str(args.id) ?? str(args.name));
  if (r === "ambiguous") return { errorText: "Several records have that name. Pass the id from crm_search." };
  if (!r) return { errorText: "No record with that id or name. Find it with crm_search." };
  const activities = await api.crmActivities(r.id);
  const out: Record<string, unknown> = { ...brief(r, data) };
  if (r.notes) out.notes = r.notes;
  if (r.kind === "company") {
    out.contacts = data.records.filter((x) => x.kind === "contact" && x.companyId === r.id).map((x) => brief(x, data));
  }
  if (r.kind !== "deal") {
    out.deals = data.records
      .filter((x) => x.kind === "deal" && (r.kind === "company" ? x.companyId === r.id : x.contactId === r.id))
      .map((x) => brief(x, data));
  }
  out.activity = activities.slice(0, 15).map((a) => ({ kind: a.kind, at: new Date(a.at).toISOString().slice(0, 16).replace("T", " "), body: a.body }));
  if (activities.length > 15) out.olderActivities = activities.length - 15;
  return { output: JSON.stringify(out) };
}

// --- writes ------------------------------------------------------------------------------

/** One change a crm_write call makes, worked out before the user approves it. */
export interface PlannedChange {
  action: "add" | "update";
  before?: CrmRecord;
  after: CrmRecord;
  /** A company to add first and link, named but not in the CRM. */
  newCompany?: string;
  /** Field ids that change, for the card. */
  changed: string[];
}

const FIELD_KEYS = ["owner", "email", "phone", "title", "domain", "category", "notes", "closeDate", "renewalDate"] as const;

/** Work out what a crm_write call would do, or why it can't. */
export function planCrmWrite(input: unknown, data: CrmData): { ok: true; changes: PlannedChange[] } | { ok: false; error: string } {
  const list = (input as Args | undefined)?.records;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "crm_write needs `records`: a list of records to add or change." };
  if (list.length > 50) return { ok: false, error: "crm_write takes up to 50 records at a time." };
  const changes: PlannedChange[] = [];
  for (const [i, raw] of (list as Args[]).entries()) {
    const at = `records[${i}]`;
    const id = str(raw.id);
    let before: CrmRecord | undefined;
    if (id) {
      before = data.records.find((r) => r.id === id);
      if (!before) return { ok: false, error: `${at}: no record with id ${id}. Find it with crm_search.` };
    }
    const kind = (before?.kind ?? str(raw.kind)) as CrmKind;
    if (!KINDS.includes(kind)) return { ok: false, error: `${at}: say its kind (company, contact or deal).` };
    if (before && raw.kind && raw.kind !== before.kind) return { ok: false, error: `${at}: a record can't change its kind.` };
    const after: CrmRecord = before ? { ...before } : newRecord(kind);
    if (raw.name !== undefined) after.name = str(raw.name) ?? "";
    if (!after.name) return { ok: false, error: `${at}: give it a name.` };
    let newCompany: string | undefined;
    if (raw.company !== undefined && kind !== "company") {
      const ref = str(raw.company);
      if (!ref) after.companyId = undefined;
      else {
        const c = find(data, ref, "company");
        if (c === "ambiguous") return { ok: false, error: `${at}: several companies are called "${ref}"; pass its id.` };
        if (c) after.companyId = c.id;
        else {
          newCompany = ref;
          after.companyId = undefined;
        }
      }
    }
    if (raw.contact !== undefined && kind !== "contact") {
      const ref = str(raw.contact);
      if (!ref) after.contactId = undefined;
      else {
        const c = find(data, ref, "contact");
        if (!c || c === "ambiguous") return { ok: false, error: `${at}: no single contact "${ref}". Add them first or pass an id.` };
        after.contactId = c.id;
      }
    }
    if (raw.stage !== undefined && kind !== "contact") {
      const name = str(raw.stage);
      if (!name) after.stage = undefined;
      else {
        const stage = stagesFor(data.settings, kind).find((s) => s.name.toLowerCase() === name.toLowerCase() || s.id === name);
        if (!stage) return { ok: false, error: `${at}: no ${kind} stage "${name}". Stages: ${stagesFor(data.settings, kind).map((s) => s.name).join(", ")}.` };
        after.stage = stage.id;
      }
    } else if (!before && kind !== "contact" && !after.stage) {
      after.stage = stagesFor(data.settings, kind)[0]?.id;
    }
    for (const k of ["value", "probability"] as const) {
      if (raw[k] === undefined) continue;
      if (raw[k] === "" || raw[k] === null) {
        after[k] = undefined;
        continue;
      }
      const n = Number(raw[k]);
      if (!Number.isFinite(n)) return { ok: false, error: `${at}: ${k} must be a number.` };
      after[k] = k === "probability" ? Math.round(Math.min(100, Math.max(0, n))) : n;
    }
    for (const k of FIELD_KEYS) {
      if (raw[k] === undefined) continue;
      const v = raw[k] == null ? "" : String(raw[k]).trim();
      if ((k === "closeDate" || k === "renewalDate") && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: `${at}: ${k} must be YYYY-MM-DD.` };
      after[k] = v || undefined;
    }
    if (raw.fields && typeof raw.fields === "object") {
      const fields = { ...after.fields };
      for (const [k, v] of Object.entries(raw.fields as Args)) {
        if (v == null || v === "") delete fields[k];
        else fields[k] = String(v);
      }
      after.fields = fields;
    }
    const changed = before
      ? ["name", "companyId", "contactId", "stage", "value", "probability", ...FIELD_KEYS, "fields"].filter(
          (k) => JSON.stringify(before[k as keyof CrmRecord] ?? null) !== JSON.stringify(after[k as keyof CrmRecord] ?? null),
        )
      : [];
    if (newCompany) changed.push("companyId");
    if (before && changed.length === 0) continue;
    changes.push({ action: before ? "update" : "add", before, after, newCompany, changed });
  }
  if (changes.length === 0) return { ok: false, error: "Nothing would change: those records already have those values." };
  return { ok: true, changes };
}

/** Make the planned changes; the result for the model. */
export async function applyCrmWrite(changes: PlannedChange[]): Promise<Result> {
  const made = new Map<string, string>();
  const done: string[] = [];
  for (const c of changes) {
    const after = { ...c.after };
    if (c.newCompany) {
      const key = c.newCompany.toLowerCase();
      let id = made.get(key);
      if (!id) {
        const company = await saveRecord(newRecord("company", { name: c.newCompany, stage: getCrm().settings.companyStages[0]?.id }));
        if (!company) return { errorText: `Couldn't add the company "${c.newCompany}". ${done.length ? `Done before that: ${done.join("; ")}.` : ""}` };
        id = company.id;
        made.set(key, id);
        done.push(`added company "${company.name}" (${company.id})`);
      }
      after.companyId = id;
    }
    const saved = await saveRecord(after);
    if (!saved) return { errorText: `Couldn't save "${after.name}". ${done.length ? `Done before that: ${done.join("; ")}.` : ""}` };
    done.push(`${c.action === "add" ? "added" : "updated"} ${saved.kind} "${saved.name}" (${saved.id})`);
  }
  return { output: `Done: ${done.join("; ")}.` };
}

export interface PlannedLog {
  record: CrmRecord;
  kind: CrmActivityKind;
  body: string;
}

export function planCrmLog(input: unknown, data: CrmData): { ok: true; log: PlannedLog } | { ok: false; error: string } {
  const a = (input ?? {}) as Args;
  const ref = str(a.record);
  const body = str(a.body);
  if (!ref || !body) return { ok: false, error: "crm_log needs `record` (an id or exact name) and `body`." };
  const r = find(data, ref);
  if (r === "ambiguous") return { ok: false, error: "Several records have that name. Pass the id from crm_search." };
  if (!r) return { ok: false, error: `No record "${ref}". Find it with crm_search.` };
  const kind = (str(a.kind) ?? "ai") as CrmActivityKind;
  if (!["ai", "note", "call", "meeting", "email"].includes(kind)) return { ok: false, error: "kind must be ai, note, call, meeting or email." };
  return { ok: true, log: { record: r, kind, body } };
}

export async function applyCrmLog(log: PlannedLog): Promise<Result> {
  const ok = await addActivity(log.record.id, log.kind, log.body);
  return ok ? { output: `Logged on "${log.record.name}".` } : { errorText: "Couldn't log that." };
}

// --- views -------------------------------------------------------------------------------

export function planCrmView(input: unknown, data: CrmData): { ok: true; view: CrmView; count: number } | { ok: false; error: string } {
  const a = (input ?? {}) as Args;
  const name = str(a.name);
  const tab = str(a.tab) as CrmTab;
  if (!name) return { ok: false, error: "Give the view a short name." };
  if (!["companies", "contacts", "deals", "renewals"].includes(tab)) return { ok: false, error: "tab must be companies, contacts, deals or renewals." };
  const kind: CrmKind = tab === "companies" ? "company" : tab === "contacts" ? "contact" : "deal";
  const filters = toFilters(a.filters, kind, data);
  if (typeof filters === "string") return { ok: false, error: filters };
  const sort = toSort(a.sort);
  if (typeof sort === "string") return { ok: false, error: sort };
  const view: CrmView = { ...baseView(tab), name, query: str(a.query) ?? "", filters, sort: sort ?? baseView(tab).sort };
  return { ok: true, view, count: applyView(view, data.records, data.settings).length };
}

/** Run a CRM tool unasked: the reads always, the writes in Auto mode. Never throws. */
export async function runCrmTool(name: string, args: Args): Promise<Result> {
  try {
    if (name === CRM_SEARCH) return await search(args);
    if (name === CRM_READ) return await read(args);
    await loadCrm();
    if (name === CRM_WRITE) {
      const plan = planCrmWrite(args, getCrm());
      return plan.ok ? await applyCrmWrite(plan.changes) : { errorText: plan.error };
    }
    if (name === CRM_LOG) {
      const plan = planCrmLog(args, getCrm());
      return plan.ok ? await applyCrmLog(plan.log) : { errorText: plan.error };
    }
    if (name === CRM_VIEW) {
      const plan = planCrmView(args, getCrm());
      return plan.ok ? { output: `Showed the view "${plan.view.name}" (${plan.count} records) to the user; they can open it.` } : { errorText: plan.error };
    }
    return { errorText: `Unknown CRM tool ${name}.` };
  } catch (e) {
    return { errorText: errorMessage(e) };
  }
}

/** A field's label, for a change list. */
export function changeLabel(field: string): string {
  if (field === "companyId") return "Company";
  if (field === "contactId") return "Contact";
  if (field === "fields") return "Other fields";
  if (field === "notes") return "Notes";
  return FIELDS.find((f) => f.id === field)?.label ?? field;
}

/** A field's value as text, for a change list. */
export function changeValue(r: CrmRecord, field: string, data: CrmData): string {
  if (field === "companyId") return recordById(r.companyId)?.name ?? "";
  if (field === "contactId") return recordById(r.contactId)?.name ?? "";
  if (field === "fields") return Object.entries(r.fields ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  if (field === "value") return formatMoney(r.value, data.settings.currency);
  if (field === "probability") return r.probability == null ? "" : `${r.probability}%`;
  return fieldText(r, field, data.settings);
}
