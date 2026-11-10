// A CRM record in a drawer: its fields (each editable in place), the records
// linked to it (a company's contacts and deals, a contact's deals), its notes,
// and its activity log, where calls, meetings, emails and notes are logged.
// Stage moves are logged by Rust.

import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  MailIcon,
  PhoneIcon,
  PlusIcon,
  SparklesIcon,
  StickyNoteIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { crmActions } from "@/components/crm-ask";
import { FieldDisplay, FieldEditor, RecordMark } from "@/components/crm-fields";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  addActivity,
  dealHealth,
  deleteActivity,
  deleteRecords,
  fieldsFor,
  formatMoney,
  newRecord,
  saveRecord,
  updateRecord,
  useActivities,
  useCrm,
  type FieldDef,
} from "@/lib/crm";
import type { CrmActivity, CrmActivityKind, CrmKind, CrmRecord } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<CrmKind, string> = { company: "Company", contact: "Contact", deal: "Deal" };

const ACTIVITY: Record<CrmActivityKind, { label: string; icon: typeof StickyNoteIcon }> = {
  note: { label: "Note", icon: StickyNoteIcon },
  call: { label: "Call", icon: PhoneIcon },
  meeting: { label: "Meeting", icon: UsersIcon },
  email: { label: "Email", icon: MailIcon },
  ai: { label: "Sush", icon: SparklesIcon },
  change: { label: "Change", icon: ArrowRightLeftIcon },
};
const LOGGABLE: CrmActivityKind[] = ["note", "call", "meeting", "email"];

/**
 * The drawer for record `id`. Linked records open in it too, with Back to
 * return; closing it clears the trail.
 */
export function RecordSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [trail, setTrail] = useState<string[]>([]);
  useEffect(() => setTrail(id ? [id] : []), [id]);
  const current = trail.at(-1) ?? null;
  const { records } = useCrm();
  const record = current ? records.find((r) => r.id === current) : undefined;

  // Deleted (here or in another window): close.
  useEffect(() => {
    if (id && current && !record) {
      if (trail.length > 1) setTrail((t) => t.slice(0, -1));
      else onClose();
    }
  }, [id, current, record, trail.length, onClose]);

  return (
    <Sheet open={!!id && !!record} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {record && (
          <RecordBody
            key={record.id}
            record={record}
            canGoBack={trail.length > 1}
            onBack={() => setTrail((t) => t.slice(0, -1))}
            onOpen={(rid) => setTrail((t) => [...t, rid])}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function RecordBody({
  record,
  canGoBack,
  onBack,
  onOpen,
  onClose,
}: {
  record: CrmRecord;
  canGoBack: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { records, settings } = useCrm();
  const fields = fieldsFor(record.kind, records).filter((f) => f.id !== "name" && f.id !== "updatedAt" && f.type !== "health");
  const health = dealHealth(record, settings);
  const contacts = records.filter((r) => r.kind === "contact" && r.companyId === record.id);
  const deals = records.filter(
    (r) => r.kind === "deal" && (record.kind === "company" ? r.companyId === record.id : r.contactId === record.id),
  );

  return (
    <>
      <SheetHeader className="gap-2 border-b px-6 pt-6 pb-4">
        {canGoBack && (
          <button type="button" onClick={onBack} className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-3" />
            Back
          </button>
        )}
        <div className="flex min-w-0 items-center gap-3 pr-8">
          <RecordMark record={record} className="size-10 text-base" />
          <div className="min-w-0 flex-1">
            <NameField record={record} />
            <SheetDescription className="text-xs">
              {KIND_LABEL[record.kind]}
              {record.kind !== "contact" && record.value != null && ` · ${formatMoney(record.value, settings.currency)}`}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      {health && (
        <section className="flex flex-col gap-1 border-b px-6 py-3" aria-label="Deal health">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">Health</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className={cn("block h-full rounded-full", health.score < 35 ? "bg-coral" : "bg-brand")} style={{ width: `${health.score}%` }} />
            </span>
            <span className={cn("font-medium tabular-nums", health.score < 35 && "text-coral")}>{health.score}</span>
          </div>
          <p className="text-xs text-muted-foreground">{health.reasons.join(" · ")}</p>
        </section>
      )}
      <section className="flex flex-wrap gap-2 border-b px-6 py-3" aria-label="Ask Sush">
        {crmActions(record).map((a) => (
          <Button
            key={a.id}
            variant="outline"
            size="sm"
            title={a.hint}
            onClick={() => {
              // The work shows in the page's Ask panel, beside the table.
              onClose();
              a.run(record);
            }}
          >
            <SparklesIcon className="text-brand" />
            {a.label}
          </Button>
        ))}
      </section>

      <section className="grid grid-cols-[112px_1fr] items-center gap-x-3 gap-y-1 border-b px-6 py-4" aria-label="Fields">
        {fields.map((f) => (
          <FieldRow key={f.id} record={record} field={f} />
        ))}
      </section>

      {record.kind === "company" && (
        <Related
          title="Contacts"
          kind="contact"
          items={contacts}
          onOpen={onOpen}
          onAdd={(name) => saveRecord(newRecord("contact", { name, companyId: record.id }))}
        />
      )}
      {record.kind !== "deal" && (
        <Related
          title="Deals"
          kind="deal"
          items={deals}
          onOpen={onOpen}
          onAdd={(name) =>
            saveRecord(
              newRecord("deal", {
                name,
                companyId: record.kind === "company" ? record.id : record.companyId,
                contactId: record.kind === "contact" ? record.id : record.contactId,
                stage: settings.dealStages[0]?.id,
                owner: record.owner,
              }),
            )
          }
        />
      )}

      <Notes record={record} />
      <Activity record={record} />

      <footer className="mt-auto flex justify-end border-t px-6 py-3">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-coral" onClick={() => void deleteRecords([record.id])}>
          <Trash2Icon />
          Delete {record.kind}
        </Button>
      </footer>
    </>
  );
}

function NameField({ record }: { record: CrmRecord }) {
  const [editing, setEditing] = useState(false);
  const field: FieldDef = { id: "name", label: "Name", type: "text", kinds: [record.kind] };
  if (editing) return <FieldEditor record={record} field={field} onDone={() => setEditing(false)} className="h-8 text-base font-semibold" />;
  return (
    <SheetTitle>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename"
        className="max-w-full truncate rounded text-left text-base font-semibold hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        {record.name}
      </button>
    </SheetTitle>
  );
}

function FieldRow({ record, field }: { record: CrmRecord; field: FieldDef }) {
  const { settings } = useCrm();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <span className="truncate text-xs text-muted-foreground">{field.label}</span>
      {editing ? (
        <div className="py-0.5">
          <FieldEditor record={record} field={field} onDone={() => setEditing(false)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={`${field.label}: edit`}
          className="flex h-8 min-w-0 items-center rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <FieldDisplay record={record} field={field} settings={settings} />
          <EmptyHint record={record} field={field} />
        </button>
      )}
    </>
  );
}

/** "Add …" in an empty field, so it reads as something to fill in. */
function EmptyHint({ record, field }: { record: CrmRecord; field: FieldDef }) {
  const empty =
    field.type === "stage"
      ? !record.stage
      : field.type === "link"
        ? !(field.id === "company" ? record.companyId : record.contactId)
        : field.type === "money"
          ? record.value == null
          : field.type === "percent"
            ? record.probability == null
            : !(field.id.startsWith("fields.") ? record.fields?.[field.id.slice(7)] : (record as unknown as Record<string, unknown>)[field.id]);
  if (!empty || field.type === "stage") return null;
  return <span className="text-muted-foreground/60">Add {field.label.toLowerCase()}</span>;
}

function Related({
  title,
  kind,
  items,
  onOpen,
  onAdd,
}: {
  title: string;
  kind: CrmKind;
  items: CrmRecord[];
  onOpen: (id: string) => void;
  onAdd: (name: string) => Promise<CrmRecord | null>;
}) {
  const { settings } = useCrm();
  const [adding, setAdding] = useState<string | null>(null);
  const add = async () => {
    const name = adding?.trim();
    if (!name) return setAdding(null);
    if (await onAdd(name)) setAdding(null);
  };
  return (
    <section className="border-b px-6 py-4" aria-label={title}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => setAdding("")}>
          <PlusIcon />
          Add {kind}
        </Button>
      </div>
      <ul className="flex flex-col">
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onOpen(r.id)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <RecordMark record={r} className="size-5 text-[10px]" />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {kind === "contact" ? r.title : formatMoney(r.value, settings.currency)}
              </span>
            </button>
          </li>
        ))}
        {adding !== null && (
          <li className="px-2 py-1">
            <input
              autoFocus
              value={adding}
              placeholder={kind === "contact" ? "Their name" : "What the deal is"}
              aria-label={`New ${kind}'s name`}
              onChange={(e) => setAdding(e.target.value)}
              onBlur={() => void add()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAdding(null);
                }
              }}
              className="h-8 w-full rounded-md border border-ring bg-background px-2 text-sm outline-none ring-3 ring-ring/30"
            />
          </li>
        )}
        {items.length === 0 && adding === null && <li className="px-2 text-sm text-muted-foreground">None yet.</li>}
      </ul>
    </section>
  );
}

function Notes({ record }: { record: CrmRecord }) {
  const [text, setText] = useState(record.notes ?? "");
  // Someone else's save (another window) shows when this isn't being edited.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(record.notes ?? "");
  }, [record.notes, focused]);
  return (
    <section className="border-b px-6 py-4" aria-label="Notes">
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">Notes</h3>
      <Textarea
        value={text}
        placeholder="Anything worth remembering about them"
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (text !== (record.notes ?? "")) void updateRecord(record.id, { notes: text });
        }}
        className="min-h-20 resize-y"
      />
    </section>
  );
}

function Activity({ record }: { record: CrmRecord }) {
  const list = useActivities(record.id);
  const [kind, setKind] = useState<CrmActivityKind>("note");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const log = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    if (await addActivity(record.id, kind, body)) setBody("");
    setBusy(false);
  };
  return (
    <section className="px-6 py-4" aria-label="Activity">
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">Activity</h3>
      <div className="rounded-lg border bg-card focus-within:border-ring">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void log();
            }
          }}
          placeholder={`Log a ${ACTIVITY[kind].label.toLowerCase()}…`}
          aria-label="Activity"
          rows={2}
          className="block w-full resize-none bg-transparent px-3 pt-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <Select value={kind} onValueChange={(v) => setKind(v as CrmActivityKind)}>
            <SelectTrigger size="sm" className="w-32" aria-label="Kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOGGABLE.map((k) => {
                const Icon = ACTIVITY[k].icon;
                return (
                  <SelectItem key={k} value={k}>
                    <Icon />
                    {ACTIVITY[k].label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <span className="flex-1" />
          <Button size="sm" disabled={!body.trim() || busy} onClick={() => void log()}>
            Log
          </Button>
        </div>
      </div>
      <ol className="mt-4 flex flex-col gap-3">
        {list === undefined && <li className="text-sm text-muted-foreground">Loading…</li>}
        {list?.length === 0 && <li className="text-sm text-muted-foreground">Nothing logged yet.</li>}
        {list?.map((a) => <ActivityItem key={a.id} activity={a} />)}
      </ol>
    </section>
  );
}

function ActivityItem({ activity }: { activity: CrmActivity }) {
  const { icon: Icon, label } = ACTIVITY[activity.kind];
  const quiet = activity.kind === "change";
  return (
    <li className="group flex gap-3">
      <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted", activity.kind === "ai" && "bg-brand/12 text-brand")}>
        <Icon className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{label}</span>
          <time dateTime={new Date(activity.at).toISOString()}>{when(activity.at)}</time>
          <span className="flex-1" />
          {!quiet && (
            <button
              type="button"
              aria-label="Delete"
              onClick={() => deleteActivity(activity.id)}
              className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:text-coral focus-visible:opacity-100"
            >
              <Trash2Icon className="size-3" />
            </button>
          )}
        </div>
        <Body quiet={quiet}>{activity.body}</Body>
      </div>
    </li>
  );
}

const Body = ({ quiet, children }: { quiet: boolean; children: ReactNode }) => (
  <p className={cn("mt-1 text-sm break-words whitespace-pre-wrap", quiet && "text-muted-foreground")}>{children}</p>
);

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}
