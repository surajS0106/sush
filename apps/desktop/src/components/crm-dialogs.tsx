// The CRM page's dialogs: importing a CSV (pick the kind, check each column's
// field), editing the pipeline stages and currency, adding a record, and
// naming a view.

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { NONE, StagePill } from "@/components/crm-fields";
import { MoneyInput } from "@/components/money-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { newRecord, saveRecord, saveSettings, useCrm } from "@/lib/crm";
import { api, errorMessage, type CrmCsvFile, type CrmImportField, type CrmKind, type CrmRecord, type CrmSettings, type CrmStage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const KINDS: { id: CrmKind; label: string }[] = [
  { id: "company", label: "Companies" },
  { id: "contact", label: "Contacts" },
  { id: "deal", label: "Deals" },
];

const FIELD_LABEL: Record<CrmImportField, string> = {
  name: "Name",
  company: "Company (linked)",
  domain: "Domain",
  category: "Category",
  email: "Email",
  phone: "Phone",
  title: "Title",
  owner: "Owner",
  stage: "Stage",
  value: "Value",
  closeDate: "Close date",
  renewalDate: "Renewal date",
  probability: "Probability",
  notes: "Notes",
  custom: "Keep as its own field",
  skip: "Don’t import",
};

/** The fields a column can go to, for `kind`. */
const TARGETS: Record<CrmKind, CrmImportField[]> = {
  company: ["name", "domain", "category", "owner", "stage", "value", "notes", "custom", "skip"],
  contact: ["name", "company", "email", "phone", "title", "owner", "notes", "custom", "skip"],
  deal: ["name", "company", "owner", "stage", "value", "probability", "closeDate", "renewalDate", "notes", "custom", "skip"],
};

// --- import ------------------------------------------------------------------------------

export function ImportDialog({ file, defaultKind, onClose }: { file: CrmCsvFile | null; defaultKind: CrmKind; onClose: () => void }) {
  const [kind, setKind] = useState<CrmKind>(defaultKind);
  const [mapping, setMapping] = useState<CrmImportField[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) return;
    setKind(defaultKind);
  }, [file, defaultKind]);
  useEffect(() => {
    if (!file) return;
    // A guess this kind can't take (say a company column on companies) becomes its own field.
    setMapping(file.guesses[kind].map((g) => (TARGETS[kind].includes(g) ? g : "custom")));
  }, [file, kind]);

  if (!file) return null;
  const hasName = mapping.includes("name");

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.crmImport({ kind, headers: file.headers, mapping, rows: file.rows });
      const parts = [
        r.created && `${r.created} added`,
        r.updated && `${r.updated} updated`,
        r.companiesCreated && `${r.companiesCreated} ${r.companiesCreated === 1 ? "company" : "companies"} made for them`,
        r.skipped && `${r.skipped} skipped (no name or a bad date)`,
      ].filter(Boolean);
      toast.success(`Imported ${file.name}`, { description: parts.join(", ") || "Nothing to import." });
      onClose();
    } catch (e) {
      toast.error("Couldn’t import that file", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {file.name}</DialogTitle>
          <DialogDescription>
            {file.rows.length.toLocaleString()} rows. Rows that match a record you have update it; the rest are added.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2" role="radiogroup" aria-label="Import as">
          <span className="text-sm text-muted-foreground">Import as</span>
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cn(
                "rounded-md border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                kind === k.id && "border-brand bg-brand/8 text-foreground",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-[11px] tracking-wider text-muted-foreground uppercase">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Column</th>
                <th className="px-3 py-2 font-medium">First rows</th>
                <th className="w-52 px-3 py-2 font-medium">Goes to</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {file.headers.map((h, i) => (
                <tr key={i} className={cn(mapping[i] === "skip" && "text-muted-foreground")}>
                  <td className="px-3 py-2 font-medium">{h || `Column ${i + 1}`}</td>
                  <td className="max-w-56 truncate px-3 py-2 text-muted-foreground">
                    {file.rows
                      .slice(0, 3)
                      .map((r) => r[i])
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="px-3 py-1">
                    <Select value={mapping[i] ?? "skip"} onValueChange={(v) => setMapping((m) => m.map((x, j) => (j === i ? (v as CrmImportField) : x)))}>
                      <SelectTrigger size="sm" className="w-full" aria-label={`Field for ${h}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TARGETS[kind].map((t) => (
                          <SelectItem key={t} value={t}>
                            {FIELD_LABEL[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!hasName && <p className="text-sm text-coral">Pick the column that holds each row’s name.</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={!hasName || busy}>
            {busy ? "Importing…" : `Import ${file.rows.length.toLocaleString()} rows`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- stages ------------------------------------------------------------------------------

export function StagesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, records } = useCrm();
  const [draft, setDraft] = useState<CrmSettings>(settings);
  const [kind, setKind] = useState<"company" | "deal">("deal");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const key = kind === "company" ? "companyStages" : "dealStages";
  const stages = draft[key];
  const setStages = (next: CrmStage[]) => setDraft((d) => ({ ...d, [key]: next }));
  const inUse = (id: string) => records.filter((r) => r.kind === kind && r.stage === id).length;
  const removed = [...settings.companyStages, ...settings.dealStages].filter(
    (s) => ![...draft.companyStages, ...draft.dealStages].some((x) => x.id === s.id),
  );
  const orphaned = removed.reduce((n, s) => n + records.filter((r) => r.stage === s.id).length, 0);

  const save = async () => {
    setBusy(true);
    if (await saveSettings(draft)) onClose();
    setBusy(false);
  };

  const add = () => {
    let n = stages.length + 1;
    while (stages.some((s) => s.id === `stage-${n}`)) n++;
    setStages([...stages, { id: `stage-${n}`, name: "", tone: "open" }]);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pipeline</DialogTitle>
          <DialogDescription>The stages records move through, in order. Won stages show in your accent, lost ones in coral.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2" role="radiogroup" aria-label="Stages for">
          {(["deal", "company"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-md border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                kind === k && "border-brand bg-brand/8 text-foreground",
              )}
            >
              {k === "deal" ? "Deal stages" : "Company stages"}
            </button>
          ))}
        </div>
        <ol className="flex flex-col gap-2">
          {stages.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <Input
                value={s.name}
                autoFocus={!s.name}
                placeholder="Stage name"
                aria-label={`Stage ${i + 1} name`}
                onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                className="h-8 flex-1"
              />
              <Select value={s.tone} onValueChange={(v) => setStages(stages.map((x, j) => (j === i ? { ...x, tone: v as CrmStage["tone"] } : x)))}>
                <SelectTrigger size="sm" className="w-32" aria-label="Kind of stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">
                    <StagePill stage={{ id: "", name: "Open", tone: "open" }} />
                  </SelectItem>
                  <SelectItem value="won">
                    <StagePill stage={{ id: "", name: "Won", tone: "won" }} />
                  </SelectItem>
                  <SelectItem value="lost">
                    <StagePill stage={{ id: "", name: "Lost", tone: "lost" }} />
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => setStages(swap(stages, i, i - 1))}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Move down"
                disabled={i === stages.length - 1}
                onClick={() => setStages(swap(stages, i, i + 1))}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove stage"
                title={inUse(s.id) ? `${inUse(s.id)} records are in this stage` : undefined}
                disabled={stages.length === 1}
                onClick={() => setStages(stages.filter((_, j) => j !== i))}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ol>
        <Button variant="ghost" size="sm" className="w-fit" onClick={add}>
          <PlusIcon />
          Add stage
        </Button>
        <p className="text-xs text-muted-foreground">Amounts are in {draft.currency}. Change the currency in Settings → Units.</p>
        {orphaned > 0 && (
          <p className="text-sm text-muted-foreground">
            {orphaned} {orphaned === 1 ? "record is" : "records are"} in a stage you removed and will have no stage.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || [...draft.companyStages, ...draft.dealStages].some((s) => !s.name.trim())}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

// --- new record --------------------------------------------------------------------------

export function NewRecordDialog({
  kind,
  onClose,
  onCreated,
}: {
  kind: CrmKind | null;
  onClose: () => void;
  onCreated: (record: CrmRecord) => void;
}) {
  const { records, settings } = useCrm();
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState<string>(NONE);
  const [extra, setExtra] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind) {
      setName("");
      setCompanyId(NONE);
      setExtra("");
      setAmount(null);
    }
  }, [kind]);
  if (!kind) return null;
  const companies = records.filter((r) => r.kind === "company").sort((a, b) => a.name.localeCompare(b.name));
  const extraLabel = kind === "company" ? "Domain" : kind === "contact" ? "Email" : "Value";

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const patch: Partial<CrmRecord> = { name };
    if (kind !== "company" && companyId !== NONE) patch.companyId = companyId;
    const x = extra.trim();
    if (kind === "company" && x) patch.domain = x;
    if (kind === "contact" && x) patch.email = x;
    if (kind === "deal" && amount != null) patch.value = amount;
    if (kind === "deal") patch.stage = settings.dealStages[0]?.id;
    if (kind === "company") patch.stage = settings.companyStages[0]?.id;
    const saved = await saveRecord(newRecord(kind, patch));
    setBusy(false);
    if (saved) onCreated(saved);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New {kind}</DialogTitle>
          <DialogDescription>Add the rest once it’s open.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="crm-new-name">Name</Label>
            <Input
              id="crm-new-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === "company" ? "Company name" : kind === "contact" ? "Their full name" : "What the deal is"}
            />
          </div>
          {kind !== "company" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="crm-new-company">Company</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger id="crm-new-company" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    <span className="text-muted-foreground">No company</span>
                  </SelectItem>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="crm-new-extra">
              {extraLabel} <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            {kind === "deal" ? (
              <MoneyInput id="crm-new-extra" value={amount} onValueChange={setAmount} currency={settings.currency} placeholder="0" />
            ) : (
              <Input
                id="crm-new-extra"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder={kind === "company" ? "example.com" : "name@example.com"}
              />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              Add {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- view name ---------------------------------------------------------------------------

export function ViewNameDialog({
  open,
  initial,
  title,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  title: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>It keeps the search, filters, sort, columns and layout.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSave(name.trim());
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="View name" aria-label="View name" />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
