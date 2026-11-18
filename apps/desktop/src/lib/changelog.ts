// What's new: the release notes users see in Settings → What's new, and once after an
// update moves them to a newer version. Written for users, newest release first.
// Add to UNRELEASED as features land: they are the notes of the version main is building
// (main always carries the version it will be released as), so the build that gets tagged
// already shows them. After tagging, the release skill moves them into RELEASED.

import { getVersion } from "@tauri-apps/api/app";
import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

export type ChangeKind = "new" | "improved" | "fixed";

export interface Change {
  kind: ChangeKind;
  text: string;
  /** A few words naming it, for the sidebar's "New in Sush" cards. Give one to the changes worth a card. */
  title?: string;
}

export interface Release {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** One line on what the release is about. */
  summary?: string;
  changes: Change[];
}

/** One line on what the version main is building is about. */
export const UNRELEASED_SUMMARY = "Talk to Sush with voice mode, and let it run your Board, automations, projects and binders from any chat.";

/** Landed since the last release: the notes of the version main is building (`__APP_VERSION__`). */
export const UNRELEASED: Change[] = [
  { kind: "new", text: "Voice mode: talk with Sush hands-free. With nothing typed, the button by the composer starts a conversation; speak, interrupt whenever you like, and the conversation lands in the chat when you hang up. Bring your own OpenAI, xAI, Sarvam or ElevenLabs key in Settings → Voice mode, then pick a model and a voice: filter by female, male or neutral, and hear each one first." },
  { kind: "new", text: "Sush can now work with the rest of the app from any chat: list, pause, run or reschedule your automations; create projects and file the chat in one; search your binders and add links or notes to them; and start a security review, code review or wiki, then talk through its findings. Anything that changes something shows you a card to approve first." },
  { kind: "new", text: "Ask Sush to add, change or tidy up tasks on your Board: \"add a high-priority task to renew my passport\", \"mark the invoice task done\", \"what's on my plate?\". You see each change and approve it, unless you've picked Auto." },
  { kind: "new", text: "Claude Code and Codex can answer plain chats too, not just Cowork sessions. In a chat they work in an empty folder of their own and ask before any edit or command; a note under the composer says so." },
  { kind: "new", text: "Security reviews, code reviews, wikis, notebook chats and Studio outputs can run on Claude Code or Codex. They get the same tools Sush's own agent uses there, and only read." },
  { kind: "new", text: "Incognito chats work with Claude Code and Codex, which keep no record of them." },
];

/** Released versions, newest first. */
const RELEASED: Release[] = [
  {
    version: "2.12.2",
    date: "2026-11-18",
    summary: "Citations in Binder answers work again.",
    changes: [
      { kind: "fixed", text: "Citations in Binder answers show as numbered markers again, instead of \"cite [blocked]\". Links to Yammer meetings in answers work again too." },
    ],
  },
  {
    version: "2.12.1",
    date: "2026-11-17",
    summary: "Sushi learns new tricks, and code blocks in docs get colour, a language picker and smarter indenting.",
    changes: [
      { kind: "new", text: "Your Sushi has new tricks. In Settings → Sushi, pick what it should do: take a coffee break (it brews a mug at a little machine, then sips it), read a book in its glasses, dance, nap, work out with a dumbbell, juggle, meditate in a floating glow, play a handheld game, or work." },
      { kind: "improved", text: "In docs, the / menu has a search field at the top: keep typing after the / to narrow it down." },
      { kind: "fixed", text: "Code blocks in docs now follow light and dark mode instead of always being black." },
      { kind: "fixed", text: "Cmd+A works in docs again: press it once to select the line or block you're in, and again to select the whole doc." },
      { kind: "improved", title: "Code in docs", text: "Code blocks in docs are now coloured by language. Click the language name at the top to pick another, or type to search the list, and use Copy at the top right to copy the code. Tab and Shift+Tab indent and outdent the lines you're on, and Enter indents for the language you picked: a level deeper after {, a Python colon or an HTML tag, and back out when you type the closing bracket or tag." },
    ],
  },
  {
    version: "2.12.0",
    date: "2026-11-17",
    summary: "Image chats: pick an image model and get just the picture, faster, sharpening as it draws.",
    changes: [
      { kind: "improved", title: "Faster pictures", text: "Pick an image model in the model picker and the chat becomes an image chat: every message goes straight to the image model and the reply is just the picture, with no chat model writing a prompt first or a sentence after, until you pick a chat model again. Follow-ups like \"add snow\" change the last picture. Each picture shows what it cost, and clicking one opens it full size. OpenAI's image models now send a rough version that sharpens while they draw, and come back as smaller JPEGs. Choose how much detail they draw, from Low (fastest) to Max, beside the model picker in an image chat or in Settings → Images." },
      { kind: "improved", title: "Sushi TV", text: "With OpenAI's image models, Sushi's TV now paints the real picture as its rough versions arrive." },
    ],
  },
  {
    version: "2.11.0",
    date: "2026-11-17",
    summary: "Docs you edit together with Sush, your Yammer meetings in chat, and pictures in any conversation.",
    changes: [
      { kind: "improved", text: "Pictures Sush makes now say which model drew them, under the caption." },
      { kind: "new", text: "OpenDyslexic is now a chat font, in Settings → General → Chat font. Its weighted letter shapes can make reading easier with dyslexia." },
      { kind: "new", title: "Docs", text: "Ask for a plan, guide, write-up or playbook and Sush writes it as a doc that opens beside the chat. Edit it like Notion: type / for headings, to-dos, tables, quotes and diagrams, drag blocks by their handle, and select text to format it or ask Sush about it. Every change is kept as a version you can look back at or restore, and Sush sees your edits before it revises. Docs can hold flow charts: Sush draws them where a picture explains better, and the toolbar at the bottom of a doc draws one from the section you're in, or adds a table, checklist or toggle. Click the little Sushi beside the line you're on for three suggestions to improve it, and pick one to put it in. Share copies it so it pastes formatted into Notion, Google Docs or an email, or downloads it as Word, a web page or Markdown. All your docs are on the new Docs page." },
      { kind: "new", title: "Your Yammer meetings", text: "If you use Yammer for meeting notes, Sush can now read your meetings: ask what was decided last week, what you promised someone, or for a follow-up email from yesterday's call, and Sush finds the meeting and answers from its notes and transcript. It's added under Connectors as Yammer once Yammer is up to date, reads your meetings on this computer without asking each time, and never changes them. Turn it off there whenever you like." },
      { kind: "new", text: "Ask in Sush on a Yammer meeting opens a new chat here, ready to ask about that meeting." },
      { kind: "new", title: "Meeting recipes", text: "With Yammer connected, six meeting recipes arrive as skills: /meeting-promises (what you said you'd do), /weekly-meeting-recap, /meeting-follow-up-email, /coach-me-on-a-call, /decision-log and /customer-pain-points. Answers link the meetings they draw on, and clicking one opens it in Yammer." },
      { kind: "new", title: "After a meeting", text: "Workflows can now start when a Yammer meeting ends and its notes are written. The new Follow up after a meeting template pulls out your action items, drafts the follow-up email and puts it on your Board." },
      { kind: "improved", text: "The Meeting prep automation template now brings in what you last discussed with each attendee, from your Yammer meetings when Yammer is connected." },
      { kind: "improved", title: "Sushi TV", text: "While an image is being made, Sushi switches on an old wood-grain TV and paints you a picture. There may be something else on another channel." },
      { kind: "improved", text: "Notebooks are now called Binders. Everything in them stays as it was." },
      { kind: "improved", title: "Image models in the model picker", text: "The model picker lists image models in their own group at the bottom. Pick one and it draws your pictures, and the Image chip turns on (hover it to see which model). A chat that was set to an image model switches to your usual chat model and keeps that one for pictures, instead of failing." },
      { kind: "new", title: "Create image", text: "Pick Create image from the + menu and an Image chip appears in the composer: everything you send is drawn as a picture until you remove it. Without the chip, asking for a picture draws it straight away, with no questions or planning first." },
      { kind: "improved", title: "Settings → Images", text: "Shows at a glance whether images are on and which model draws them, tags the providers that can make images, and explains the ways to ask for one." },
      { kind: "improved", title: "Images in any chat", text: "Ask for a picture in any chat and it appears right in the conversation, whichever model you're chatting with. Sush now picks an image model by itself from the providers you've added (OpenAI, xAI or OpenRouter), so there's nothing to set up. Settings → Images still lets you choose a different one, or turn it off. Image-only models no longer appear in the chat model list, since they can't chat." },
    ],
  },
  {
    version: "2.10.0",
    date: "2026-11-16",
    summary: "Audio overviews you can join, flashcards that remember, Grok, and a welcome tour.",
    changes: [
      { kind: "new", title: "xAI Grok", text: "Add xAI as a provider with your API key from console.x.ai to chat with Grok models." },
      { kind: "new", title: "Welcome tour", text: "New to Sush? A short tour greets you the first time you open it: pick a theme, accent and buddy, see what Chat and Cowork do, find your way around the sidebar and connect a model. Take it again any time from Settings → General." },
      { kind: "improved", title: "Board", text: "The board now opens with a column for each status (To do, In progress, Needs attention, Ready for review, Done). You can still group by priority from Sort." },
      { kind: "improved", title: "CRM stages", text: "Each stage has its own colour from Sush's palette: open stages step from orange to teal along the pipeline, won stages are Sush teal and lost ones coral, whatever accent you pick." },
      { kind: "new", title: "Join an audio overview", text: "Press Join while an audio overview plays and ask the hosts a question. They answer it from your sources, citing the passages, and then pick up where they left off." },
      { kind: "new", title: "Flashcards that remember", text: "Flashcard decks now use spaced repetition. Rate each card Again, Hard, Good or Easy, and Sush brings it back just before you'd forget it. Studio shows how many cards are due, and Practice all still runs through the whole deck." },
      { kind: "new", title: "Configure a notebook's chat", text: "Choose how a notebook's chats answer: as a research assistant, a learning guide that quizzes you and gives hints, a critic who weighs the evidence, or in plain words. You can also add your goal and set how long answers should be. Answers still come from your sources." },
      { kind: "new", title: "Audio overview formats", text: "Besides the two-host deep dive, an audio overview can now be a two-minute brief in one voice, a critique that weighs the sources' strengths and weak points, or a debate where the hosts argue opposite sides. Pick one in the audio overview's options in Studio." },
    ],
  },
  {
    version: "2.9.0",
    date: "2026-11-13",
    summary: "A CRM, Workflows, Notebooks, and Cowork on Claude Code or Codex.",
    changes: [
      { kind: "new", title: "CRM", text: "Keep your companies, contacts and deals in Sush, on this computer: edit any cell in place, move deals through your pipeline by dragging, log calls, meetings and notes, and save filtered views as tabs. Import a CSV (Sush guesses each column) or start from sample data. Ask Sush about your pipeline beside the table, have it enrich a company from the web, catch you up on a contact from your mail and calendar, or suggest a deal's next step with the email drafted. Every change it proposes shows before and after, for you to apply. Deals show a health score with its reasons, and @crm works in any chat." },
      { kind: "new", title: "Workflows", text: "Build steps that run on their own when something happens: a deal moving stage, a new email, an upcoming meeting, files changing in a folder, an automation, or a request in chat. Drag steps onto a canvas (AI agents, connector tools, If, Ask me first, Wait, CRM updates, Board tasks, notifications) and connect them, or describe what you want and Sush builds it. Test with a sample, watch each step light up, answer approvals from the run, and let Sush fix a step that failed. Edits stay a draft until you publish." },
      { kind: "new", title: "Notebooks", text: "Gather PDFs, web pages, papers and pasted text in a notebook and chat with them. Answers come from your sources and cite the passage behind each claim; click a citation to read it, the quoted words marked. Each notebook opens on an overview of its sources with questions to ask, each source has a short guide, and you can give a notebook a cover, an emoji and your own summary. Studio writes a briefing, study guide, FAQ or timeline from your sources, cited throughout, makes quizzes, flashcards and mind maps whose every item links to its passage, and audio overviews: two hosts talking your sources through, read by your computer's voices or voiced once by a provider (Settings → Speech); set a Studio output's focus, length and language, make one again, or save a note as Markdown; save any answer to your notes or write your own. Long notebook chats cost less: passages from earlier questions aren't sent again with every new one. Scanned PDFs are read by your model, page by page. Sources can also be YouTube videos (from their captions, with timestamps that open the video), audio recordings (transcribed), past Sush chats and files from your Cowork folders. Share a notebook's chat live: guests see its citations, sources and Studio outputs, and the cited passages too if you allow it." },
      { kind: "new", title: "Claude Code and Codex", text: "Run a Cowork session on Claude Code or Codex: if either is installed and signed in on your computer, it's in the model picker. Sush starts your own copy with your own login and plan (it never sees your credentials), shows its work as Sush's cards, and asks you to approve what it would ask about, so you can still watch, steer and share the session live." },
      { kind: "new", title: "Plans", text: "On a task with several steps, Sush first writes a to-do list, then works through it item by item, ticking each one off as it goes, so you can see what it's doing and what's left. The plan sits above the composer while it works, showing the step in progress; open it for the whole checklist." },
    ],
  },
  {
    version: "2.8.0",
    date: "2026-11-09",
    summary: "A task board, a Connectors page, and your favourite models first.",
    changes: [
      { kind: "new", title: "Board", text: "Keep track of tasks on a Kanban board in the sidebar: drag cards between priority or status columns, switch to a list, and start a session on any task, in its folder, with one click." },
      { kind: "improved", title: "Connectors", text: "Connectors have their own page in the sidebar: yours, a Popular shortlist and every category in one place, filtered by All, Connected or Available." },
      { kind: "improved", title: "Most used models", text: "The model picker opens with the models you send the most messages to at the top, so switching back to a favourite is one click." },
      { kind: "fixed", title: "Check for updates", text: "New versions show up minutes after release, and Check for updates answers in seconds instead of sitting on Checking…" },
    ],
  },
  {
    version: "2.7.0",
    date: "2026-11-09",
    summary: "Folders, a context meter with Compact now, and a sub-agents tray.",
    changes: [
      { kind: "new", title: "Folders", text: "A Folders page in the sidebar shows every folder Sush works in, the sessions that worked there, and each folder's files. Open a file to start a session with it in the viewer." },
      { kind: "improved", title: "Automations on several days", text: "Weekly automations can run on several days, like every Monday and Tuesday at 11 AM." },
      { kind: "fixed", text: "Asking for an automation in your own words saves it on the first try, at the time you asked for, instead of failing again and again." },
      { kind: "new", title: "Context meter", text: "A ring beside the microphone shows how full the model's context is. Hover it to see what's taking up the space and how much of your budget is spent." },
      { kind: "new", title: "Compact now", text: "When a chat fills up the context, “Compact now” in the context meter swaps the conversation so far for a summary, so the model has room again. Earlier messages stay on screen." },
      { kind: "new", text: "Cards at the foot of the sidebar show what's new in this release and a getting-started checklist." },
      { kind: "new", title: "Sub-agents tray", text: "Sub-agents show in a tray above the message box, with where each one stands and how long it has run." },
    ],
  },
  {
    version: "2.6.0",
    date: "2026-11-08",
    summary: "Dictation through Yammer, and What's new.",
    changes: [
      { kind: "new", title: "Dictation with Yammer", text: "Dictation goes through Yammer, Sush's dictation app: press the mic or Ctrl+D and it types what you say into the message box. Without Yammer, Sush walks you through getting it, or keeps using its own in Settings → Speech." },
      { kind: "new", title: "What's new", text: "What's new: see what changed in each release, here and after every update." },
      { kind: "fixed", text: "Checking for updates tries again when GitHub is briefly down, and says what went wrong in plain words." },
    ],
  },
  {
    version: "2.5.0",
    date: "2026-11-08",
    summary: "Web search, more ways to redo a reply, and a glass message box.",
    changes: [
      { kind: "new", title: "Web search", text: "Web search: models look things up and read pages when a question needs it, citing their sources. Turn it off or add an Ollama key in Settings → Search." },
      { kind: "improved", title: "Native web search", text: "Claude and GPT models use their provider's own web search." },
      { kind: "new", title: "Reply options", text: "The … under a reply shows when it was written and redoes it your way: as is, shorter, longer, searching the web, or with a change you type. It also lists the pages the reply drew on and branches a new chat from it." },
      { kind: "new", text: "Read aloud: have any reply read out to you from its action row." },
      { kind: "new", title: "Glass message box", text: "Messages scroll behind a glass message box. Pick frosted, clear, tinted or solid in Settings → General." },
      { kind: "improved", text: "Specialised tools load only when a model needs them, so replies start faster and cost less." },
      { kind: "improved", text: "Replies cost less when the provider caches the conversation, and a reply's stats show its context size, model calls and cached input." },
      { kind: "improved", text: "Research works with any model while web search is on, not only Claude." },
      { kind: "fixed", text: "On macOS, Gatekeeper offers Open Anyway in Privacy & Security instead of saying to move the app to the Bin." },
    ],
  },
  {
    version: "2.4.0",
    date: "2026-11-06",
    summary: "Updates in the app, and cards for maps, flights, weather and food.",
    changes: [
      { kind: "new", text: "Upgrade now: when a new version is out, a button in the sidebar installs it and restarts Sush." },
      { kind: "new", text: "Maps: routes and places on a Google Map, with live details when you add your own key in Settings → Maps." },
      { kind: "new", text: "Flights: search fares, watch the route on a globe, check the weather where you land and set price alerts." },
      { kind: "new", text: "Weather: the weather now as a pixel-art scene, with the next 24 hours and 7 days." },
      { kind: "new", text: "Swiggy Food and Instamart connectors. Every order is confirmed on a card first, and only you can approve it." },
      { kind: "new", text: "Topic lookups: photos and cited articles about a person, place or thing." },
      { kind: "improved", text: "GPT-5.6 and GPT-6 can reason and use tools in the same reply." },
      { kind: "improved", text: "The pull request card follows GitHub's checks, and you can continue or abort a stopped rebase." },
      { kind: "fixed", text: "Deleting a merged branch removes your local copy too." },
      { kind: "fixed", text: "Landing with a rebase on an older git now says it needs git 2.40, instead of showing a raw error." },
    ],
  },
  {
    version: "2.3.0",
    date: "2026-11-01",
    summary: "Shared sessions grow a room of their own, and Cowork can run on your machine.",
    changes: [
      { kind: "new", text: "A room in every shared session: everyone can chat alongside the work, without it reaching the model." },
      { kind: "new", text: "Guests can follow the host's git graph and built-in browser, and rejoin sessions from their history." },
      { kind: "new", text: "Let others on your Wi-Fi join: the installed app can be the relay. Turn it on in Settings → Sharing." },
      { kind: "new", text: "Cowork can run commands on your machine instead of the sandbox, so servers can listen and installs reach the network." },
      { kind: "new", text: "Connected apps in Settings → Account, for apps you sign in to with your Sush account." },
      { kind: "improved", text: "On macOS and Linux, Sush picks up your shell's PATH, so commands find bun, Homebrew and nvm." },
    ],
  },
  {
    version: "2.2.0",
    date: "2026-10-26",
    summary: "Sush Multiplayer, sub-agents and the git graph.",
    changes: [
      { kind: "new", text: "Share a live session: others watch, suggest messages, or take control. End-to-end encrypted, and viewable in a browser." },
      { kind: "new", text: "Sub-agents: Sush can hand tasks to agents that work in parallel, shown as a graph you can open." },
      { kind: "new", text: "A git graph beside your files, and a branch card with conflicts, commits and merges." },
      { kind: "new", text: "Sushi can take a dizzy fall, with sound effects. Turn it off in Settings → Sushi." },
    ],
  },
  {
    version: "2.1.1",
    date: "2026-10-19",
    changes: [{ kind: "fixed", text: "The Windows installer builds again." }],
  },
  {
    version: "2.1.0",
    date: "2026-10-19",
    summary: "Steer replies, review your code, and generate images.",
    changes: [
      { kind: "new", text: "Steer a reply while it runs, \"Send now\" to cut in, and pause and resume replies." },
      { kind: "new", text: "Security reviews, code reviews and wikis of a workspace." },
      { kind: "new", text: "Generate images in chat with the model you pick in Settings → Images." },
      { kind: "new", text: "A Databricks connector." },
      { kind: "new", text: "Zoom the whole app in and out." },
      { kind: "improved", text: "Usage shows what you've spent, and the macOS icon follows light and dark mode." },
      { kind: "improved", text: "Sush is open source under the MIT license, and each install generates its own sign-in secret." },
    ],
  },
  {
    version: "2.0.0",
    date: "2026-10-12",
    summary: "Cowork: Sush works in your folders.",
    changes: [
      { kind: "new", text: "Cowork: give Sush a folder and it reads, edits and runs commands there, in a sandbox." },
      { kind: "new", text: "A built-in browser, git worktrees, and the files each turn changed, with undo." },
      { kind: "new", text: "A side panel with your files, an editor and a terminal." },
      { kind: "new", text: "Meet Sushi, the mascot, and pick an avatar for your account." },
      { kind: "new", text: "Accent colors and smooth theme changes." },
      { kind: "improved", text: "Resizable sidebar and panels, and pull requests and commits shown as cards." },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-10-10",
    changes: [
      { kind: "new", text: "Connectors (MCP), local dictation, @-mentions and artifacts." },
    ],
  },
];

/** Every version's notes, newest first: the one being built (dated by its build), then the released ones. */
export const CHANGELOG: Release[] =
  UNRELEASED.length && !RELEASED.some((r) => r.version === __APP_VERSION__)
    ? [{ version: __APP_VERSION__, date: __BUILD_DATE__, summary: UNRELEASED_SUMMARY || undefined, changes: UNRELEASED }, ...RELEASED]
    : RELEASED;

/** -1, 0 or 1 by semver order (plain `x.y.z`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The releases up to and including `current` (the notes for a newer one aren't out yet). */
export const releasedUpTo = (current: string | null) =>
  current ? CHANGELOG.filter((r) => compareVersions(r.version, current) <= 0) : CHANGELOG;

// --- this install's version ---------------------------------------------------

let appVersion: string | null = null;
const versionListeners = new Set<() => void>();
const versionReady = getVersion()
  .then((v) => {
    appVersion = v;
    versionListeners.forEach((l) => l());
    return v;
  })
  .catch(() => null);

/** The running app's version, once read. */
export function useAppVersion(): string | null {
  return useSyncExternalStore(
    (l) => {
      versionListeners.add(l);
      return () => versionListeners.delete(l);
    },
    () => appVersion,
  );
}

// --- shown once after an update -------------------------------------------------

/** The newest version whose notes this user has seen (or was installed fresh on). Shared by every window. */
const seen = createStore<string | null>("sush.changelog-seen", null);
/** The releases to show in the What's new dialog, or null when it's closed. */
const pending = createStore<Release[] | null>("sush.changelog-pending", null, false);

export const useWhatsNew = () => useSyncExternalStore(pending.subscribe, pending.get);

/**
 * At launch: after an update, open the notes for each release since the last one seen.
 * A fresh install only records its version. Run from the leader window, once.
 */
export async function checkWhatsNew() {
  const current = await versionReady;
  if (!current) return;
  const last = seen.get();
  if (!last) return seen.set(current);
  if (compareVersions(current, last) <= 0) return;
  const fresh = CHANGELOG.filter((r) => compareVersions(r.version, last) > 0 && compareVersions(r.version, current) <= 0);
  if (fresh.length) pending.set(fresh);
  else seen.set(current);
}

/** Close the dialog; its notes count as seen. */
export function dismissWhatsNew() {
  pending.set(null);
  if (appVersion) seen.set(appVersion);
}
