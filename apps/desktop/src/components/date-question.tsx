// A date or date-range question on the `ask_user` card. The picked dates sit in one bar
// above the calendar, and the calendar does the rest: pressing or dragging across days
// picks them, and a month's name opens the year to jump far ahead. Under it, typing
// ("jan 15 for 2 weeks") or a shortcut does the same, and all of them stay in step.

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AskUserQuestion, TravelDetails } from "@/lib/ask-user";
import { addDays, addMonths, daysBetween, firstDayOfWeek, firstOfMonth, formatDay, fromDay, parseDays, today, type DayRange } from "@/lib/dates";
import { CABINS, MAX_PASSENGERS } from "@/lib/flights";
import type { Cabin } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** How far ahead the calendar goes when the question sets no last date. */
const MONTHS_AHEAD = 18;
/** The card's own width, not the window's, since panels can narrow the chat. */
const TWO_MONTHS_FROM = 480;

function monthCells(month: string, weekStart: number) {
  const first = fromDay(month);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  // Always six rows, so the card doesn't change height between months.
  return Array.from({ length: 42 }, (_, i) => (i >= lead && i < lead + length ? addDays(month, i - lead) : null));
}

function weekendFrom(now: string, weeks: number): DayRange {
  const friday = addDays(now, ((5 - fromDay(now).getDay() + 7) % 7) + weeks * 7);
  return { start: friday, end: addDays(friday, 2) };
}

/** Shortcuts for a question whose model didn't suggest any. */
function defaultSuggestions(isRange: boolean, now: string): { label: string; start: string; end?: string }[] {
  if (isRange) {
    return [
      { label: "This weekend", ...weekendFrom(now, 0) },
      { label: "Next weekend", ...weekendFrom(now, 1) },
    ];
  }
  return [
    { label: "Today", start: now },
    { label: "Tomorrow", start: addDays(now, 1) },
    { label: "In a week", start: addDays(now, 7) },
  ];
}

function TripRadio({ name, label, checked, tabbable, onSelect }: { name: string; label: string; checked: boolean; tabbable: boolean; onSelect: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
      <input type="radio" name={name} checked={checked} tabIndex={tabbable ? 0 : -1} onChange={onSelect} className="peer sr-only" />
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-brand/50",
          checked ? "border-brand" : "border-muted-foreground/40",
        )}
      >
        <span className="size-2 rounded-full bg-brand transition-transform duration-150" style={{ transform: checked ? "scale(1)" : "scale(0)" }} />
      </span>
      <span className={checked ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </label>
  );
}

function BarLabel({ children }: { children: ReactNode }) {
  return <span className="block text-xs text-muted-foreground">{children}</span>;
}

function DateSegment({ label, value, active, tabbable, onClick }: { label: string; value?: string; active: boolean; tabbable: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={active}
      onClick={onClick}
      className={cn("min-w-0 flex-1 px-3 py-2 text-left transition-colors outline-none focus-visible:bg-accent", active ? "bg-muted" : "hover:bg-muted/50")}
    >
      <BarLabel>{label}</BarLabel>
      <span className={cn("block truncate text-sm", value ? "font-medium" : "text-muted-foreground")}>{value ? formatDay(value) : "Pick a date"}</span>
    </button>
  );
}

const CHEVRON = "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-30";

function Stepper({ label, noun, value, min, max, tabbable, onChange }: { label: string; noun: string; value: number; min: number; max: number; tabbable: boolean; onChange: (value: number) => void }) {
  return (
    <div role="group" aria-label={label} className="min-w-0 bg-card px-3 py-2">
      <BarLabel>{label}</BarLabel>
      <div className="flex h-6 items-center justify-between gap-2">
        <button type="button" aria-label={`One less ${noun}`} tabIndex={tabbable ? 0 : -1} disabled={value <= min} onClick={() => onChange(value - 1)} className={cn(CHEVRON, "size-6 rounded-md")}>
          <MinusIcon className="size-3.5" />
        </button>
        <span aria-live="polite" className="text-sm font-medium tabular-nums">
          {value}
        </span>
        <button type="button" aria-label={`One more ${noun}`} tabIndex={tabbable ? 0 : -1} disabled={value >= max} onClick={() => onChange(value + 1)} className={cn(CHEVRON, "size-6 rounded-md")}>
          <PlusIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Who's traveling and in what class, under a flight's dates. The search takes nine people at most. */
function TravelBar({ travel, wide, tabbable, onChange }: { travel: TravelDetails; wide: boolean; tabbable: boolean; onChange: (travel: TravelDetails) => void }) {
  const room = MAX_PASSENGERS - travel.adults - travel.children;
  return (
    // The gap shows the border color, so the lines between segments hold however they wrap.
    <div className={cn("grid gap-px overflow-hidden rounded-xl border border-border bg-border", wide ? "grid-cols-[1fr_1fr_1.5fr]" : "grid-cols-2")}>
      <Stepper label="Adults" noun="adult" value={travel.adults} min={1} max={travel.adults + room} tabbable={tabbable} onChange={(adults) => onChange({ ...travel, adults })} />
      <Stepper label="Children (2 to 11)" noun="child" value={travel.children} min={0} max={travel.children + room} tabbable={tabbable} onChange={(children) => onChange({ ...travel, children })} />
      <div className={cn("min-w-0 bg-card px-3 py-2", !wide && "col-span-2")}>
        <BarLabel>Class</BarLabel>
        <Select value={travel.cabin} onValueChange={(cabin) => onChange({ ...travel, cabin: cabin as Cabin })}>
          <SelectTrigger aria-label="Class" tabIndex={tabbable ? 0 : -1} className="w-full rounded-md border-0 bg-transparent p-0 font-medium data-[size=default]:h-6 dark:bg-transparent dark:hover:bg-transparent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {Object.entries(CABINS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

interface Props {
  question: AskUserQuestion;
  range: DayRange | null;
  typed: string;
  /** Hidden while another question of the card is showing. */
  active: boolean;
  /** On a question whose last date is optional: the user chose to leave it out. */
  noEnd: boolean;
  onNoEnd: (noEnd: boolean) => void;
  /** On a flight's dates: who's traveling and in what class. */
  travel?: TravelDetails;
  onTravel: (travel: TravelDetails) => void;
  onChange: (range: DayRange | null, typed: string) => void;
  onEnter: () => void;
}

export function DateQuestion({ question, range, typed, active, noEnd, onNoEnd, travel, onTravel, onChange, onEnter }: Props) {
  const now = today();
  const isRange = question.type === "date-range" && !noEnd;
  const radioName = useId();
  const min = question.minDate ?? now;
  const firstMonth = firstOfMonth(min);
  const lastMonth = firstOfMonth(question.maxDate ?? addMonths(firstMonth, MONTHS_AHEAD - 1));
  const allowed = (day: string) => day >= min && (!question.maxDate || day <= question.maxDate);

  const reduced = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const [view, setView] = useState(() => firstOfMonth(range?.start ?? question.opensOn ?? min));
  const [direction, setDirection] = useState(1);
  const [slot, setSlot] = useState<"start" | "end">(range?.start && !range.end ? "end" : "start");
  const [hover, setHover] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState(() => range?.start ?? min);
  const [width, setWidth] = useState(0);
  /** The year being looked at, while the months are showing instead of the days. */
  const [yearView, setYearView] = useState<number | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  const dragFrom = useRef<string | null>(null);
  // After a finished range the next press starts a new one, unless the first date was
  // pressed to change it alone.
  const editingStart = useRef(false);
  const latestHover = useRef(hover);
  latestHover.current = hover;

  const weekStart = firstDayOfWeek();
  const monthsShown = width >= TWO_MONTHS_FROM ? 2 : 1;
  const lastView = monthsShown === 2 && lastMonth > firstMonth ? addMonths(lastMonth, -1) : lastMonth;

  const goTo = (month: string) => {
    const allowedMonth = month > lastView ? lastView : month < firstMonth ? firstMonth : month;
    setDirection(allowedMonth > view ? 1 : -1);
    setView(allowedMonth);
  };

  const show = (day: string) => {
    const month = firstOfMonth(day);
    // A day already on screen stays where it is.
    if (month === view || (monthsShown === 2 && month === addMonths(view, 1))) return;
    goTo(month);
  };

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    root.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, view]);

  // The button that opened the months has gone, so focus moves with them, and back after.
  const yearOpen = yearView !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (yearOpen) root.current?.querySelector<HTMLElement>('[data-year-month][aria-current], [data-year-month]:not(:disabled)')?.focus();
    else if (wasOpen.current) root.current?.querySelector<HTMLElement>("[data-month-title]")?.focus();
    wasOpen.current = yearOpen;
  }, [yearOpen]);

  // A drag ends wherever the pointer lets go, even off the calendar.
  useEffect(() => {
    const up = () => {
      const from = dragFrom.current;
      dragFrom.current = null;
      const to = latestHover.current;
      if (from && to && to > from) {
        onChange({ start: from, end: to }, "");
        setSlot("start");
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [onChange]);

  const pick = (day: string) => {
    setFocusDay(day);
    if (!isRange) {
      onChange({ start: day }, "");
      return;
    }
    if (slot === "end" && range?.start && day >= range.start) {
      onChange({ start: range.start, end: day }, "");
      setSlot("start");
      return;
    }
    const keepsEnd = slot === "start" && editingStart.current && range?.end && day <= range.end;
    editingStart.current = false;
    onChange({ start: day, end: keepsEnd ? range?.end : undefined }, "");
    setSlot(keepsEnd ? "start" : "end");
    if (!keepsEnd) dragFrom.current = day;
  };

  const onDayKey = (event: KeyboardEvent, day: string) => {
    const weekday = (fromDay(day).getDay() - weekStart + 7) % 7;
    const moves: Record<string, string> = {
      ArrowLeft: addDays(day, -1),
      ArrowRight: addDays(day, 1),
      ArrowUp: addDays(day, -7),
      ArrowDown: addDays(day, 7),
      Home: addDays(day, -weekday),
      End: addDays(day, 6 - weekday),
      PageUp: addMonths(day, -1),
      PageDown: addMonths(day, 1),
    };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    if (!allowed(next) || firstOfMonth(next) > lastMonth) return;
    moveFocus.current = true;
    setFocusDay(next);
    setHover(next);
    show(next);
  };

  const type = (text: string) => {
    const parsed = parseDays(text);
    const usable = parsed && allowed(parsed.start) && (!parsed.end || allowed(parsed.end)) ? parsed : null;
    // Typing a whole range on a one-way trip means they've changed their mind.
    const wantsEnd = !!usable?.end && question.type === "date-range";
    if (wantsEnd && noEnd) onNoEnd(false);
    const shaped = usable && (isRange || wantsEnd ? usable : { start: usable.start });
    onChange(shaped, text);
    if (shaped) {
      setYearView(null);
      show(shaped.start);
      setFocusDay(shaped.start);
      setSlot((isRange || wantsEnd) && !shaped.end ? "end" : "start");
    }
  };

  const months = Array.from({ length: monthsShown }, (_, i) => addMonths(view, i));

  // While only the start is picked, the range follows the pointer to show what it would be.
  const shownEnd = range?.end ?? (isRange && slot === "end" && range?.start && hover && hover > range.start ? hover : undefined);
  const count = range?.start && shownEnd ? daysBetween(range.start, shownEnd) : null;
  const length = count === null ? null : question.unit === "nights" ? count : count + 1;
  const suggestions = question.suggestions.length > 0 ? question.suggestions : defaultSuggestions(isRange, now);
  const tabbable = active;
  const typedOnly = typed.trim() !== "" && !range;

  const tripRadios = question.noEndLabel && (
    <div role="radiogroup" aria-label="Trip type" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <TripRadio
        name={radioName}
        label={question.withEndLabel ?? `With ${(question.endLabel ?? "end date").toLowerCase()}`}
        checked={!noEnd}
        tabbable={tabbable}
        onSelect={() => {
          onNoEnd(false);
          setSlot(range?.start ? "end" : "start");
        }}
      />
      <TripRadio
        name={radioName}
        label={question.noEndLabel}
        checked={noEnd}
        tabbable={tabbable}
        onSelect={() => {
          onNoEnd(true);
          setSlot("start");
          if (range?.end) onChange({ start: range.start }, "");
        }}
      />
    </div>
  );

  const dateBar = (
    <div className="flex items-stretch divide-x divide-border overflow-hidden rounded-xl border border-border">
      <DateSegment
        label={question.startLabel ?? (isRange ? "From" : "Date")}
        value={range?.start}
        active={!isRange || slot === "start"}
        tabbable={tabbable}
        onClick={() => {
          setSlot("start");
          editingStart.current = true;
          if (range?.start) show(range.start);
        }}
      />
      {isRange && (
        <>
          <DateSegment
            label={question.endLabel ?? "To"}
            value={range?.end}
            active={slot === "end"}
            tabbable={tabbable}
            onClick={() => {
              setSlot("end");
              if (range?.end) show(range.end);
            }}
          />
          <div className="flex w-20 shrink-0 flex-col justify-center px-3 py-2" aria-live="polite">
            <BarLabel>{question.unit === "nights" ? "Nights" : "Days"}</BarLabel>
            <span className={cn("text-sm tabular-nums", length === null ? "text-muted-foreground" : "font-medium")}>{length ?? "–"}</span>
          </div>
        </>
      )}
    </div>
  );

  const openYear = () => setYearView(fromDay(view).getFullYear());

  const yearGrid = yearView !== null && (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setYearView(null);
        }
      }}
    >
      <div className="flex h-8 items-center justify-between">
        <button type="button" aria-label="Previous year" tabIndex={tabbable ? 0 : -1} disabled={yearView <= fromDay(firstMonth).getFullYear()} onClick={() => setYearView(yearView - 1)} className={CHEVRON}>
          <ChevronLeftIcon className="size-4" />
        </button>
        <p className="text-sm font-medium tabular-nums">{yearView}</p>
        <button type="button" aria-label="Next year" tabIndex={tabbable ? 0 : -1} disabled={yearView >= fromDay(lastMonth).getFullYear()} onClick={() => setYearView(yearView + 1)} className={CHEVRON}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
      {/* The same height as the days, so opening it doesn't move the card. */}
      <div className="mt-1 grid h-60 grid-cols-4 grid-rows-3 gap-1">
        {Array.from({ length: 12 }, (_, i) => {
          const month = `${yearView}-${String(i + 1).padStart(2, "0")}-01`;
          const onScreen = months.includes(month);
          const chosen = !!range?.start && firstOfMonth(range.start) <= month && firstOfMonth(shownEnd ?? range.start) >= month;
          return (
            <button
              key={month}
              type="button"
              data-year-month
              tabIndex={tabbable ? 0 : -1}
              disabled={month < firstMonth || month > lastMonth}
              aria-current={onScreen ? "true" : undefined}
              aria-label={formatDay(month, { month: "long", year: "numeric" })}
              onClick={() => {
                goTo(month);
                setYearView(null);
              }}
              className={cn(
                "rounded-lg text-[13px] transition-colors outline-none enabled:hover:bg-accent focus-visible:ring-2 focus-visible:ring-brand/50 disabled:text-muted-foreground/40",
                onScreen && "bg-muted font-medium",
                chosen && "font-medium text-brand",
              )}
            >
              {formatDay(month, { month: "short" })}
            </button>
          );
        })}
      </div>
    </div>
  );

  const calendar = (
    <div className="flex gap-8 select-none" onPointerLeave={() => setHover(null)}>
      {months.map((month, m) => {
        const cells = monthCells(month, weekStart);
        const label = formatDay(month, { month: "long", year: "numeric" });
        return (
          <div key={m} className="min-w-0 flex-1">
            <div className="flex h-8 items-center justify-between">
              {m === 0 ? (
                <button type="button" aria-label="Previous month" tabIndex={tabbable ? 0 : -1} disabled={view <= firstMonth} onClick={() => goTo(addMonths(view, -1))} className={CHEVRON}>
                  <ChevronLeftIcon className="size-4" />
                </button>
              ) : (
                <span className="size-8" />
              )}
              <button
                type="button"
                data-month-title
                tabIndex={tabbable ? 0 : -1}
                aria-label={`${label}, choose a month`}
                onClick={openYear}
                className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-brand/50"
              >
                {label}
                <ChevronDownIcon className="size-3 text-muted-foreground" aria-hidden />
              </button>
              {m === months.length - 1 ? (
                <button type="button" aria-label="Next month" tabIndex={tabbable ? 0 : -1} disabled={view >= lastView} onClick={() => goTo(addMonths(view, 1))} className={CHEVRON}>
                  <ChevronRightIcon className="size-4" />
                </button>
              ) : (
                <span className="size-8" />
              )}
            </div>
            <motion.div
              key={month}
              className="mt-1"
              initial={reduced ? false : { opacity: 0, transform: `translateX(${direction * 8}px)` }}
              animate={{ opacity: 1, transform: "translateX(0px)" }}
              transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            >
              <div className="grid h-6 grid-cols-7 items-center text-center text-[11px] text-muted-foreground" aria-hidden>
                {Array.from({ length: 7 }, (_, i) => (
                  <span key={i}>{formatDay(addDays("2027-01-03", weekStart + i), { weekday: "short" }).slice(0, 2)}</span>
                ))}
              </div>
              <div role="grid" aria-label={label}>
                {Array.from({ length: 6 }, (_, row) => (
                  <div role="row" key={row} className="grid grid-cols-7">
                    {cells.slice(row * 7, row * 7 + 7).map((day, column) => {
                      if (!day) return <span role="gridcell" key={column} className="h-9" />;
                      const isStart = day === range?.start;
                      const isEnd = day === range?.end;
                      const banded = !!range?.start && !!shownEnd && shownEnd > range.start && day >= range.start && day <= shownEnd;
                      const lastOfMonth = fromDay(addDays(day, 1)).getDate() === 1;
                      const can = allowed(day);
                      return (
                        <div role="gridcell" aria-selected={isStart || isEnd || banded} key={day} className="relative flex h-9 items-center justify-center">
                          {banded && (
                            <span
                              className={cn(
                                // Solid and overlapping, or cells of fractional width leave seams.
                                "absolute inset-y-0.5 bg-[color-mix(in_oklab,var(--brand)_14%,var(--card))]",
                                day === range?.start ? "-right-px left-1/2" : day === shownEnd ? "right-1/2 -left-px" : "-inset-x-px",
                                day !== range?.start && (column === 0 || fromDay(day).getDate() === 1) && "rounded-l-lg",
                                day !== shownEnd && (column === 6 || lastOfMonth) && "rounded-r-lg",
                              )}
                            />
                          )}
                          <button
                            type="button"
                            data-day={day}
                            disabled={!can}
                            tabIndex={tabbable && day === focusDay ? 0 : -1}
                            aria-label={formatDay(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                            aria-current={day === now ? "date" : undefined}
                            onPointerDown={(event) => {
                              if (event.button === 0) pick(day);
                            }}
                            // A click with no pointer behind it is the keyboard.
                            onClick={(event) => {
                              if (event.detail === 0) pick(day);
                            }}
                            onPointerEnter={() => can && setHover(day)}
                            onKeyDown={(event) => onDayKey(event, day)}
                            className={cn(
                              "relative flex size-8 items-center justify-center rounded-lg text-[13px] tabular-nums transition-[transform,background-color] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-95 disabled:text-muted-foreground/40",
                              isStart || isEnd ? "bg-brand font-medium text-brand-foreground dark:text-neutral-950" : can && !(day === shownEnd && banded) && "hover:bg-accent",
                              !isStart && !isEnd && day === shownEnd && banded && "ring-1 ring-brand",
                            )}
                          >
                            {fromDay(day).getDate()}
                            {day === now && <span className={cn("absolute bottom-1 size-1 rounded-full", isStart || isEnd ? "bg-current" : "bg-brand")} aria-hidden />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div ref={root} className="mt-3 flex flex-col gap-3 pb-0.5">
      {tripRadios}
      {dateBar}
      {travel && <TravelBar travel={travel} wide={monthsShown === 2} tabbable={tabbable} onChange={onTravel} />}
      {yearGrid || calendar}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 transition-colors focus-within:border-brand/60">
        <input
          value={typed}
          tabIndex={tabbable ? 0 : -1}
          onChange={(event) => type(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed.trim()) {
              event.preventDefault();
              onEnter();
            }
          }}
          placeholder={isRange ? "Or type it: Jan 15 for 2 weeks" : "Or type it: next Friday"}
          aria-label="Type a date"
          className="min-w-48 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-3">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              tabIndex={tabbable ? 0 : -1}
              onClick={() => {
                if (suggestion.end && noEnd) onNoEnd(false);
                onChange({ start: suggestion.start, end: suggestion.end }, "");
                setFocusDay(suggestion.start);
                setSlot("start");
                setYearView(null);
                show(suggestion.start);
              }}
              className="text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
        {typedOnly && <p className="basis-full text-xs text-muted-foreground">That isn't a date I can place, so it goes as you wrote it.</p>}
      </div>
    </div>
  );
}
