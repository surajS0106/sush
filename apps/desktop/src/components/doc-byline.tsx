// The line under a doc's title: its date, which opens a calendar to change it, and the
// people who wrote it as overlapping avatars (you, from your account; Sush, as your
// mascot), which open a list of who wrote what and when.

import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { MascotSprite } from "@/components/mascot";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UserAvatar } from "@/components/user-avatar";
import { useSession } from "@/lib/auth";
import { applyDoc } from "@/lib/docs";
import { useMascot } from "@/lib/mascot";
import { api, errorMessage, type Doc } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- dates ------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A `YYYY-MM-DD` as a local date (not UTC midnight, which shows as the day before west of Greenwich). */
const fromYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** The date a doc shows: the one picked, else the day it was started. */
const docDate = (doc: Doc) => doc.date ?? ymd(new Date(doc.createdAt));

async function setDate(doc: Doc, date: string | null) {
  try {
    applyDoc(await api.docSetDate(doc.id, date));
  } catch (e) {
    toast.error("Couldn’t change the date", { description: errorMessage(e) });
  }
}

/** A month grid; weeks start on the locale's first day where the browser says, else Monday. */
function MonthCalendar({ value, onPick }: { value: string; onPick: (date: string) => void }) {
  const [month, setMonth] = useState(() => {
    const d = fromYmd(value);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const weekStart = useMemo(() => {
    const info = (new Intl.Locale(navigator.language) as Intl.Locale & { weekInfo?: { firstDay: number } }).weekInfo;
    return (info?.firstDay ?? 1) % 7;
  }, []);
  const today = ymd(new Date());
  const days = useMemo(() => {
    const lead = (month.getDay() - weekStart + 7) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))] as (Date | null)[];
  }, [month, weekStart]);
  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + ((weekStart + i) % 7)).toLocaleDateString(undefined, { weekday: "narrow" })),
    [weekStart],
  );
  const step = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="text-sm font-medium" aria-live="polite">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <button type="button" aria-label="Next month" onClick={() => step(1)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
      <div role="grid" className="grid grid-cols-7 gap-0.5 text-center text-sm">
        {weekdays.map((w, i) => (
          <span key={i} className="pb-1 text-xs text-muted-foreground" aria-hidden>
            {w}
          </span>
        ))}
        {days.map((d, i) => {
          if (!d) return <span key={i} />;
          const key = ymd(d);
          const picked = key === value;
          return (
            <button
              key={i}
              type="button"
              aria-pressed={picked}
              aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              onClick={() => onPick(key)}
              className={cn(
                "flex size-8 items-center justify-center justify-self-center rounded-md tabular-nums hover:bg-accent",
                key === today && !picked && "font-semibold text-brand",
                picked && "bg-brand font-medium text-brand-foreground hover:bg-brand/90",
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DateChip({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState(false);
  const value = docDate(doc);
  const pick = (date: string | null) => {
    setOpen(false);
    void setDate(doc, date);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Date: ${fromYmd(value).toLocaleDateString()}. Change it`}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 -ml-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <CalendarIcon className="size-3.5" />
          {fromYmd(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto">
        <MonthCalendar value={value} onPick={pick} />
        <div className="mt-2 flex justify-between border-t pt-2 text-xs">
          <button type="button" onClick={() => pick(ymd(new Date()))} className="rounded-md px-2 py-1 hover:bg-accent">
            Today
          </button>
          {doc.date && (
            <button type="button" onClick={() => pick(null)} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              Use the day it was started
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- people -----------------------------------------------------------------------------

interface Person {
  key: "sush" | "user";
  name: string;
  versions: number;
  last: number;
}

function relative(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PeopleChip({ doc }: { doc: Doc }) {
  const kind = useMascot();
  const { data: session } = useSession();
  const user = session?.user;
  const people = useMemo(() => {
    const by = new Map<Person["key"], Person>();
    for (const v of doc.versions) {
      const key = v.author;
      const p = by.get(key) ?? { key, name: key === "sush" ? "Sush" : (user?.name?.trim() || "You"), versions: 0, last: 0 };
      p.versions++;
      p.last = Math.max(p.last, v.at);
      by.set(key, p);
    }
    // Whoever wrote most recently first.
    return [...by.values()].sort((a, b) => b.last - a.last);
  }, [doc.versions, user?.name]);

  const avatar = (p: Person, size: string) =>
    p.key === "sush" ? (
      <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted", size)}>
        <MascotSprite kind={kind} scale={0.32} />
      </span>
    ) : (
      <UserAvatar image={user?.image} name={user?.name} email={user?.email} className={cn(size, "text-[10px]")} />
    );

  const names = people.map((p) => (p.key === "user" ? "you" : p.name));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Written by ${names.join(" and ")}. See who wrote what`}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <span className="flex -space-x-1.5">
            {people.map((p) => (
              <span key={p.key} className="rounded-full ring-2 ring-background">
                {avatar(p, "size-5")}
              </span>
            ))}
          </span>
          {people.length === 1 ? people[0].name : `${people.length} people`}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">Written by</p>
        <ul>
          {people.map((p) => (
            <li key={p.key} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              {avatar(p, "size-7")}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {p.name}
                  {p.key === "user" && <span className="font-normal text-muted-foreground"> (you)</span>}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {p.versions} {p.versions === 1 ? "version" : "versions"} · last {relative(p.last)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function DocByline({ doc, className }: { doc: Doc; className?: string }) {
  return (
    <div className={cn("doc-byline flex flex-wrap items-center gap-1", className)}>
      <DateChip doc={doc} />
      <span aria-hidden className="text-muted-foreground/60">
        ·
      </span>
      <PeopleChip doc={doc} />
    </div>
  );
}
