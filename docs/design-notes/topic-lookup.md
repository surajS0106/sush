# Topic lookup — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04 (automatic placement)
- When a finished reply has no photo markers, each section gets the unused photo whose caption best matches its heading and text, at most four in a reply (`apps/desktop/src/lib/topic-placement.ts`, `apps/desktop/src/components/chat-view.tsx`).

### 2026-11-04 (photos between sections)
- The model places photos in its reply with `[photos](4,5)`, choosing by caption from a numbered list in the tool's output. The text splits around each marker (`apps/desktop/src/lib/citations.ts`, `apps/desktop/src/components/chat-view.tsx`).
- The card keeps the first three photos, and a lookup now keeps up to 16 (`apps/desktop/src/lib/topic.ts`, `crates/sush-core/src/topic.rs`).
- The instruction to call the tool again for a subtopic is gone.

### 2026-11-04
- Added the `topic_lookup` model tool, offered in every session and run without approval (`apps/desktop/src/lib/topic.ts`, `apps/desktop/src/lib/agent.ts`).
- Added the Wikipedia client: finds the article, then reads its text, photos and citations together (`crates/sush-core/src/topic.rs`), exposed as a Tauri command (`apps/desktop/src-tauri/src/topic.rs`).
- Added the card: a mosaic of up to three photos with a "+N" count, a viewer for all of them, and a scrolling strip of articles (`apps/desktop/src/components/topic-card.tsx`).
- The card stays out of the collapsed activity line (`apps/desktop/src/components/activity-group.tsx`).
- Allowed `upload.wikimedia.org` and `thumb.wikimedia.org` in `img-src` (`tauri.conf.json`, `tauri.release.conf.json`).

## Why

Answers about people, places and events were text from the model's memory, with no pictures and nothing to check them against. Web research only exists for Anthropic models that have it switched on, so it could not fix this for every provider. A tool that fetches the data works with any model that can call tools, and needs no key.

Wikipedia was chosen because it provides photos with captions and licence pages, reviewed text and titled citations from one keyless source. The trade-off is coverage: a subject without an English article gets no card, and breaking news is out of reach. Google News RSS was rejected because its feed terms limit use to personal feed readers. GDELT was rejected because it allows one request every five seconds and only covers recent coverage.

The model reads the article's text and only the titles of the references. Its instructions therefore cite the Wikipedia article for facts and forbid saying what a reference claims, because it has not read those pages.

Photos between sections break up long replies and sit next to the text they illustrate. The model picks them because it knows what each section says, and captions are all it needs for that. A second lookup per subtopic would add a request set and another article strip, so one lookup now supplies them all. 

Not every model follows the placement instruction, so a finished reply without markers falls back to matching captions against sections. The match is by shared words, not meaning, so it requires at least two shared words and leaves a section empty rather than risk a wrong photo. Fallback photos appear only when the reply ends, because sections are not settled while text streams, and nothing is saved, so the stored reply stays as the model wrote it.

## What makes it stand out

Compared with having the model write markdown image links and a source list from memory:

- Image and article URLs come from the API, so the model cannot invent them. Image data is in `cardOnly` and never reaches the model.
- Inline citations reuse the existing `[cite](url "title")` markers, so they get the same numbered markers and source list as web research, and are stripped before text goes back to the model.
- Photo markers hold numbers, not URLs, so the model can only place photos the lookup returned. A marker still streaming is held back and never shows as text, and markers are removed from copied text.
- The fallback ignores the subject's own name and words common to many captions, so "Kennedy" alone never counts as a match. It never splits a code block or a list.
- Each photo in the viewer links to its Wikimedia file page for credit and licence.
- The "+N" tile opens a working viewer with arrow keys and previous and next buttons. A photo that fails to load drops out of the mosaic and viewer.
- References are limited to news, web, journal and magazine citations, one per site, with named publishers first. Saved copies on archive.org and books are left out.
- Photos and citations are optional: if either request fails, the answer still arrives with what was read.
