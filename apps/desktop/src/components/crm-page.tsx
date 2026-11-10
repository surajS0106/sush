// The CRM page: companies, contacts, deals and renewals as tabs, then the
// user's saved views. Each tab is a view (search, filters, sort, columns and
// table or pipeline layout); changing one keeps an unsaved draft per tab until
// it's saved, saved as a new view, or reset. Records open in a drawer.

import {
  ArrowUpDownIcon,
  Columns3Icon,
  ContactIcon,
  FileUpIcon,
  KanbanIcon,
  ListFilterIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SparklesIcon,
  TableIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";

import { CrmAskPanel, setAskOpen, useAskOpen } from "@/components/crm-ask";
import { CrmBoard } from "@/components/crm-board";
import { ImportDialog, NewRecordDialog, StagesDialog, ViewNameDialog } from "@/components/crm-dialogs";
import { StagePill } from "@/components/crm-fields";
import { RecordSheet } from "@/components/crm-record";
import { MoneyInput } from "@/components/money-input";
import { CrmTable } from "@/components/crm-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProviderModels } from "@/hooks/use-providers";
import {
  addSampleData,
  applyView,
  baseView,
  BUILT_IN_TABS,
  crmPage,
  deleteRecords,
  deleteView,
  fieldsFor,
  kindOf,
  knownOwners,
  loadCrm,
  saveView,
  stagesFor,
  updateMany,
  useCrm,
  viewChanged,
  type FieldDef,
} from "@/lib/crm";
import { api, errorMessage, type CrmCsvFile, type CrmFilter, type CrmFilterOp, type CrmKind, type CrmTab, type CrmView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const pageState = crmPage;

const KIND_WORD: Record<CrmKind, string> = { company: "company", contact: "contact", deal: "deal" };

export function CrmPage({
  catalog,
  hasProviders,
  onOpenSettings,
  onOpenSession,
}: {
  catalog: ProviderModels[];
  hasProviders: boolean | null;
  onOpenSettings: () => void;
  onOpenSession: (id: string) => void;
}) {
  const crm = useCrm();
  const askOpen = useAskOpen();
  const page = useSyncExternalStore(pageState.subscribe, pageState.get);
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<CrmKind | null>(null);
  const [csv, setCsv] = useState<CrmCsvFile | null>(null);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [naming, setNaming] = useState<{ title: string; initial: string; save: (name: string) => void } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadCrm();
  }, []);

  // The open tab, falling back to Companies if its saved view is gone.
  const savedView = page.active.startsWith("view:") ? crm.views.find((v) => `view:${v.id}` === page.active) : undefined;
  const activeKey = page.active.startsWith("view:") && !savedView ? "companies" : page.active;
  const base = savedView ?? baseView((BUILT_IN_TABS.some((t) => t.tab === activeKey) ? activeKey : "companies") as CrmTab);
  const view = page.drafts[activeKey] ?? base;
  const modified = viewChanged(view, base);
  const kind = kindOf(view.tab);

  const setView = (patch: Partial<CrmView>) =>
    pageState.set((s) => ({ ...s, drafts: { ...s.drafts, [activeKey]: { ...view, ...patch } } }));
  const resetView = () =>
    pageState.set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[activeKey];
      return { ...s, drafts };
    });
  const openTab = (key: string) => {
    pageState.set((s) => ({ ...s, active: key }));
    setSelected(new Set());
    setQuery(null);
  };

  const allFields = useMemo(() => fieldsFor(kind, crm.records), [kind, crm.records]);
  const shownFields = allFields.filter((f) => !view.hidden.includes(f.id));
  const rows = useMemo(() => applyView(view, crm.records, crm.settings), [view, crm.records, crm.settings]);
  const boardable = kind !== "contact";
  const layout = boardable ? view.layout : "table";

  // Selection only holds what's shown.
  useEffect(() => {
    setSelected((sel) => {
      const ids = new Set(rows.map((r) => r.id));
      const next = new Set([...sel].filter((id) => ids.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [rows]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (typing || openId || newKind || csv || stagesOpen || naming) return;
      if (e.key === "/") {
        e.preventDefault();
        setQuery((q) => q ?? "");
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (e.key === "Escape" && selected.size) {
        setSelected(new Set());
      }
    },
    [openId, newKind, csv, stagesOpen, naming, selected.size],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const pickCsv = async () => {
    try {
      const file = await api.crmImportPick();
      if (file) setCsv(file);
    } catch (e) {
      toast.error("Couldn’t read that file", { description: errorMessage(e) });
    }
  };

  const saveAsNew = () =>
    setNaming({
      title: "Save as a view",
      initial: modified && savedView ? `${savedView.name} copy` : `${base.name} view`,
      save: async (name) => {
        const saved = await saveView({ ...view, id: "", name, createdAt: 0 });
        if (!saved) return;
        resetView();
        openTab(`view:${saved.id}`);
        setNaming(null);
      },
    });

  const saveChanges = async () => {
    if (!savedView) return saveAsNew();
    if (await saveView({ ...view, id: savedView.id, name: savedView.name, createdAt: savedView.createdAt })) resetView();
  };

  // Typing in search changes the view's query, so searching is part of a saved view too.
  const searchValue = query ?? view.query;
  const searching = query !== null || !!view.query;

  if (!crm.loaded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header />
      </div>
    );
  }

  const empty = crm.records.length === 0;

  return (
    <div className="flex min-h-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header>
        {!empty && (
          <>
            {!askOpen && (
              <Button variant="ghost" size="sm" onClick={() => setAskOpen(true)}>
                <SparklesIcon className="text-brand" />
                Ask Sush
              </Button>
            )}
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setStagesOpen(true)}>
              <Settings2Icon />
              Pipeline
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void pickCsv()}>
              <FileUpIcon />
              Import
            </Button>
            <Button size="sm" onClick={() => setNewKind(kind)}>
              <PlusIcon />
              New {KIND_WORD[kind]}
            </Button>
          </>
        )}
      </Header>

      {empty ? (
        <EmptyCrm onImport={() => void pickCsv()} onNew={() => setNewKind("company")} />
      ) : (
        <>
          <Tabs
            active={activeKey}
            views={crm.views}
            drafts={page.drafts}
            onOpen={openTab}
            onRename={(v) =>
              setNaming({
                title: "Rename view",
                initial: v.name,
                save: async (name) => {
                  if (await saveView({ ...v, name })) setNaming(null);
                },
              })
            }
            onDelete={(v) => {
              deleteView(v.id);
              if (activeKey === `view:${v.id}`) openTab(v.tab);
            }}
          />

          {selected.size > 0 ? (
            <SelectionBar
              kind={kind}
              count={selected.size}
              onStage={(stage) => void updateMany([...selected], { stage })}
              onOwner={(owner) => void updateMany([...selected], { owner })}
              onDelete={() => {
                void deleteRecords([...selected]);
                setSelected(new Set());
              }}
              onClear={() => setSelected(new Set())}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
              {searching ? (
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    autoFocus={query !== null && !view.query}
                    value={searchValue}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setView({ query: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setQuery(null);
                        setView({ query: "" });
                      }
                    }}
                    placeholder={`Search ${base.name.toLowerCase()}`}
                    aria-label="Search"
                    className="h-8 w-56 pr-8 pl-8"
                  />
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery(null);
                      setView({ query: "" });
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-4" />
                  </button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setQuery("")} title="Search ( / )">
                  <SearchIcon />
                  Search
                </Button>
              )}
              <FilterMenu kind={kind} fields={allFields} filters={view.filters} onChange={(filters) => setView({ filters })} />
              <SortMenu fields={allFields} sort={view.sort} onChange={(sort) => setView({ sort })} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-muted-foreground">
                    <Columns3Icon />
                    Columns
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Show</DropdownMenuLabel>
                  {allFields
                    .filter((f) => f.id !== "name")
                    .map((f) => (
                      <DropdownMenuCheckboxItem
                        key={f.id}
                        checked={!view.hidden.includes(f.id)}
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={(on) => setView({ hidden: on ? view.hidden.filter((h) => h !== f.id) : [...view.hidden, f.id] })}
                      >
                        {f.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {modified && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={resetView} className="text-muted-foreground">
                    Reset
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void saveChanges()}>
                    {savedView ? "Save view" : "Save as view"}
                  </Button>
                  {savedView && (
                    <Button variant="ghost" size="sm" onClick={saveAsNew}>
                      Save as new
                    </Button>
                  )}
                </div>
              )}
              <span className="flex-1" />
              {boardable && (
                <div className="flex rounded-md bg-muted p-0.5" role="radiogroup" aria-label="Layout">
                  {(["table", "board"] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="radio"
                      aria-checked={layout === l}
                      onClick={() => setView({ layout: l })}
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
                        layout === l && "bg-background text-foreground shadow-sm",
                      )}
                    >
                      {l === "table" ? <TableIcon className="size-3.5" /> : <KanbanIcon className="size-3.5" />}
                      {l === "table" ? "Table" : "Pipeline"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {rows.length === 0 ? (
            <NoRows
              filtered={view.filters.length > 0 || !!view.query || view.tab === "renewals"}
              renewals={view.tab === "renewals"}
              kind={kind}
              onClear={() => {
                setQuery(null);
                setView({ filters: [], query: "" });
              }}
              onNew={() => setNewKind(kind)}
            />
          ) : layout === "board" ? (
            <CrmBoard kind={kind} rows={rows} settings={crm.settings} onOpen={(r) => setOpenId(r.id)} />
          ) : (
            <CrmTable
              rows={rows}
              fields={shownFields}
              settings={crm.settings}
              sort={view.sort}
              onSort={(sort) => setView({ sort })}
              selected={selected}
              onSelectedChange={setSelected}
              onOpen={(r) => setOpenId(r.id)}
            />
          )}
        </>
      )}

      <RecordSheet id={openId} onClose={() => setOpenId(null)} />
      <NewRecordDialog
        kind={newKind}
        onClose={() => setNewKind(null)}
        onCreated={(r) => {
          setNewKind(null);
          setOpenId(r.id);
        }}
      />
      <ImportDialog file={csv} defaultKind={kind} onClose={() => setCsv(null)} />
      <StagesDialog open={stagesOpen} onClose={() => setStagesOpen(false)} />
      <ViewNameDialog
        open={!!naming}
        title={naming?.title ?? ""}
        initial={naming?.initial ?? ""}
        onClose={() => setNaming(null)}
        onSave={(name) => naming?.save(name)}
      />
    </div>
    {askOpen && !empty && (
      <CrmAskPanel catalog={catalog} hasProviders={hasProviders} onOpenSettings={onOpenSettings} onOpenSession={onOpenSession} />
    )}
    </div>
  );
}

function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-2 px-6 pt-6 pb-3">
      <div className="mr-2 flex items-center gap-2">
        <ContactIcon className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-tight">CRM</h1>
      </div>
      <span className="flex-1" />
      {children}
    </header>
  );
}

function Tabs({
  active,
  views,
  drafts,
  onOpen,
  onRename,
  onDelete,
}: {
  active: string;
  views: CrmView[];
  drafts: Record<string, CrmView>;
  onOpen: (key: string) => void;
  onRename: (v: CrmView) => void;
  onDelete: (v: CrmView) => void;
}) {
  const tabs = [
    ...BUILT_IN_TABS.map((t) => ({ key: t.tab, label: t.label, view: undefined as CrmView | undefined })),
    ...views.map((v) => ({ key: `view:${v.id}`, label: v.name, view: v })),
  ];
  return (
    <div role="tablist" aria-label="Tables and views" className="flex items-center gap-1 overflow-x-auto border-b px-6">
      {tabs.map((t) => {
        const on = t.key === active;
        const draft = drafts[t.key];
        const dirty = !!draft && viewChanged(draft, t.view ?? baseView(t.key as CrmTab));
        return (
          <div key={t.key} className="group relative flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onOpen(t.key)}
              className={cn(
                "relative flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
                on && "text-foreground",
                t.view && "pr-6",
              )}
            >
              {t.label}
              {dirty && <span aria-label="Unsaved changes" className="size-1.5 rounded-full bg-brand" />}
              {on && <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
            </button>
            {t.view && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${t.label} options`}
                    className="absolute right-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  <DropdownMenuItem onSelect={() => onRename(t.view!)}>Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => onDelete(t.view!)}>
                    <Trash2Icon />
                    Delete view
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      })}
    </div>
  );
}

const OPS: Record<FieldDef["type"], { op: CrmFilterOp; label: string }[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "is", label: "is" },
    { op: "is-not", label: "is not" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is not empty" },
  ],
  link: [
    { op: "is", label: "is" },
    { op: "contains", label: "contains" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is not empty" },
  ],
  stage: [
    { op: "is", label: "is" },
    { op: "is-not", label: "is not" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is set" },
  ],
  money: [
    { op: "gt", label: "over" },
    { op: "lt", label: "under" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is set" },
  ],
  number: [
    { op: "gt", label: "over" },
    { op: "lt", label: "under" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is set" },
  ],
  health: [
    { op: "lt", label: "under" },
    { op: "gt", label: "over" },
  ],
  percent: [
    { op: "gt", label: "over" },
    { op: "lt", label: "under" },
    { op: "empty", label: "is empty" },
  ],
  date: [
    { op: "lt", label: "before" },
    { op: "gt", label: "after" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is set" },
  ],
};

function FilterMenu({
  kind,
  fields,
  filters,
  onChange,
}: {
  kind: CrmKind;
  fields: FieldDef[];
  filters: CrmFilter[];
  onChange: (filters: CrmFilter[]) => void;
}) {
  const { settings } = useCrm();
  const typeOf = (id: string) => fields.find((f) => f.id === id)?.type ?? "text";
  const add = () => {
    const f = fields.find((x) => x.id === "stage") ?? fields[0];
    onChange([...filters, { field: f.id, op: OPS[f.type][0].op, value: "" }]);
  };
  const set = (i: number, patch: Partial<CrmFilter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className={cn("text-muted-foreground", filters.length && "text-foreground")}>
          <ListFilterIcon />
          Filter
          {filters.length > 0 && <span className="rounded bg-brand/12 px-1 text-xs text-brand tabular-nums">{filters.length}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 flex w-[30rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md data-open:animate-in data-open:fade-in-0"
        >
          {filters.length === 0 && <p className="text-sm text-muted-foreground">No filters. Every {KIND_WORD[kind]} shows.</p>}
          {filters.map((f, i) => {
            const type = typeOf(f.field);
            const ops = OPS[type];
            const needsValue = f.op !== "empty" && f.op !== "not-empty";
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-xs text-muted-foreground">{i === 0 ? "Where" : "and"}</span>
                <Select
                  value={f.field}
                  onValueChange={(field) => {
                    const t = typeOf(field);
                    set(i, { field, op: OPS[t].some((o) => o.op === f.op) ? f.op : OPS[t][0].op, value: "" });
                  }}
                >
                  <SelectTrigger size="sm" className="w-32" aria-label="Field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fields.map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={f.op} onValueChange={(op) => set(i, { op: op as CrmFilterOp })}>
                  <SelectTrigger size="sm" className="w-28" aria-label="Condition">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((o) => (
                      <SelectItem key={o.op} value={o.op}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {needsValue &&
                  (type === "stage" ? (
                    <Select value={f.value || undefined} onValueChange={(value) => set(i, { value })}>
                      <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Stage">
                        <SelectValue placeholder="Pick a stage" />
                      </SelectTrigger>
                      <SelectContent>
                        {stagesFor(settings, kind).map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            <StagePill stage={s} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : type === "money" ? (
                    <MoneyInput
                      compact
                      aria-label="Amount"
                      currency={settings.currency}
                      value={f.value === "" ? null : Number(f.value)}
                      onValueChange={(n) => set(i, { value: n == null ? "" : String(n) })}
                      className="flex-1"
                    />
                  ) : (
                    <Input
                      type={type === "date" ? "date" : "text"}
                      inputMode={type === "money" || type === "percent" || type === "number" ? "decimal" : undefined}
                      value={f.value}
                      onChange={(e) => set(i, { value: e.target.value })}
                      placeholder="Value"
                      aria-label="Value"
                      className="h-7 min-w-0 flex-1"
                    />
                  ))}
                {!needsValue && <span className="flex-1" />}
                <Button variant="ghost" size="icon-sm" aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))}>
                  <XIcon />
                </Button>
              </div>
            );
          })}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={add}>
              <PlusIcon />
              Add filter
            </Button>
            <span className="flex-1" />
            {filters.length > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onChange([])}>
                Clear all
              </Button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SortMenu({ fields, sort, onChange }: { fields: FieldDef[]; sort: CrmView["sort"]; onChange: (s: CrmView["sort"]) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("text-muted-foreground", sort && "text-foreground")}>
          <ArrowUpDownIcon />
          {sort ? `Sorted by ${fields.find((f) => f.id === sort.field)?.label.toLowerCase() ?? sort.field}` : "Sort"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort?.field ?? ""} onValueChange={(field) => onChange({ field, desc: sort?.desc ?? false })}>
          {fields.map((f) => (
            <DropdownMenuRadioItem key={f.id} value={f.id}>
              {f.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {sort && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={sort.desc ? "desc" : "asc"} onValueChange={(d) => onChange({ ...sort, desc: d === "desc" })}>
              <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(null)}>Recently updated first</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SelectionBar({
  kind,
  count,
  onStage,
  onOwner,
  onDelete,
  onClear,
}: {
  kind: CrmKind;
  count: number;
  onStage: (stage: string | undefined) => void;
  onOwner: (owner: string | undefined) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { settings, records } = useCrm();
  const stages = stagesFor(settings, kind);
  const owners = knownOwners(records);
  const [owner, setOwner] = useState("");
  return (
    <div className="mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand/6 px-3 py-1" role="toolbar" aria-label="Selected records">
      <span className="text-sm font-medium tabular-nums">{count} selected</span>
      <span className="flex-1" />
      {stages.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              Set stage
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {stages.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => onStage(s.id)}>
                <StagePill stage={s} />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onStage(undefined)}>No stage</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            Set owner
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {owners.map((o) => (
            <DropdownMenuItem key={o} onSelect={() => onOwner(o)}>
              {o}
            </DropdownMenuItem>
          ))}
          {owners.length > 0 && <DropdownMenuSeparator />}
          <form
            className="p-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (owner.trim()) onOwner(owner.trim());
              setOwner("");
            }}
          >
            <Input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Someone else"
              aria-label="Owner"
              className="h-7"
            />
          </form>
          <DropdownMenuItem onSelect={() => onOwner(undefined)}>No owner</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="sm" className="hover:text-coral" onClick={onDelete}>
        <Trash2Icon />
        Delete
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Clear selection (Esc)" onClick={onClear}>
        <XIcon />
      </Button>
    </div>
  );
}

function NoRows({
  filtered,
  renewals,
  kind,
  onClear,
  onNew,
}: {
  filtered: boolean;
  renewals: boolean;
  kind: CrmKind;
  onClear: () => void;
  onNew: () => void;
}) {
  return (
    <div className="mx-6 mb-6 flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
      <p className="text-sm text-muted-foreground">
        {renewals
          ? "No renewals yet. Give a deal a renewal date and it shows here."
          : filtered
            ? `No ${KIND_WORD[kind]} matches this view.`
            : `No ${KIND_WORD[kind] === "company" ? "companies" : `${KIND_WORD[kind]}s`} yet.`}
      </p>
      <div className="flex gap-2">
        {filtered && !renewals && (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear search and filters
          </Button>
        )}
        <Button size="sm" onClick={onNew}>
          <PlusIcon />
          New {KIND_WORD[kind]}
        </Button>
      </div>
    </div>
  );
}

function EmptyCrm({ onImport, onNew }: { onImport: () => void; onNew: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-brand/12 text-brand">
          <ContactIcon className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Your companies, people and deals</h2>
          <p className="text-sm text-muted-foreground">
            Keep them here, on this computer. Move deals through your pipeline, log calls and meetings, and save the views you check often.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={onImport}>
            <FileUpIcon />
            Import a CSV
          </Button>
          <Button variant="outline" onClick={onNew}>
            <PlusIcon />
            Add a company
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await addSampleData();
            setBusy(false);
          }}
        >
          <SparklesIcon />
          Try it with made-up sample data
        </Button>
      </div>
    </div>
  );
}
