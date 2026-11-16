// Yammer, Sush's meeting notetaker, as Sush's meeting memory. Yammer records
// and writes up meetings; Sush reads them through the Yammer connector
// (`yammer --mcp`, added by `syncYammerConnector` in library.ts) and does the
// thinking across them: questions over weeks of meetings, recipes, briefs,
// and workflows that run when a meeting ends. Every meeting the tools return
// has a `yammer://meeting/<id>` link, which opens it in Yammer.

import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { api, errorMessage } from "@/lib/tauri";

/** The Yammer connector's id: Sush adds and keeps it up to date itself. */
export const YAMMER_CONNECTOR_ID = "yammer";

const MEETING_LINK = /^yammer:\/\/meeting\/(\d+)\/?$/;

/** The meeting a `yammer://meeting/<id>` link names, if it is one. */
export function meetingOfLink(href: string | undefined): number | null {
  const m = href?.trim().match(MEETING_LINK);
  return m ? Number(m[1]) : null;
}

/** Open a link from an answer: a Yammer meeting opens in Yammer, anything else as usual. */
export function openLink(href: string) {
  const meeting = meetingOfLink(href);
  if (meeting === null) return void openUrl(href);
  void api.yammerOpenMeeting(meeting).catch((e) => toast.error("Couldn't open the meeting in Yammer", { description: errorMessage(e) }));
}

/** In the system prompt while the Yammer connector is on. No per-request values, so it caches. */
export const YAMMER_SECTION =
  "The user records and writes up their meetings with Yammer, and the Yammer connector reads them: search_meetings " +
  "finds meetings by words in their title, notes or transcript, list_meetings lists them newest first (narrow it with " +
  "since and until, YYYY-MM-DD), get_meeting reads one (ask for its transcript only when the notes don't answer), and " +
  "get_live_meeting reads the meeting going on right now. Use them whenever the user asks about a meeting, a call, " +
  "something someone said, or what they agreed or promised. In a meeting's transcript \"You\" is the user, \"Them\" " +
  "is everyone else on a call, and \"Room\" is one microphone hearing everyone. Whenever an answer draws on a meeting, " +
  "link it by title to its link, like [Pricing sync](yammer://meeting/1794819600000): the user clicks it to open the " +
  "meeting in Yammer.";

/** Recipes: meeting prompts that work across Yammer meetings, added as skills with the connector. */
export const MEETING_RECIPES: { name: string; description: string; instructions: string }[] = [
  {
    name: "Meeting promises",
    description: "What the user promised or agreed to do in their meetings over a period (this week if they don't say).",
    instructions: `Find the commitments the user made in their Yammer meetings.

1. Work out the period: what the user asked for, else this week (Monday to today). List the meetings in it with list_meetings (since, until).
2. Read each one with get_meeting. Look in its notes' action items, and in the transcript where "You" says they will do something ("I'll send…", "let me check…", "I can have it by Friday").
3. Answer with one checklist grouped by meeting: "- [ ] What, for whom, by when" as said. Link each meeting by title to its yammer:// link.
4. End with anything that's overdue or due in the next two days. Don't invent deadlines; leave them out when none was said.`,
  },
  {
    name: "Weekly meeting recap",
    description: "A recap of the user's meetings this week (or the period they name): what happened, what was decided, what's open.",
    instructions: `Recap the user's Yammer meetings for a period: this week unless they say otherwise.

1. List the meetings in the period with list_meetings, and read the ones with notes with get_meeting.
2. Write: a two-sentence overview of the week; "## Decisions" across all meetings; "## Open items" (who owes what); "## Themes" (topics that came up in more than one meeting).
3. Link every meeting you draw on by title to its yammer:// link. Keep it to one screen.`,
  },
  {
    name: "Meeting follow-up email",
    description: "Draft the follow-up email for a meeting: thanks, what was agreed, next steps with owners.",
    instructions: `Draft a follow-up email for one Yammer meeting.

1. Find the meeting: the one the user names or links, else their most recent with list_meetings. Read it with get_meeting.
2. Write the email ready to send: a subject line, a short thank-you, what was agreed, next steps as a list with owners and dates where said, and any open questions. Match the meeting's language and keep a friendly, plain tone.
3. Don't invent commitments, numbers or dates. Never send it: show it as a draft, with the meeting linked by title to its yammer:// link.`,
  },
  {
    name: "Coach me on a call",
    description: "Feedback on how the user ran or took part in a meeting: talk time, questions, clarity, what to do differently.",
    instructions: `Coach the user on one Yammer meeting.

1. Find the meeting (named, linked, or their most recent) and read it with get_meeting including its transcript.
2. Look at what "You" said: how much they talked compared to others, the questions they asked (open or closed), how they handled objections or disagreement, and whether the meeting ended with clear next steps.
3. Give three things that went well and three things to try next time, each with a short quote from the transcript and its time. Be specific and kind. Link the meeting by title to its yammer:// link.`,
  },
  {
    name: "Decision log",
    description: "Every decision made in the user's meetings over a period, with who decided and why.",
    instructions: `Build a decision log from the user's Yammer meetings over a period (the last two weeks unless they say).

1. List the meetings with list_meetings and read them with get_meeting.
2. Write a table: date, decision, who made it or agreed, why (as said), and the meeting linked by title to its yammer:// link.
3. Then list decisions that seem to conflict or were reversed later. Only include decisions the notes or transcript actually state.`,
  },
  {
    name: "Customer pain points",
    description: "The problems, objections and requests customers raised across the user's calls, grouped and counted.",
    instructions: `Pull customer pain points out of the user's Yammer meetings.

1. Find customer calls: search_meetings for the customer or topic the user names, else list the recent meetings and pick those that read as calls with customers or prospects.
2. Read each with get_meeting, using the transcript for what "Them" said in their own words.
3. Group the pain points, objections and feature requests into themes. For each: how many calls raised it, a short quote or two, and the meetings linked by title to their yammer:// links. Most common first.`,
  },
];

/** "Meeting prep" for the Automations template: past meetings are read through Yammer when it's connected. */
export const MEETING_PREP_PROMPT =
  "Look at today's meetings on my calendar. For each one, write a short brief: who's attending; what we last discussed " +
  "with them, from my past meeting notes if you can read them (search them for the people, the company or the topic, " +
  "and link any you use), else from recent email or past chats; anything I promised them or still owe; and a suggested " +
  "agenda. Skip meetings without other people. Keep each brief to a few bullets.";
