// The Automations page: the user's automations as cards, templates to start
// from, and the dialog that creates or edits one and lists its recent runs.

import {
  ArrowUpDownIcon,
  BinocularsIcon,
  CalendarIcon,
  ChevronDownIcon,
  ClockIcon,
  FolderIcon,
  InboxIcon,
  LightbulbIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SunriseIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  createAutomation,
  createAutomationInChat,
  DEFAULT_SCHEDULE,
  deleteAutomation,
  describeSchedule,
  formatWhen,
  liveRuns,
  markSeen,
  nextRunOf,
  runAutomation,
  TEMPLATES,
  updateAutomation,
  useAutomations,
  WEEKDAYS,
  type Automation,
  type AutomationDraft,
  type AutomationTemplate,
  type Frequency,
  type TemplateIcon,
} from "@/lib/automations";
import { useConversations } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspaces";

type Sort = "created" | "name" | "next";

/** What the dialog is open on: an existing automation, or a new one (maybe from a template). */
type Editing = { automation: Automation } | { draft: AutomationDraft };

const TEMPLATE_ICONS: Record<TemplateIcon, typeof SunriseIcon> = {
  sunrise: SunriseIcon,
  inbox: InboxIcon,
  calendar: CalendarIcon,
  "list-checks": ListChecksIcon,
  lightbulb: LightbulbIcon,
  binoculars: BinocularsIcon,
};

const blank = (): AutomationDraft => ({ name: "", prompt: "", schedule: { ...DEFAULT_SCHEDULE }, enabled: true });

const fromTemplate = (t: AutomationTemplate): AutomationDraft => ({
  name: t.name,
  prompt: t.prompt,
  schedule: { ...t.schedule },
  enabled: true,
});

export function AutomationsPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const automations = useAutomations();
  const [query, setQuery] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("created");
  const [editing, setEditing] = useState<Editing | null>(null);

  const q = query?.trim().toLowerCase() ?? "";
  const shown = automations
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.prompt.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "next") return (nextRunOf(a)?.getTime() ?? Infinity) - (nextRunOf(b)?.getTime() ?? Infinity);
      return b.createdAt - a.createdAt;
    });

  const open = (a: Automation) => {
    markSeen(a.id);
    setEditing({ automation: a });
  };
  const runNow = (a: Automation) => {
    const id = runAutomation(a.id);
    if (id) onOpenSession(id);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-8 pt-12 pb-16">
        <header className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-tight">Automations</h1>
            <p className="mt-2 text-muted-foreground">Run prompts on a schedule or whenever you need them.</p>
          </div>
          <div className="flex items-center gap-1">
            {query === null ? (
              <Button variant="ghost" size="icon" aria-label="Search automations" onClick={() => setQuery("")}>
                <SearchIcon />
              </Button>
            ) : (
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
                  placeholder="Search"
                  aria-label="Search automations"
                  className="h-8 w-48 pr-8 pl-8"
                />
                <button
                  type="button"
                  aria-label="Close search"
                  onClick={() => setQuery(null)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Sort automations">
                  <ArrowUpDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                  <DropdownMenuRadioItem value="created">Recently created</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="next">Next run</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="ml-2">
                  New automation <ChevronDownIcon data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={createAutomationInChat}>
                  <SparklesIcon /> Create with Sush
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditing({ draft: blank() })}>
                  <SettingsIcon /> Set up manually
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {automations.length > 0 && (
          <section aria-label="Your automations" className="mt-10 grid gap-4 sm:grid-cols-2">
            {shown.map((a) => (
              <AutomationCard
                key={a.id}
                automation={a}
                onOpen={() => open(a)}
                onRun={() => runNow(a)}
                onToggle={() => updateAutomation(a.id, { enabled: !a.enabled })}
                onDelete={() => deleteAutomation(a.id)}
              />
            ))}
            {shown.length === 0 && <p className="text-sm text-muted-foreground">No automations match “{query}”.</p>}
          </section>
        )}

        <section aria-labelledby="automation-templates" className={cn(automations.length > 0 ? "mt-12 border-t border-dashed pt-10" : "mt-10")}>
          <h2 id="automation-templates" className="text-sm font-medium text-muted-foreground">
            {automations.length > 0 ? "Start from a template" : "No automations yet. Start from a template"}
          </h2>
          <div className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {TEMPLATES.map((t) => {
              const Icon = TEMPLATE_ICONS[t.icon];
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setEditing({ draft: fromTemplate(t) })}
                  className="flex gap-4 rounded-xl p-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card">
                    <Icon className="size-4.5 text-muted-foreground" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{t.name}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">{t.description}</span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ClockIcon className="size-3.5" /> {describeSchedule(t.schedule)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <p className="mt-12 text-xs text-muted-foreground">
          Automations run while Sush is open. A run missed while it was closed happens once when you open it again.
        </p>
      </div>

      {editing && (
        <AutomationDialog
          key={"automation" in editing ? editing.automation.id : "new"}
          editing={editing}
          onClose={() => setEditing(null)}
          onOpenSession={(id) => {
            setEditing(null);
            onOpenSession(id);
          }}
        />
      )}
    </div>
  );
}

function AutomationCard({
  automation: a,
  onOpen,
  onRun,
  onToggle,
  onDelete,
}: {
  automation: Automation;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const workspaces = useWorkspaces();
  const folder = a.workspaceId ? workspaces.find((w) => w.id === a.workspaceId)?.name ?? "Missing folder" : null;
  const next = nextRunOf(a);
  return (
    <div className="group relative flex flex-col rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40">
      {/* The whole card opens it; the menu sits above this button. */}
      <button type="button" onClick={onOpen} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="sr-only">Edit {a.name}</span>
      </button>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">{a.name}</h3>
        {a.unseen && <span className="size-2 shrink-0 rounded-full bg-brand" aria-label="New run" title="New run" />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`${a.name} options`} className="relative -my-1 text-muted-foreground">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={onRun}>
              <PlayIcon /> Run now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpen}>
              <PencilIcon /> Edit
            </DropdownMenuItem>
            {a.schedule.frequency !== "manual" && (
              <DropdownMenuItem onSelect={onToggle}>
                {a.enabled ? <PauseIcon /> : <PlayIcon />} {a.enabled ? "Pause" : "Resume"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{a.prompt}</p>
      <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
        <span
          className={cn(
            "rounded-md px-2 py-0.5",
            a.enabled || a.schedule.frequency === "manual"
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "bg-muted text-muted-foreground line-through",
          )}
        >
          {describeSchedule(a.schedule)}
        </span>
        {!a.enabled && a.schedule.frequency !== "manual" && <span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">Paused</span>}
        <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-muted-foreground">
          {folder ? <FolderIcon className="size-3" /> : <MessagesSquareIcon className="size-3" />} {folder ?? "Chat"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {next ? `Next: ${formatWhen(next)}` : a.lastRunAt ? `Last run ${formatWhen(new Date(a.lastRunAt))}` : "Not run yet"}
        </span>
      </div>
    </div>
  );
}

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "manual", label: "Manually" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
];

const CHAT = "chat";

function AutomationDialog({
  editing,
  onClose,
  onOpenSession,
}: {
  editing: Editing;
  onClose: () => void;
  onOpenSession: (id: string) => void;
}) {
  const existing = "automation" in editing ? editing.automation : null;
  const [draft, setDraft] = useState<AutomationDraft>(() => {
    if (!existing) return (editing as { draft: AutomationDraft }).draft;
    const { name, prompt, schedule, workspaceId, enabled } = existing;
    return { name, prompt, schedule, workspaceId, enabled };
  });
  const workspaces = useWorkspaces();
  const conversations = useConversations();
  const runs = existing ? liveRuns(existing).slice(0, 5) : [];
  const set = (patch: Partial<AutomationDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setSchedule = (patch: Partial<AutomationDraft["schedule"]>) => set({ schedule: { ...draft.schedule, ...patch } });
  const valid = draft.name.trim() !== "" && draft.prompt.trim() !== "";
  const { frequency } = draft.schedule;

  const save = () => {
    const clean = { ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() };
    if (existing) updateAutomation(existing.id, clean);
    else createAutomation(clean);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100svh-4rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>Each run starts a new session with this prompt.</DialogDescription>
        </DialogHeader>

        {/* Only the body scrolls, so the scrollbar starts below the close button. */}
        <div className="-mx-4 -my-1 grid min-h-0 gap-4 overflow-y-auto px-4 py-1">
          <form
            id="automation-form"
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) save();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="automation-name">Name</Label>
              <Input id="automation-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Daily briefing" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="automation-prompt">Prompt</Label>
              <Textarea
                id="automation-prompt"
                value={draft.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
                placeholder="What should Sush do each time? Include every detail; each run starts fresh."
                className="min-h-32"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Repeats</Label>
                <Select value={frequency} onValueChange={(v) => setSchedule({ frequency: v as Frequency })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FREQUENCIES.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {frequency === "weekly" && (
                <div className="grid gap-2">
                  <Label>On</Label>
                  <Select value={String(draft.schedule.day)} onValueChange={(v) => setSchedule({ day: Number(v) })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(frequency === "daily" || frequency === "weekdays" || frequency === "weekly") && (
                <div className="grid gap-2">
                  <Label htmlFor="automation-time">At</Label>
                  <Input
                    id="automation-time"
                    type="time"
                    value={draft.schedule.time}
                    onChange={(e) => e.target.value && setSchedule({ time: e.target.value })}
                  />
                </div>
              )}
              <div className="grid gap-2">
                <Label>Runs in</Label>
                <Select value={draft.workspaceId ?? CHAT} onValueChange={(v) => set({ workspaceId: v === CHAT ? undefined : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CHAT}>
                      <MessagesSquareIcon /> Chat
                    </SelectItem>
                    {workspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        <FolderIcon /> {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {frequency !== "manual" && (
              <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span>
                  <span className="block font-medium">On schedule</span>
                  <span className="text-xs text-muted-foreground">
                    {draft.enabled ? describeSchedule(draft.schedule) : "Paused. Run it yourself from its menu."}
                  </span>
                </span>
                <Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />
              </label>
            )}
          </form>

          {existing && (
            <section aria-labelledby="automation-runs" className="grid gap-1">
              <h3 id="automation-runs" className="text-xs font-medium text-muted-foreground">
                Recent runs
              </h3>
              {runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
              {runs.map((r) => (
                <button
                  key={r.threadId}
                  type="button"
                  onClick={() => onOpenSession(r.threadId)}
                  className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">{conversations.find((c) => c.id === r.threadId)?.title ?? existing.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(new Date(r.at))}</span>
                </button>
              ))}
            </section>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {existing ? (
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={() => {
                  deleteAutomation(existing.id);
                  onClose();
                }}
              >
                <Trash2Icon /> Delete
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const id = runAutomation(existing.id);
                  if (id) onOpenSession(id);
                }}
              >
                <PlayIcon /> Run now
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="automation-form" disabled={!valid}>
              {existing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
