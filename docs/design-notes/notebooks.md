# Notebooks — Design Notes

Last updated: 2026-11-10

## What changed

### 2026-11-10 (test pass, fewer tokens, Studio options)
- Fixed two things that stopped CI: a test still building `ChatEvent::Citation` without `quote` (`providers/openai_responses.rs`), and an unused import in `components/notebook-studio.tsx`.
- Fewer tokens per request:
  - **Earlier turns' passages are cut to a line** (`compact_earlier_passages`, called in `agent/run.rs` before each request). A `source_search`/`source_read` result from before the latest user message goes as one line naming each passage (title and `sushsrc:` id) instead of its text. The answers stay whole and the model can search again. Only the turn before the newest question changes, and only once, so the cached start of the conversation still matches.
  - **A search doesn't repeat itself within a turn** (`seen_this_turn`, read in `runs.rs` from the thread as saved at each step). Passages this answer already got are named in a note (`message::SEARCH_NOTE`, a text block after the `search_result`s on Anthropic) and new ones fill their places. Studio runs, which search many times, gain the most.
  - **Studio runs get a reading plan** (`READING_PLAN` in `studio_section`): read short sources whole with `source_read`, search the long ones with several words at once, and stop when there's enough. The system prompt now lists a PDF's passages as well as its pages, so the model can tell which sources are short.
  - **The overview covers every ready source**, not just the ticked ones (`sources_key`, `sourcesKey`). Before, ticking a source off and on for one question wrote the overview twice.
  - Guides and overviews ask Rust only for the start of each source (`notebook_source_text`'s `limit`), not all of its passages.
- Bug: deleting a notebook stopped its chats but not its Studio runs, which went on reading (and spending) until they ended. `notebook_delete` now stops those too.
- Studio options (from the plan, not built until now): each Studio card has an options button for a focus, a length (shorter, default, longer) and a language (`StudioOptionsDialog`). They go in the run's first message (`studioRequest`), and `studio_section` says how to follow them. "Try again" and the new "Make again" reuse the first message, so they keep the options (`remakeStudio`). A finished output stays until you delete it.
- Notes and documents can be saved as Markdown files (`exportNote`, through `save_text_file_as`).

### 2026-11-09 (phase 6: sharing a notebook's chat)
- A notebook's chat can be shared live through Sush's existing sharing, from the notebook menu ("Share this chat live…"). It gets the same roles, encryption and activity log as any shared session.
- What guests get by default:
  - The chat, with citation chips naming their sources.
  - The notebook's source titles and finished Studio outputs: a Notebook tab in their side panel (`components/shared-notebook.tsx`, `get-notebook`).
  - Not the sources' text: the notebook tools' passages are redacted for every guest (`share/redact.rs`), and passage citations lose their quoted words.
  - Not the owner's notes, and not audio overview clips (guests hear their own computer's voices).
- A new share setting, "Let them read cited passages" (`SharePolicy.show_sources`, off by default), lets guests open a cited passage (`get-passage`). The host checks it's from that notebook's own sources (`notebooks::guest_passage`).
- Tests cover the policy, the redaction, the guest view and the cross-notebook refusal.

### 2026-11-09 (phase 5: audio overviews)
- New Studio kind `audio-overview`.
  - Its run writes a two-host script: 3 to 6 chapters of turns between host `a` and host `b`, about ten minutes. Each turn names its source passage.
  - The script is saved through `studio_save` and checked by `save_studio`: unknown hosts are dropped, it needs 6 to 400 turns, and each turn is capped at the speech endpoint's 4,000 characters.
- `sush_core::tts::speak` calls the OpenAI-compatible `POST /audio/speech` (MP3), which covers OpenAI, Azure Foundry, Groq and local servers like Kokoro-FastAPI. The `tts_speak` command stores each clip as a blob.
- Voices (`lib/voices.ts`, Settings → Speech → Audio overviews):
  - **This computer (the default):** `speechSynthesis` reads each line live with two different voices. It's free, offline and keeps nothing.
  - **A provider:** each line is voiced once with that provider, then kept on the note with the voices that made it (`notebook_note_set_data`, which accepts only blob URLs). Changing voices makes the clips again.
- Player (`components/audio-overview.tsx`):
  - Play/pause, previous and next line, speed from 0.75× to 2×.
  - A position bar weighted by words, with chapter marks, that you can click or use with arrow keys; chapter chips.
  - A transcript that follows along, jumps on click, and shows each line's source.
  - Clips play in order, and the next one is preloaded.
  - It keeps playing while a source is open over it, and stops when the overview closes.
- Making the audio shows progress, saves every 8 clips, can be stopped, and resumes from what's kept.

### 2026-11-09 (phase 4: more kinds of source)
- **YouTube** (`SourceKind::Youtube`):
  - Any link form is recognised (`youtube_id`).
  - Captions are read without a key from the watch page's caption tracks (`web::youtube_transcript`, `json_after`). The language's own captions win over automatic ones, and English over other languages.
  - Captions become paragraphs of about 45 seconds, each starting with its timestamp (`timed_pages`), and the viewer offers "Play from 4:05" (`PlayAt`).
  - If YouTube won't share captions, the error suggests pasting the transcript instead.
- **Audio** (`lib/notebook-audio.ts`):
  - The webview decodes any audio it can play and resamples it to 16 kHz mono (`OfflineAudioContext`).
  - It's transcribed a minute at a time (30 s for Gemma) with the Settings → Speech engine: built-in Whisper or a provider.
  - Each minute starts with its timestamp, and progress shows in the sources panel.
  - The transcript is added as an `audio` source (`notebook_add_text` with a kind); the audio isn't kept.
- **Past chats** (`notebook_add_chat`): the chat's transcript as it is now, chosen from a searchable list. Notebook, report, sub-agent and incognito threads are left out.
- **Cowork files** (`notebook_add_workspace_file`): found by name with `workspace_find`, read through the folder's `WorkspaceFs` (inside it only). Secret-looking files are refused (`looks_secret`), as are binary files; PDFs are read as PDFs.
- The add-sources pop-up has six cards (files, links and videos, text, audio, past chat, Cowork folder). Dropped audio is transcribed and other files are read. The notebook composer menu gained Past chat and Cowork folder.

### 2026-11-09 (phase 3: quiz, flashcards, mind map)
- New Studio kinds `quiz`, `flashcards` and `mind-map` (`NoteKind::interactive`).
  - Their runs get a `studio_save` tool with a schema per kind (`studio_save_spec`), and must call it once with the whole result.
  - `save_studio` checks and tidies the input before it's kept as `Note::data`:
    - a quiz's answer index must be in range, with 2 to 5 options;
    - blank cards and nodes are dropped;
    - a map has at most 120 nodes, 5 levels deep;
    - sources must be `sushsrc:` passage ids.
  - Problems go back to the model to fix. A run that ends without saving is marked failed (`studio_finished`).
- Players (`apps/desktop/src/components/notebook-play.tsx`):
  - **Quiz:** one question at a time. Answers are marked right or wrong with an explanation and the passage it comes from. It ends with a score, the questions to review, and a retake.
  - **Flashcards:** a 3D flip (reduced-motion safe). "Again" and "Got it" thin the deck. Shuffle, and keys: Space flips, arrows move, 1 and 2 answer.
  - **Mind map:** laid out left to right without a new dependency (`layout`: a row per visible leaf, parents centred on their children). It starts collapsed below two levels; nodes collapse and expand. A selected node shows its path, note, source and "Ask about this", which sends the question to the notebook's chat. "Open large" shows it in a dialog.
- The note reader stays mounted under a passage opened from it, so a quiz or deck in progress survives a look at the source (`components/notebooks-page.tsx`).

### 2026-11-09 (phase 2: notes and Studio; phase 1 gaps)
- Notes (`notebook_notes`, migration 10; `Note` in `crates/sush-core/src/notebooks.rs`):
  - Written by hand, or "Save to note" under any notebook answer (`components/chat-view.tsx`), with their citation markers kept. They render with live chips (`NoteBody` in `components/notebook-studio.tsx`).
  - Editable as Markdown.
  - "Add as a source" copies a note into a text source.
- Studio: Briefing, Study guide, FAQ and Timeline.
  - Each is a note marked "writing", whose run is a thread of its own (`notebook_studio_start`, `lib/notebook-studio.ts`).
  - `runs.rs` gives that thread the notebook's source tools and `studio_section(kind)`.
  - When the run ends, `studio_finished` files its final reply (the text after its last tool call) as the note: the `# ` heading becomes the title, the rest the body. A stopped or failed run is recorded with its reason, and offers Try again.
- The notebook's right column (`components/notebooks-page.tsx`):
  - It's the Studio panel by default, a note when one's open, and the source viewer when a source or citation is.
  - On narrow windows it floats, with a header toggle.
- Scanned PDFs: a PDF with no text layer (`PdfProblem::Scanned`) is read by the model the user last picked (`notebook_set_reader`).
  - It's split into small PDFs of six pages with `lopdf` (`pdf_batches`).
  - Each batch is sent as a document, and the reply's `<page>` blocks are mapped back to real page numbers (`parse_transcription`).
  - Up to 300 pages are read.
- Files dropped on the sources panel become sources (`useSourceDrop`), with a drop target shown while dragging.
- Notebook chats and Studio runs now get the user's own context, below the notebook's rules (`notebookContext` in `lib/agent.ts`, `notebook_config` in `runs.rs`): the answer style and, when memory is on, Sush's memory of them, read-only.

### 2026-11-09 (framing the cover)
- In Customize, a cover's "Adjust" mode frames the picture (`CoverAdjuster` in `apps/desktop/src/components/notebook-overview.tsx`):
  - Drag it, or use the arrow keys (Shift for bigger steps), to choose what stays in view.
  - Zoom from 100% to 300% with a slider, its buttons, or + and −.
  - Reset puts it back to centred.
  - A newly added cover opens in this mode.
- Cover changes wait for the dialog's Done (`notebook_customize` now takes the cover; `notebook_pick_cover` only stores the picked image and returns it).
  - While framing, Cancel brings back the previous picture and framing. It's labelled "Keep the old cover" after picking a replacement, and "Don't add it" for a first cover.
  - Remove is a draft too, with "Undo remove".
  - Closing the dialog without Done changes nothing.
  - Rust accepts only a cover stored as a blob, so the webview can't set an arbitrary address.
- The framing is saved with Done as `coverPosition` (focus point x/y in percent, zoom), clamped in Rust (`CoverPosition::clamped`). It isn't stored while the cover is centred, and it's dropped when there's no picture.
- The overview, the notebook card and the dialog all draw the cover through `CoverImage`: `object-position` at the focus point, scaled around it, so a wide banner and a short card both keep the same part in view.

### 2026-11-09 (overview, source guides, customizing)
- Each empty notebook chat opens on an overview (`apps/desktop/src/components/notebook-overview.tsx`):
  - A cover, or an accent wash if there's none, with the emoji and title.
  - "N sources · date".
  - A summary of the sources with key terms in bold, which you can copy or rewrite.
  - Three suggested questions that send when clicked. `ChatView`'s `emptyState` can now be a function that gets `ask`.
- The overview is written by the model last used, from the start of each checked source (`apps/desktop/src/lib/notebook-guides.ts`).
  - It's written again when the checked sources change (`sourcesKey`), once none are still being read.
  - While the notebook is untitled and has no emoji, the model's suggested title and emoji are applied (`notebook_set_overview`).
- The source viewer opens with a source guide: a summary plus key topics. Picking a topic puts a question about it in the composer. The guide is written the first time a source is opened, and again after the source is read again (`SourceGuide.chunks`).
- A Customize dialog sets the title, emoji, a cover image and your own summary, which replaces the generated one (`notebook_customize`, `notebook_pick_cover`). It opens from the overview's cover and from the notebook menu.
- Storage (`crates/sush-core/src/notebooks.rs`):
  - Notebooks gained a `data` JSON column (`NotebookExtras`, migration 9), flattened into `Notebook` for the UI.
  - Renaming a notebook marks it `named`, so overviews stop suggesting titles.

### 2026-11-09 (adding sources, and the composer in a notebook)
- One "Add sources" pop-up replaces the sources panel's dropdown and its two dialogs (`apps/desktop/src/components/notebook-sources.tsx`). It holds:
  - A web search for sources: results you tick to add, with ones already added marked.
  - Cards for uploading files, links and papers, and pasted text.
  - A drop zone for files.
- Links and papers take several addresses at once and label each as a paper or a web page before you add them.
- Any code can open the pop-up with `openAddSources(notebookId, view)` (`lib/notebooks.ts`).
- Dropped files are sent as their bytes through the new `notebook_add_file_data` command (`apps/desktop/src-tauri/src/notebooks.rs`); the webview never names a path.
- In a notebook chat, the composer (`components/composer.tsx`):
  - Shows a notebook menu instead of the general one: add sources, tick which sources answers use, or attach a file to one message only.
  - Shows a strip with "Answers use N of M sources" and "Add sources" instead of "Work in a folder" and "Connect apps".
  - Hides the approval-mode switch.
  - Hides the `/` and `@` hints.
  - Uses its own placeholder.
- The composer menu's shell (its width, sections and label-with-hint rows) is exported for this, so both menus look and behave the same (`components/composer-menu.tsx`).

### 2026-11-09 (phase 1: sources and cited chat)
- New `sush_core::notebooks` (`crates/sush-core/src/notebooks.rs`):
  - Types for notebooks and sources, plus their tables, added as one migration to `sush.db` (`notebooks`, `notebook_threads`, `notebook_sources`, `source_chunks`, `source_chunks_fts`).
  - PDF text extracted page by page with `lopdf`, wrapped so a malformed PDF can't crash the app (`catch_unwind`).
  - Recognising arXiv ids and links and DOIs.
  - Chunking: about 1,500 characters, never across a page, carrying the nearest heading.
  - BM25 search, with headings weighted twice as much as body text.
  - The `source_search` and `source_read` tools, and the system prompt section for notebook chats.
- `web::fetch_source` reads a whole page or a PDF (up to 64 MB) with the same checks `web_fetch` uses: public addresses only, every redirect re-checked. The shared redirect loop moved into `get_public` (`crates/sush-core/src/web.rs`).
- Tool outputs can carry citable passages, under `message::SEARCH_RESULTS` (`crates/sush-core/src/message.rs`).
  - Anthropic sends them as `search_result` blocks with citations enabled.
  - OpenAI and the Responses API get the same passages as plain text (`tool_output_text`).
- The Anthropic decoder now keeps `search_result_location` citations and the `cited_text` of each citation (`crates/sush-core/src/providers/anthropic.rs`).
  - `ChatEvent::Citation` gained a `quote` field.
  - Passage markers carry that quote as `sushsrc:<source>/<chunk>?q=…` (`crates/sush-core/src/agent/ui.rs`).
- Tauri commands for notebooks, adding sources, checking them and reading them again (`apps/desktop/src-tauri/src/notebooks.rs`).
  - Sources are read in the background, three at a time.
  - Each change reaches every window as a `notebook` frame.
- A thread listed in `notebook_threads` gets `notebook_config` (`apps/desktop/src-tauri/src/runs.rs`):
  - Only the source tools (`ToolExec::Notebook`, run without asking).
  - The notebook's system section, in place of the UI's tools and prompt.
  - Whether to cite natively, decided by the provider's wire format.
- The Notebooks sidebar page (`apps/desktop/src/components/notebooks-page.tsx`, `apps/desktop/src/lib/notebooks.ts`):
  - A notebook list.
  - A sources column with checkboxes and status.
  - The ordinary `ChatView` with an `emptyState` slot.
  - A source viewer that scrolls to a cited passage and marks the quoted words.
- Wiring:
  - Citation chips for passages open the viewer (`lib/citations.ts`, `components/artifact-sources.tsx`, `components/ui/Sources.tsx`).
  - Notebook chats stay out of the session list (`components/app-sidebar.tsx`).
  - Source tool calls render as one-line rows (`components/tool-parts.tsx`, `components/activity-group.tsx`).

## Why

A notebook should answer from its sources and show where each claim comes from, with any provider Sush supports. Retrieval is BM25 over SQLite FTS5, which Sush already ships for past-chat search. The user chose BM25 over embeddings: it needs no model download, no key and no vector store. The cost is that searches match words, not meaning, so the tool description tells the model to search again with the terms the sources would use.

Citations use the provider's own mechanism where it exists. Anthropic cites `search_result` blocks itself and returns the exact words cited, which a model writing its own markers can't be trusted to get right. Other providers write `[cite](sushsrc:…)` markers by instruction. Both paths produce the same text markers, so the UI has one way to render citations, and replies stay readable if a chat is opened as a normal session.

The source tools run in Rust and read the notebook fresh on every call, because sources are added and checked during a chat. Notebook chats get no UI tools (memory, web search, connectors). That keeps answers grounded in the sources, and the system prompt doesn't describe tools the run can't use. The trade-off is that the user's own system instructions don't apply in notebook chats yet.

The general composer menu offered Research, Memory, skills, connectors and design systems, none of which a notebook chat uses, since its run gets only the source tools. "Work in a folder" was worse: picking a folder would turn a notebook chat into a Cowork session. The notebook menu offers only what applies there, in the same visual language. Attaching a file to one message stays available, and is labelled so it isn't mistaken for adding a source. Adding sources was split across a dropdown and two dialogs; one pop-up puts every way in, including finding new sources on the web, in one place.

A notebook should say what's in it before you ask anything. The overview and source guides are generated in the UI with the existing one-shot `complete` helper rather than a Rust run: they're single requests with no tools, so the agent loop would add nothing. They only rewrite when the sources change, which keeps model calls to one per change instead of one per visit. Suggested titles never overwrite a name the user chose: once the user renames a notebook, overviews stop suggesting titles. The cover is chosen through a Rust file dialog and stored as a blob, like other attachments, so the webview never reads a path.

Studio outputs run as agent runs rather than one-shot completions because a briefing of a large notebook needs more than excerpts: the run searches and reads every source, and its citations come from the same mechanism as chat answers, so they open the same passages. Taking the text after the last tool call keeps the run's working notes ("Let me search…") out of the document. Notes and outputs share one table and type because they're the same thing to the reader: a titled, cited Markdown document. Scanned PDFs go to the user's own model rather than a bundled OCR engine. Sush can already send PDFs to Claude and GPT models, which read scans well, and this keeps the download size the same. The cost is a request per six pages, and models that can't read PDFs will fail with an error that says so.

The interactive outputs come through a tool call instead of the reply's text. With Anthropic, the reply's text gets citation markers inserted after cited passages; inside JSON those break it. A tool's input is structured, and can be checked, with what to fix sent back. Each item names its source passage as data rather than as an inline marker, which the players turn into a "From …" chip.

Audio is decoded in the webview rather than in Rust because the webview already plays every common format. A Rust decoder would be a new dependency for the same result. Transcribing a minute at a time costs more requests but gives every passage a timestamp within a minute. YouTube timestamps are written into the passage text rather than stored as a column, so they reach the model, the citations and the viewer with no schema change.

Audio overviews are a script plus clips, not one long recording. That way a stop or failure loses little, one wire format serves both cloud and local voices, and the transcript can follow along and jump. Defaulting to the computer's voices means the feature works without a key or a download; the user picks a provider when they want better voices, knowing it costs per use.

Sharing reuses the session share rather than inventing a notebook share: the chat is where the notebook comes alive, and the share protocol already carries roles, encryption, auditing and the host-is-authoritative rule. Redaction is stateless, so source text is hidden from every guest in the stream, and reading a passage became a separate request the host checks against the owner's setting. A guest can't get text from the stream that the owner hasn't chosen to share.

Pinned sources sent whole (as `document` blocks with a one-hour cache) were in the plan for phase 1. They are deferred: `source_read` already reaches any page or stretch of a source in order, and pinning adds a second path into the request for little gain at this stage.

## What makes it stand out

- Citations point at one passage, not a whole document. The chip opens the passage in the viewer, scrolled into view, with the cited words marked when the provider supplies them.
- The same notebook chat cites on Anthropic and on OpenAI-compatible or local models. Only the way the markers are produced differs (`notebooks::system_section`).
- Sources are fetched from this machine under `web_fetch`'s rules: public addresses only, and every redirect re-checked. A link can't make Sush read the local network.
- Chunks never cross a PDF page, so every passage citation has a single page number. Headings travel with their chunks and are weighted in ranking.
- Finding sources and adding them happen in one step: web results are ticked and added in place, with ones already added marked.
- Reading a source is stoppable and recoverable. A source that was being read when the app closed is marked failed with a "Read again" action, instead of showing "reading" forever.
- Tests cover chunking and offsets, arXiv and DOI recognition, quote encoding, search over checked sources only, cascade deletes, and the Anthropic round trip (`notebooks.rs`, `anthropic.rs`, `agent/ui.rs`).
