// The `ask_user` tool: the model asks the user multiple-choice questions and
// waits for the answers. It runs in the UI (AskUserCard), not in Rust; the
// answers go back to the model as the tool result.

import { formatDay, isDay, parseDays, today } from "@/lib/dates";
import { CABINS, MAX_PASSENGERS } from "@/lib/flights";
import type { Cabin, ToolSpec } from "@/lib/tauri";

export const ASK_USER = "ask_user";

export const askUserTool: ToolSpec = {
  name: ASK_USER,
  description:
    "Ask the user one or more questions and wait for their answers. Use it when a choice " +
    "only the user can make would materially change your response, e.g. ambiguous requirements or " +
    "picking between approaches. Don't use it for things you can reasonably decide or infer yourself. " +
    "Questions are shown one at a time; the user can pick options, type their own answer, or skip a question. " +
    "Whenever you need a date, use `type` date or date-range, which shows a calendar. Never list months or dates as options. " +
    "A date answer is YYYY-MM-DD, a range answer is its start and end in that form, unless the user typed something else instead. " +
    "The card for a flight's dates also asks who's traveling and in what class, so its answer holds `travel`: { adults, children, cabin }.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, phrased for the user." },
            type: { type: "string", enum: ["choice", "date", "date-range"], description: "Defaults to choice. The fields below it say which type they're for." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: { type: "string" },
              description: "choice: required. Short answer choices. The user can also type a different answer. Never months or dates: use type date or date-range for those.",
            },
            multiSelect: { type: "boolean", description: "choice: allow picking more than one option. Defaults to false." },
            startLabel: { type: "string", description: "Dates: the first date's label, e.g. Depart or Check in." },
            endLabel: { type: "string", description: "date-range: the last date's label, e.g. Return or Check out." },
            noEndLabel: { type: "string", description: "date-range: set when the last date is optional, to what leaving it out means, e.g. One way. Shows a choice between the two, and the answer is then one date if they left it out." },
            withEndLabel: { type: "string", description: "date-range: with noEndLabel, the other choice, e.g. Round trip." },
            unit: { type: "string", enum: ["days", "nights"], description: "date-range: how to count its length. Use nights for trips and stays." },
            minDate: { type: "string", description: "Dates: the earliest allowed, YYYY-MM-DD. Defaults to today; set it for a date in the past." },
            maxDate: { type: "string", description: "Dates: the latest allowed, YYYY-MM-DD." },
            adults: { type: "integer", description: "A flight's dates: how many adults, only if the user already said. It starts the card's own control." },
            children: { type: "integer", description: "A flight's dates: how many children aged 2 to 11, only if the user already said." },
            cabin: { type: "string", enum: Object.keys(CABINS), description: "A flight's dates: the class, only if the user already said." },
            suggestions: {
              type: "array",
              maxItems: 4,
              description: "Dates: shortcuts that fit this question, e.g. a holiday or the dates the user mentioned. Leave out for general ones.",
              items: {
                type: "object",
                properties: { label: { type: "string" }, start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD" } },
                required: ["label", "start"],
              },
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
};

export interface AskUserSuggestion {
  label: string;
  start: string;
  end?: string;
}

export interface AskUserQuestion {
  question: string;
  type: "choice" | "date" | "date-range";
  options: string[];
  multiSelect: boolean;
  startLabel?: string;
  endLabel?: string;
  noEndLabel?: string;
  withEndLabel?: string;
  unit?: "days" | "nights";
  minDate?: string;
  maxDate?: string;
  /** Where the calendar opens, when it isn't the earliest date allowed. */
  opensOn?: string;
  suggestions: AskUserSuggestion[];
  /** On a flight's dates: who's traveling and in what class, as the card starts them. */
  travel?: TravelDetails;
}

export interface TravelDetails {
  adults: number;
  children: number;
  cabin: Cabin;
}

const DEFAULT_TRAVEL: TravelDetails = { adults: 1, children: 0, cabin: "economy" };

const asCount = (value: unknown, min: number, max: number, fallback: number) => (Number.isInteger(value) ? Math.min(Math.max(value as number, min), max) : fallback);

/** What the model said the user already told it, within what a search can take. */
function parseTravel(q: { adults?: unknown; children?: unknown; cabin?: unknown }): TravelDetails {
  const adults = asCount(q.adults, 1, MAX_PASSENGERS, DEFAULT_TRAVEL.adults);
  return {
    adults,
    children: asCount(q.children, 0, MAX_PASSENGERS - adults, DEFAULT_TRAVEL.children),
    cabin: typeof q.cabin === "string" && q.cabin in CABINS ? (q.cabin as Cabin) : DEFAULT_TRAVEL.cabin,
  };
}

/** "2 adults, 1 child · Business". */
export function travelText({ adults, children, cabin }: TravelDetails) {
  const who = [`${adults} ${adults === 1 ? "adult" : "adults"}`, children > 0 ? `${children} ${children === 1 ? "child" : "children"}` : null].filter(Boolean).join(", ");
  return `${who} · ${CABINS[cabin]}`;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined);

function parseSuggestions(raw: unknown): AskUserSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const label = text(item?.label);
    if (!label || !isDay(item.start) || (item.end !== undefined && (!isDay(item.end) || item.end < item.start))) return [];
    return [{ label: shortcutLabel(label), start: item.start, end: item.end }];
  }).slice(0, 4);
}

/** One entry per question, in order. `answer` is null when the user skipped it. */
export type AskUserOutput = { question: string; answer: string[] | null; travel?: TravelDetails }[];

const TRAVEL = /\b(depart\w*|leav\w*|travel\w*|fly\w*|flight\w*|trip\w*|return\w*|check.?in|check.?out|stay\w*)\b/i;
/** The heading for a flight's dates: models word it for departure alone, but it covers the return too. */
const TRIP_HEADING = "When are you traveling?";
const FLYING = /\b(depart\w*|fly\w*|flight\w*|leav\w*)\b/i;
const TRIP_TYPE = /\b(one.?way|round.?trip|return)\b/i;
const RETURNING = /\b(return\w*|back|check.?out)\b/i;
const TRAVELERS_OR_CLASS = /\b(passengers?|travell?ers?|how many (people|adults|of you)|cabin|class)\b/i;
/** A month with a day or year, or a full date. Not "1/2" or "Level 3", which could be anything. */
const DATED = /[a-z]{3}.*\d|\d.*[a-z]{3}|\d{4}-\d{2}-\d{2}/i;
const MONTH_ONLY = /^[a-z]+\.?(,? \d{4})?$/i;

/**
 * Models told to use a date question still sometimes list months as options, which can't
 * say which day. So a single choice whose options are nearly all dates becomes a calendar.
 * Bare words like "January" or "Friday" only count in a question about travel, since a
 * question about a report's month or a meeting's weekday is really a choice.
 */
function asDateQuestion(question: string, options: string[]): AskUserQuestion | null {
  const travel = TRAVEL.test(question);
  const dated = options.flatMap((option) => {
    const days = travel || DATED.test(option) ? parseDays(option) : null;
    return days ? [{ option, ...days }] : [];
  });
  if (dated.length < 2 || dated.length < (options.length - dated.length) * 2) return null;

  // A flight's departure takes the whole trip, with the return as a choice.
  const flight = !RETURNING.test(question) && FLYING.test(question);
  const isRange = flight || dated.some((d) => d.end);
  const earliest = dated.reduce((first, d) => (d.start < first ? d.start : first), today());
  return {
    question: flight ? TRIP_HEADING : question,
    type: isRange ? "date-range" : "date",
    options: [],
    multiSelect: false,
    startLabel: travel ? (!isRange && RETURNING.test(question) ? "Return" : "Depart") : undefined,
    endLabel: travel && isRange ? "Return" : undefined,
    noEndLabel: flight ? "One way" : undefined,
    withEndLabel: flight ? "Round trip" : undefined,
    unit: travel ? "nights" : "days",
    // Options in the past mean the question is about the past.
    minDate: earliest,
    opensOn: dated.reduce((first, d) => (d.start < first ? d.start : first), dated[0].start),
    // A month as a shortcut would pick its first day, which isn't what it offered. The ribbon covers those.
    suggestions: dated.filter((d) => !MONTH_ONLY.test(d.option)).slice(0, 4).map((d) => ({ label: shortcutLabel(d.option), start: d.start, end: d.end })),
  };
}

/** A shortcut's label, which a model may have written as a raw date. */
const shortcutLabel = (label: string) => (isDay(label) ? formatDay(label, { month: "short", day: "numeric" }) : label.slice(0, 60));

/** Validate the model's input; models occasionally send malformed arguments. */
export function parseAskUserInput(input: unknown): AskUserQuestion[] | null {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskUserQuestion[] = [];
  for (const q of raw) {
    if (typeof q?.question !== "string") return null;
    if (q.type === "date" || q.type === "date-range") {
      const offersOneWay = q.type === "date-range" && TRIP_TYPE.test(String(q.noEndLabel ?? ""));
      questions.push({
        question: offersOneWay ? TRIP_HEADING : q.question,
        type: q.type,
        options: [],
        multiSelect: false,
        startLabel: text(q.startLabel),
        endLabel: text(q.endLabel),
        noEndLabel: text(q.noEndLabel),
        withEndLabel: text(q.withEndLabel),
        unit: q.unit === "nights" ? "nights" : "days",
        minDate: isDay(q.minDate) ? q.minDate : undefined,
        maxDate: isDay(q.maxDate) ? q.maxDate : undefined,
        suggestions: parseSuggestions(q.suggestions),
        travel: offersOneWay || q.adults !== undefined || q.children !== undefined || q.cabin !== undefined ? parseTravel(q) : undefined,
      });
      continue;
    }
    if (!Array.isArray(q.options)) return null;
    const options = q.options.filter((o: unknown): o is string => typeof o === "string" && o.trim() !== "");
    if (options.length === 0) return null;
    const asDate = q.multiSelect === true ? null : asDateQuestion(q.question, options);
    if (asDate) {
      questions.push(asDate.noEndLabel ? { ...asDate, travel: parseTravel(q) } : asDate);
      continue;
    }
    questions.push({ question: q.question, type: "choice", options, multiSelect: q.multiSelect === true, suggestions: [] });
  }
  return withoutCovered(questions);
}

/** Whether a date question is about a flight's dates, however it's worded. */
const isTripDates = (q: AskUserQuestion) => q.type !== "choice" && (q.question === TRIP_HEADING || FLYING.test(q.question) || RETURNING.test(q.question));

/**
 * One calendar covers a whole trip, so a model asking for the month, then the exact day,
 * then the return, gets one question. A question about the trip type goes too, since the
 * calendar offers that as well, and one about who's traveling or the class, which it also
 * asks. Two separate dates for departing and returning become it.
 */
function withoutCovered(questions: AskUserQuestion[]) {
  const first = questions.findIndex((q) => q.noEndLabel && q.question === TRIP_HEADING);
  const departing = questions.findIndex((q) => q.type === "date" && FLYING.test(q.question) && !RETURNING.test(q.question));
  const separateReturn = questions.some((q) => q.type === "date" && RETURNING.test(q.question));
  const trip = first >= 0 ? first : departing >= 0 && separateReturn ? departing : -1;
  if (trip < 0) return questions;
  return questions.flatMap((q, i) => {
    if (i === trip) {
      return [{ ...q, question: TRIP_HEADING, type: "date-range" as const, startLabel: q.startLabel ?? "Depart", endLabel: q.endLabel ?? "Return", noEndLabel: q.noEndLabel ?? "One way", withEndLabel: q.withEndLabel ?? "Round trip", unit: "nights" as const, travel: q.travel ?? DEFAULT_TRAVEL }];
    }
    const asksTripType = q.type === "choice" && q.options.length <= 3 && q.options.some((option) => TRIP_TYPE.test(option));
    const asksTravel = q.type === "choice" && TRAVELERS_OR_CLASS.test(q.question);
    return isTripDates(q) || asksTripType || asksTravel ? [] : [q];
  });
}
