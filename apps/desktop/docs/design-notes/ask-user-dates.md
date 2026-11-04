# Ask User Dates: Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- A flight's date question also asks who's traveling and in what class: steppers for adults and children and a class select, in a bar under the dates (`TravelBar` in `src/components/date-question.tsx`). It shows on any trip question the card recognizes, so it doesn't depend on the model asking. Adults and children together stop at nine, the search's limit. The question can start it from what the user already said (`adults`, `children`, `cabin`), and a separate question about passengers or class in the same call is dropped (`withoutCovered`). The answer gains `travel: { adults, children, cabin }`, sent only when the dates are answered, and `flights_search`'s description tells the model to call with it. `check_answer` in `policy.rs` ignores other fields, so shared sessions need no change. The transcript's summary shows it ("2 adults, 1 child · Business", `travelText`).
- `ask_user` questions take a `type`: `choice` (the default), `date` or `date-range`. Date questions need no `options`, and can set `startLabel`, `endLabel`, `noEndLabel`, `unit`, `minDate`, `maxDate` and `suggestions` (`src/lib/ask-user.ts`).
- The tool's description tells the model to use these whenever it needs a date and never to list months or dates as options. `flights_search` names the labels to use for a trip (`src/lib/flights.ts`).
- A single-choice question whose options are nearly all dates now shows the calendar anyway (`asDateQuestion`). Models ignored the instruction and kept listing months. Bare words like "January" or "Friday" only count when the question is about travel.
- New calendar on the card (`src/components/date-question.tsx`): the picked dates and the trip's length in one bar, chevrons beside the month names, a line under the calendar for typing and shortcuts. Pressing a month's name shows that year's months in place of the days, at the same height. One or two months show depending on the card's width (two from 480 px).
- Clicking picks each end, and dragging across days paints a range. While only the start is picked, the range follows the pointer and the length updates.
- New `src/lib/dates.ts` handles days as `YYYY-MM-DD` strings and reads typed dates such as "next friday", "jan 15 to mar 10", "jan 15-20", "mar 3 for 2 weeks" and "1/15", in the order the user's region writes them.
- Text that can't be read as a date goes to the model as written, and the card says so.
- With `noEndLabel` set, the card offers a radio choice such as Round trip or One way, and the calendar picks one date when the last date is left out. Round trip is the default, and needs a return before it can be sent.
- A converted flight question becomes this range. Any other question in the same call about the trip's dates or type is dropped, so a month, an exact day and a return are one card (`withoutCovered`). Shortcuts written as raw dates show as readable ones.
- Chevrons move one month at a time.
- A flight's date question is headed "When are you traveling?", whatever the model wrote, since models word it for departure alone and it also covers the return (`TRIP_HEADING`).
- Answers keep the existing shape, so `check_answer` in `crates/sush-core/src/share/policy.rs` needs no change: `["2027-01-15", "2027-03-10"]`. The transcript's summary shows them as readable dates (`answerText` in `src/components/ask-user-card.tsx`).
- The keyboard works in the calendar: arrow keys, Home and End for the week, Page Up and Page Down for the month, Enter to pick. Days are in `role="grid"` with full dates as labels.
- Colors use `brand`, so the picker follows the user's accent.
- `isDay` now returns `boolean` and is no longer a type guard (`src/lib/dates.ts`). Runtime behavior is unchanged.

## Why

`isDay` declared `value is string`, so TypeScript read a `false` result on a string as "not a string" and narrowed it to `never`, which failed typecheck at each string caller (`parseOne`, `shortcutLabel`, `answerText`). A guard can't say "this string is a day" without a branded type, and no caller needs one: `parseAskUserInput` and `parseSuggestions` read model input as `any`, so they compile without narrowing. The trade-off is that the dates they accept stay `any` where the guard had made them `string`.

The model asked for dates with radio buttons of months, which can't express a day, and then had to ask again. A date is a value with its own input, so the question type belongs in the tool and not in how the model words its options.

Typing stays alongside the calendar because a person often already knows the phrase, and pressing through months to reach it is slower. The year view serves the same need for far-off dates. The cost is a wider card than a list of choices: `max-w-2xl` while a date question is showing.

Earlier versions had a scrolling ribbon of months and a side column of bordered boxes and pill shortcuts. They were dropped because every control had the same visual weight, which made the card look assembled and not designed. Now the dates and calendar lead and the rest is plain text. The calendar keeps six rows in every month so the card doesn't change height while paging.

Date questions don't advance on their own as single choices do, because a range takes more than one press and a first pick is often changed.

After a finished range, the next press starts a new one, since that's the usual intent and it's what makes dragging work. Pressing the first date's box first keeps the last date, for changing only the start.

The tool's description wasn't enough on its own: in real use the model still asked "What month would you like to depart?" with months as options. So the card recognizes the shape. The risk is turning a real choice into a calendar, so conversion needs at least two dated options and twice as many dated options as others, and never applies to multi-select.

## What makes it stand out

Compared with a stock date picker dropped into the card:

- Three ways to answer stay in step: typing moves the calendar, and shortcuts and the calendar clear the typed text.
- The model can supply labels and shortcuts that fit the question, such as Depart and Return, or the dates the user mentioned.
- The year view reaches up to 18 months ahead, or to the question's last date, and marks which months the range covers.
- The length is counted as nights or days, as the question asks.
- It needs no date library. Week start and date order come from the user's locale through `Intl`.
- A vague answer such as "flexible in spring" isn't rejected: it goes to the model as written.
