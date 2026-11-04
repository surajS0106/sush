// Calendar days as `YYYY-MM-DD` strings, which sort and compare correctly, with no time
// zone to get wrong, and what the date picker sends to the model. Also reads dates as
// people type them: "next friday", "jan 15 to mar 10", "mar 3 for 2 weeks".

const DAY_MS = 86_400_000;

export const toDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const fromDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
};

export const isDay = (value: unknown): boolean => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && toDay(fromDay(value)) === value;

export const addDays = (day: string, days: number) => {
  const date = fromDay(day);
  return toDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
};

/** The same day some months on, or the month's last day if it's shorter. */
export const addMonths = (day: string, months: number) => {
  const date = fromDay(day);
  const last = new Date(date.getFullYear(), date.getMonth() + months + 1, 0).getDate();
  return toDay(new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), last)));
};

export const daysBetween = (from: string, to: string) => Math.round((fromDay(to).getTime() - fromDay(from).getTime()) / DAY_MS);

export const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;

export const today = () => toDay(new Date());

/** 0 for Sunday, from the user's region. */
export function firstDayOfWeek() {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 7) % 7;
  } catch {
    return 0;
  }
}

export const formatDay = (day: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) => fromDay(day).toLocaleDateString(undefined, options);

export interface DayRange {
  start: string;
  end?: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

const monthIndex = (word: string) => MONTHS.indexOf(word.slice(0, 3));
const weekdayIndex = (word: string) => WEEKDAYS.indexOf(word.slice(0, 3));
const countOf = (word: string) => NUMBER_WORDS[word] ?? Number(word);

function nextWeekday(from: string, weekday: number, skipThisWeek: boolean) {
  const gap = (weekday - fromDay(from).getDay() + 7) % 7;
  // "friday" is the coming one, today included. "next friday" is never within the next few days.
  return addDays(from, skipThisWeek && gap < 7 ? gap + 7 : gap);
}

function offset(day: string, count: number, unit: string) {
  if (unit.startsWith("day") || unit.startsWith("night")) return addDays(day, count);
  if (unit.startsWith("week")) return addDays(day, count * 7);
  if (unit.startsWith("month")) return addMonths(day, count);
  return null;
}

/** A month and day with no year means the next time it comes round. */
function dated(month: number, date: number, year: number | null, now: string) {
  if (month < 0 || date < 1 || date > 31) return null;
  const on = (y: number) => {
    const made = toDay(new Date(y, month, date));
    return fromDay(made).getMonth() === month ? made : null;
  };
  const nowYear = fromDay(now).getFullYear();
  if (year !== null) return on(year);
  const thisYear = on(nowYear);
  return thisYear && thisYear >= now ? thisYear : on(nowYear + 1);
}

/** Whether the user's region writes the day first in 15/1. */
function dayFirst() {
  const parts = new Intl.DateTimeFormat().formatToParts(new Date(2027, 0, 15));
  return parts.findIndex((p) => p.type === "day") < parts.findIndex((p) => p.type === "month");
}

function parseOne(text: string, now: string): string | null {
  if (isDay(text)) return text;
  if (text === "today") return now;
  if (text === "tomorrow") return addDays(now, 1);

  let match = text.match(/^in (\d+|an?|one|two|three|four|five|six) (days?|weeks?|months?)$/);
  if (match) return offset(now, countOf(match[1]), match[2]);
  if (text === "next week") return nextWeekday(now, firstDayOfWeek(), false) === now ? addDays(now, 7) : nextWeekday(now, firstDayOfWeek(), false);
  if (text === "next month") return addMonths(firstOfMonth(now), 1);

  match = text.match(/^(this |next |on )?([a-z]+)$/);
  if (match && weekdayIndex(match[2]) >= 0 && match[2].length >= 3 && "sunday monday tuesday wednesday thursday friday saturday".includes(match[2])) {
    return nextWeekday(now, weekdayIndex(match[2]), match[1] === "next ");
  }

  // "jan 15", "january 15th 2027"
  match = text.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/);
  if (match) return dated(monthIndex(match[1]), Number(match[2]), match[3] ? Number(match[3]) : null, now);
  // "15 jan", "15th of january 2027"
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]{3,9})\.?(?:,? (\d{4}))?$/);
  if (match) return dated(monthIndex(match[2]), Number(match[1]), match[3] ? Number(match[3]) : null, now);
  // "january" alone is its first day, the next time it comes round.
  match = text.match(/^([a-z]{3,9})(?: (\d{4}))?$/);
  if (match && monthIndex(match[1]) >= 0 && "january february march april may june july august september october november december".includes(match[1])) {
    return dated(monthIndex(match[1]), 1, match[2] ? Number(match[2]) : null, now);
  }
  // "1/15", "1/15/27", in the order the user's region writes them.
  match = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (match) {
    const [month, date] = dayFirst() ? [match[2], match[1]] : [match[1], match[2]];
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : null;
    return dated(Number(month) - 1, Number(date), year, now);
  }
  return null;
}

/** What someone typed as a day or a range, or null if it doesn't read as one. */
export function parseDays(typed: string, now = today()): DayRange | null {
  const text = typed.trim().toLowerCase().replace(/\s+/g, " ").replace(/^from /, "");
  if (!text) return null;

  if (text === "this weekend" || text === "next weekend") {
    const friday = nextWeekday(now, 5, text === "next weekend");
    return { start: friday, end: addDays(friday, 2) };
  }

  // "mar 3 for 2 weeks"
  let match = text.match(/^(.+?) for (\d+|an?|one|two|three|four|five|six) (days?|nights?|weeks?|months?)$/);
  if (match) {
    const start = parseOne(match[1], now);
    const end = start && offset(start, countOf(match[2]), match[3]);
    return start && end ? { start, end } : null;
  }

  // "jan 15 to mar 10", "jan 15 - 20", "jan 15 until feb"
  // Words first, since a bare hyphen could be inside a date like 2027-01-15.
  match =
    text.match(/^(.+?) (?:to|until|till|through) (.+)$/) ??
    text.match(/^(.+?)\s*(?:–|—| - )\s*(.+)$/) ??
    (/\d{4}-/.test(text) ? null : text.match(/^(.+?)-(.+)$/));
  if (match) {
    const start = parseOne(match[1], now);
    if (!start) return null;
    // A bare number is a day in the first date's month, or the next one if that's already past.
    let end: string | null;
    if (/^\d{1,2}$/.test(match[2])) {
      const date = Number(match[2]);
      const inMonth = toDay(new Date(fromDay(start).getFullYear(), fromDay(start).getMonth(), date));
      end = inMonth >= start ? inMonth : addMonths(inMonth, 1);
    } else {
      end = parseOne(match[2], start);
    }
    return end && end >= start ? { start, end } : null;
  }

  const start = parseOne(text, now);
  return start ? { start } : null;
}
