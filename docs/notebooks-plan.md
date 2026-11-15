# Notebooks plan

A notebook is a set of sources (PDFs, web pages, papers, videos, audio, notes) you chat with. Answers come from those sources and cite the exact passage. A Studio turns the sources into briefings, study guides, quizzes, mind maps and audio overviews.

The idea comes from NotebookLM. Sush's version uses Sush's own look, tokens and patterns and is not a replica: no copied layout details, wording or icons.

Notebooks are their own sidebar page, separate from Projects. Projects group chats under shared instructions. A notebook holds a library of outside material (links, papers, videos) and is built around that library.

## Decisions so far

- **Retrieval:** BM25 over source chunks (SQLite FTS5 `bm25()`). No embeddings.
- **Citations on Anthropic:** Anthropic's native citations. Search results go back as `search_result` blocks. Pinned sources go in as `document` blocks with `citations.enabled`.
- **Citations on other providers:** chunk ids in the tool text, and the model writes `[cite](sushsrc:…)` markers. The UI shows both kinds the same way.
- **Caching:** cache marks with `ttl: "1h"` on notebook sources, since every follow-up question re-reads them.

## Page layout

Three columns on wide windows. On narrow windows, sources and Studio become sheets, and chat always shows.

- **Sources:**
  - The list, with a checkbox per source (all / none), a kind icon, and ingest status (reading / indexed / failed + why).
  - "Add source" accepts a file, link, YouTube link, paper (arXiv or DOI), pasted text, a past Sush chat, or a file from a Cowork folder.
  - A pin toggle marks a source to send whole (see Grounding). Clicking a source opens the viewer.
- **Chat:**
  - A notebook's chats are ordinary threads with `ThreadMeta.notebook_id`, kept out of the session list like report threads, with a picker to switch between them.
  - The composer shows how many sources are checked.
  - An empty notebook shows a generated overview (a short summary plus suggested questions) instead of a blank chat.
- **Studio:** buttons for each output kind, and the list of outputs made so far (kind icon, sources used, age, play/open, menu). Notes sit below them.
- **Source viewer:** replaces the chat column while open. PDFs are shown page by page, text and web snapshots as reading view, and videos and audio as a player beside the transcript. A citation chip opens it scrolled to the passage, with the quoted words highlighted.

Colours use `brand` and the existing tokens. Kind icons are neutral. Coral is only for failed ingests.

## Data (sush-core, `sush.db`)

```
notebooks          id, title, emoji, created_at, updated_at, overview (json)
notebook_sources   id, notebook_id, kind, title, origin (url | blob sha | thread id | path),
                   status, error, checked, pinned, meta (json: pages, duration, authors…),
                   text_sha (blob of the extracted text), added_at
source_chunks      id, source_id, ordinal, page, start_char, end_char, start_ms, text
source_chunks_fts  fts5(title, text, content=source_chunks)   -- bm25(), title weighted up
notebook_outputs   id, notebook_id, kind, title, status, thread_id, source_ids, body (json), created_at
notebook_notes     id, notebook_id, title, body (markdown), from_message, as_source, created_at
```

- The whole notebook lives in Rust's store, not localStorage, because chunks are large and other windows need the same data.
- Changes reach every window as a `notebook` frame, the same way `report` frames work.
- Deleting a notebook deletes its threads, outputs and blobs.

## Bringing sources in (`sush_core::sources`)

Each kind turns into text plus locations. The locations are what citations point at.

| Kind | How | Location kept |
|---|---|---|
| PDF | Text extracted per page in Rust. A page with no text layer goes to a vision model to read. | page |
| Web page | `web_fetch` (public addresses only, same checks), stored as a readable snapshot so citations stay stable | char range |
| Paper | arXiv id or link → its PDF. DOI → open-access PDF if one exists, else the landing page. Title and authors kept in `meta`. | page |
| YouTube | Caption track for the video's language. If there's none, the user pastes a transcript. | `start_ms` (a chip opens the video at that time) |
| Audio file | Transcribed locally with `whisper.rs` (already in the app) | `start_ms` |
| Pasted text, Markdown, txt | As is | char range |
| Past Sush chat | Its messages as text | message |
| Cowork file | Read through the workspace's `Dir` (same rules: no secrets without approval) | char range |
| Note | A note marked "use as source" | char range |

- **Chunking:** about 1,500 characters, split at paragraph and heading boundaries, never across a page. Each chunk keeps its section heading.
- **Running ingests:** ingest runs in the background with a status per source, and a failed source shows why and offers to retry. Size caps per source and per notebook will be decided when building.

## Grounding

### Tools
Only offered in notebook threads.

- `source_search { query, source_ids? }`
  - Searches the checked sources by BM25 and returns the top 8 chunks.
  - Neighbouring chunks from the same source are merged.
- `source_read { source_id, page? | from?, to? }`
  - Reads a stretch of a source when the search snippets aren't enough.

### Pinned sources
- A pinned source (or every checked source, when all of them fit in about 30% of the model's context) is sent whole with the system prompt and cached for 1h. The model can cite it without searching.
- Everything else is reached through `source_search`.

### System prompt
- Answer from the sources only, and cite every claim.
- When the sources don't cover something, say so. Offer general knowledge only if the user asks for it, and label it as such.

### Citations on Anthropic
- `source_search` puts structured results in `ToolResult.output`. The Anthropic encoder sends them as:
  ```json
  { "type": "search_result", "source": "sushsrc:<source>#c<chunk>", "title": "<source title> · p.12",
    "content": [{ "type": "text", "text": "<chunk>" }], "citations": { "enabled": true } }
  ```
  Other providers get the same results flattened to text with `[S<n>·c<chunk>]` ids.
- Pinned sources go as `document` blocks with `title`, `context` and `citations: { enabled: true }`:
  - PDFs as `base64`, which come back cited as `page_location`.
  - Text as `text`, cited as `char_location`.
  - Pre-chunked content as `content` (one block per chunk), cited as `content_block_location`, which maps straight to a chunk.
- The Anthropic decoder currently drops every citation that isn't from web search (`providers/anthropic.rs`, `citations_delta`). It should map all four types to `ChatEvent::Citation`, which grows two fields:
  - `quote`: the `cited_text`.
  - `location`: page, char range, chunk or `start_ms`.
- Native citations can't be combined with structured output. Studio outputs write through tools, so this doesn't matter.

### Citations on other providers
- The model writes `[cite](sushsrc:<source>#c<chunk>)` as instructed. `lib/citations.ts` already renders `[cite](…)` markers.
- It gains the `sushsrc:` scheme: a chip shows the source title and page, and opens the viewer.
- With no quote, the viewer highlights the whole chunk.

### Long chats
- Later, on Anthropic: `clear_tool_uses` context editing for old `source_search` results, since they can always be searched again.

## Notes

- **Making a note:**
  - "Save to note" on any reply keeps it with its citations.
  - Notes can also be written by hand, in the same editor style as the Cowork viewer.
- **"Use as source":** indexes a note like any other source.

## Studio

Each output is a read-only agent run on its own thread, built the way `reports.rs` runs the Wiki: the notebook's tools plus one write tool, `notebook_write_output`.

- **Running:** you can regenerate an output, and the old one stays until the new one finishes.
- **Citations:** every output cites its sources the same way chat does.

| Output | What it is | How it's shown |
|---|---|---|
| Briefing | Key points and quotes | Document |
| Study guide | Short-answer questions, an answer key, essay prompts, glossary | Document |
| FAQ | Questions and answers | Document |
| Timeline | Dated events and the people involved | Vertical timeline |
| Quiz | Multiple choice with explanations | Interactive card, scored |
| Flashcards | Front and back | Card stack, flip and "again / got it" |
| Mind map | Topic tree | `d3` tree. Clicking a node asks about it in chat. |
| Audio overview | Two hosts discussing the sources | Player, transcript, chapters (see below) |

Options per output: which sources it uses (default: the checked ones), length, a focus prompt ("only chapter 3"), and the language.

## Audio overview

1. **Script:** the model writes a two-host script as `notebook_write_output` with turns `{ host, text }` and chapter marks. The script cites its sources like any other output.
2. **Voices:** a text-to-speech provider from **Settings → Speech → Voices** (key in the keyring) reads each turn in its host's voice. The clips are joined and stored as one blob.
   - The first version can use the system voices (`speechSynthesis`) as a free preview.
3. **Player:** play/pause, speed, chapters, and the transcript highlighting the turn being spoken.

Interactive mode (interrupting the hosts with a question) comes later.

## Sharing

A notebook can be shared live through the existing share code.

- **Guests can see:** the chat, outputs, and source titles.
- **Hidden by default:** source contents, unless the owner allows it.
- **Policy:** new intents go through `policy::authorize` like every other intent.

## Phases

Status (2026-11-09):
- **Phase 1:** done and tried by the user, except pinned sources and the one-hour cache, which wait for a later phase.
- **Phase 2:** written (notes, and Studio's briefing, study guide, FAQ and timeline), plus three gaps from phase 1: scanned PDFs, dropping files on the sources panel, and the user's context in notebook chats. Not built yet.
- **Phase 3:** written (quiz, flashcards, mind map). Not built yet.
- **Phase 4:** written (YouTube, audio, past chats, Cowork files). Not built yet. The overview arrived earlier.
- **Phase 6:** written (sharing a notebook's chat: titles, outputs, and cited passages if the owner allows). Not built yet; needs the two-instance hand test in the `multiplayer` skill.
- **Phase 5:** written (audio overviews). Not built yet. Voices: the computer's own by default, or any OpenAI-style `/audio/speech` provider, which covers cloud and local servers.
- **Phase 7 (2026-11-16):** written: chat style per notebook, spaced-repetition flashcards, joining an audio overview (interactive mode), audio formats (deep dive, brief, critique, debate). Not built yet.
- **Phases 8 to 14:** planned below, under "After phase 7".

See `docs/design-notes/notebooks.md`.

1. **Sources and grounded chat (the main part):**
   - Store tables and the `notebook` frame.
   - Ingest for PDF, web page, pasted text and paper.
   - `source_search` and `source_read`, with BM25.
   - Anthropic `search_result` and `document` citations, and decoding all citation types.
   - The `sushsrc:` chip and the source viewer.
   - Pinning and the 1h cache.
   - The sidebar page, the notebook list, and the three-column layout.
2. **Notes and the first Studio outputs:** save to note, notes as sources, then briefing, study guide, FAQ and timeline.
3. **Interactive outputs:** quiz, flashcards, mind map.
4. **More source kinds:** YouTube, audio (Whisper), past chats, Cowork files, and the empty-notebook overview.
5. **Audio overview:** script, then voices, then the player.
6. **Sharing:** notebook intents and redaction.
7. **Learning and listening:** chat style, spaced repetition, Join, audio formats.

## After phase 7

Gaps left against NotebookLM, and features it doesn't have. They're in the order to build them: each one either stands alone or depends only on an earlier one. Sizes are rough: S is a day or less, M a few days, L a week or more.

### 8. Follow-ups to phase 7 (S each)
- **Due cards outside Studio.** Show a badge on the notebook card and a count by Notebooks in the sidebar, using `deckStatus` across notebooks. At launch, the leader window shows one toast ("12 cards due in 3 notebooks") that opens the first deck due.
- **Keep a Join answer.** Add "Keep in the overview" to the live turns. It writes them into the script with `notebook_note_set_data`, which already accepts any audio overview data whose clips are blobs. They stay marked `live` so the transcript can still show "You asked".
- **Ask by voice.** A mic button in the Join form, through `useDictation` (Yammer pastes into the focused field, so it works today; Sush's own Whisper needs the button).
- **Join with the computer's voices while a line is speaking.** Check that `speechSynthesis.cancel()` stops mid-word on macOS and Windows. If it doesn't, Join waits for the end of the line.

### 9. Re-sync sources (M)
- `notebook_source_refresh` reads a link, YouTube or Cowork-file source again, then compares a hash of the text it gets with the one stored on `Source`. If the text changed, the source is chunked and indexed again under the same source id.
- The hard part is citations. Old answers point at chunk ids that will no longer exist. Plan: keep a source's old chunks in a `source_chunks_old` table, without an FTS entry, until no thread or note cites them. A citation into them opens with a note saying it's from an earlier version of the source.
- UI: "Check for changes" on a source and on the whole notebook, and a "changed" dot on sources that were updated.

### 10. Disagreements, a Studio output (M)
- A new interactive `NoteKind::Disagreements`, saved through `studio_save` as `{ points: [{ topic, sides: [{ says, source }], assessment }] }`. Each side must cite a passage from a different source than the others; `save_studio` checks that.
- The player shows each point as its sides next to each other, each passage opening in the viewer, with the assessment below. It's only offered when two or more sources are checked.
- Why: NotebookLM has nothing like this, and it reuses the Studio run, the save tool and the source chips as they are.

### 11. Research a topic (M)
- Quick discovery already exists: the web search in Add sources, with results to tick.
- The deeper version is a Studio-like run with `web_search` and `web_fetch` plus a `source_propose` tool. The model plans several searches, reads the candidates and proposes 5 to 15 sources, each with a reason. A card lists them to tick, and ticked ones go through `notebook_add_link`.
- It's a run of its own like a Studio output, so it can be stopped and its cost shows in usage. Proposals are only added once the user ticks them.

### 12. Slides and video overviews (L)
- **Slides:** a Studio kind that writes a deck in the `slides_write` shape (`lib/slides.ts`, `validateSlides`), with each slide's sources in its notes. It opens in the existing deck panel, so presenting and the PowerPoint export come with it.
- **Video overview:** the same deck plus an audio-overview-style script with a slide index on each turn. The player shows the slide while its turns play, using the same voices and the same Join.
- Exporting a video file is left out for now: there's no ffmpeg in the app. A later option is recording a canvas with `MediaRecorder` in the webview.
- An infographic (one tall designed page) can follow as an artifact if slides prove the pattern.

### 13. Watched sources (M, after 9)
- A "Watch" toggle on link and YouTube sources. Once a day, the leader window (`whenLeader`, like automations) re-syncs the watched sources of each notebook.
- When one changes, a "What changed" note is written: a Studio-like run given the old and the new chunks, citing both.
- Like automations, it only runs while the app is open, and the note says when it last checked.

### 14. Code notebooks and studying together (L each, later)
- **Code notebooks:** a Cowork folder added as one live source. Its text files are indexed through `WorkspaceFs`, skipping secrets, `.git` and what `.gitignore` ignores. Citations open the file at the line, and an answer's "Fix in Cowork" starts a session there.
- Code notebooks overlap the Wiki report: decide whether a wiki becomes a notebook or links to one before building.
- **Studying together:** in a shared notebook chat, guests take a quiz with the owner: a new `quiz-answer` intent, with scores the host keeps and shows to everyone. A guest's Join question goes through the owner's approval, like other guest actions.
- Both need the `multiplayer` skill read first. Every new intent stays deny-by-default in `policy::authorize`.

### Left out on purpose
- **Public links anyone can open without signing in.** Shares are end-to-end encrypted and the relay can't read them. A public link would mean the relay keeps readable content, which goes against that model. Revisit only if users ask, and then as a static export the owner uploads on purpose.
- **A mobile app.**

## Where the code goes

- **sush-core:**
  - `notebooks.rs` (model and Studio prompts), `sources/` (ingest per kind, chunking, search).
  - The `store.rs` tables, `message.rs` (`Citation` fields), `providers/anthropic.rs` (encoder and decoder), `agent/ui.rs` (`sushsrc:` markers).
- **src-tauri:** `notebooks.rs` commands (create, add/remove/check/pin source, ingest status, read source, outputs, notes), registered in `lib.rs`, and the run setup in `runs.rs` for notebook threads.
- **UI:**
  - Data: `lib/notebooks.ts`, with mirrors in `lib/tauri.ts`.
  - Pages and panes: `components/notebooks-page.tsx` and `notebook-view.tsx` (the columns), `source-viewer.tsx`, `studio-*.tsx`.
  - Wiring: `Page` gets `"notebooks"` in `app-sidebar.tsx`, and `App.tsx` routes it.
  - Release notes: `UNRELEASED` in `lib/changelog.ts`.

## Open questions

- Re-sync (phase 9): keep old chunks until nothing cites them, or keep only the cited ones?
- Disagreements (phase 10): is it worth running when the sources mostly agree, or should Studio check first and say so?
- Video overviews (phase 12): does narrating slides without a video export meet the need, or is the export what people want?

- Which text-to-speech provider comes first for audio overviews.
- Small local models stay grounded poorly. Should a notebook warn about this or suggest a stronger model?
- Size caps per source and per notebook.
- Whether YouTube captions can be fetched reliably without an API key. Pasting a transcript is the fallback either way.
