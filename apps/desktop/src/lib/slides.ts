// Slide decks: presentations the model writes with `slides_write`. Like
// artifacts, each call is a version and calls sharing an `id` are one deck's
// history, read back from the conversation's tool calls. The open deck shows
// in a side panel beside the chat (components/slides-panel.tsx).

import { useSyncExternalStore } from "react";

import { DEFAULT_THEME, isLayout, isTheme, LAYOUT_GUIDE, LAYOUTS, THEME_NAMES, themeCss, type Layout, type ThemeName } from "@/lib/slide-themes";
import { createStore } from "@/lib/store";
import { api, type ToolSpec } from "@/lib/tauri";
import type { SushUIMessage } from "@/lib/transport";

export const SLIDES_WRITE = "slides_write";

/** Every slide is laid out on this canvas and scaled to fit wherever it's shown. */
export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

export const slidesTool: ToolSpec = {
  name: SLIDES_WRITE,
  description:
    "Show a slide deck (a presentation) in a panel beside the chat, where the user can page through it, present it, " +
    "comment on slides and export it to PowerPoint. Use it whenever the user asks for slides, a deck, a ppt or a presentation. " +
    "Pick a `theme` that suits the topic and a `layout` for each slide; the theme supplies the colors, fonts, spacing and " +
    "decorative shapes, so each slide's `html` is just its content: semantic tags and the classes below, with no wrapper " +
    "and no inline styles. Vary layouts: open with cover, end with closing, and don't use the same layout twice in a row. " +
    LAYOUT_GUIDE +
    " Keep slides short: a heading and at most ~35 words or 5 bullets. Put what the presenter would say in `notes`. " +
    "Only add `css` for something the layouts can't do (it applies to every slide; `.slide` is each 1920×1080 slide's root; " +
    "scripts and web fonts are not loaded). Pictures: never invent image URLs; write <img data-search=\"…\" alt=\"…\"> and " +
    "the app finds a real picture on Wikipedia for the search, so name the subject plainly as a Wikipedia article would " +
    "(e.g. data-search=\"Ichigo Kurosaki\", data-search=\"Mount Fuji\"), not a description of the shot. Use src only for a " +
    "URL the user gave you. No CSS background images. A picture that can't be found is dropped, so each slide must read " +
    "well without it. Always pass the complete deck. To revise it, call this again " +
    "with the same id and every slide, changed or not; each call becomes a new version. Don't repeat the slide text in " +
    "your reply; summarise in a few lines what you made or changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Short kebab-case slug, kept the same across revisions, e.g. 'q3-review'" },
      title: { type: "string", description: "The deck's title, e.g. 'Q3 Review'" },
      note: { type: "string", description: "What this version is or changed, in a few words, e.g. 'Warmer palette'" },
      theme: {
        type: "string",
        enum: THEME_NAMES,
        description:
          "ember: dark plum, terracotta and gold, serif. paper: warm off-white and clay, serif. ocean: deep navy and teal, " +
          "bold sans. forest: sage and deep green, serif. mono: black with a red-orange accent, tight sans. blush: soft pink and berry, serif.",
      },
      css: { type: "string", description: "Optional extra CSS for every slide" },
      slides: {
        type: "array",
        description: "Every slide, in order",
        items: {
          type: "object",
          properties: {
            layout: { type: "string", enum: [...LAYOUTS] },
            html: { type: "string", description: "The slide's content, e.g. '<p class=\"eyebrow\">Q3</p><h2>Revenue <em>doubled</em></h2>'" },
            notes: { type: "string", description: "Speaker notes" },
          },
          required: ["layout", "html"],
        },
      },
    },
    required: ["id", "title", "theme", "slides"],
  },
};

interface SlidesInput {
  id?: string;
  title?: string;
  note?: string;
  theme?: string;
  css?: string;
  slides?: unknown;
}

export interface Slide {
  layout: Layout | null;
  className: string;
  html: string;
  notes: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A slide's root that the model wrote itself, though the renderer adds one: `<div class="slide …">…</div>`. */
const OWN_ROOT = /^\s*<(div|section)\s+class=["']([^"']*\bslide\b[^"']*)["'][^>]*>([\s\S]*?)(?:<\/\1>)?\s*$/i;

/**
 * Slides as written, forgiving what models get wrong: the array sent as a JSON string, `content` or `body`
 * for `html`, a bare string per slide, or their own `.slide` root around the content.
 */
function readSlides(raw: unknown): (Slide | null)[] {
  let list = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const o = (typeof item === "string" ? { html: item } : (item ?? {})) as Record<string, unknown>;
    let html = str(o.html) ?? str(o.content) ?? str(o.body);
    if (html === undefined) return null;
    const classes = (str(o.class) ?? str(o.className) ?? "").split(/\s+/).filter(Boolean);
    const own = OWN_ROOT.exec(html);
    if (own) {
      html = own[3];
      classes.push(...own[2].split(/\s+/).filter((c) => c && c !== "slide"));
    }
    const layout = [o.layout, ...classes].find(isLayout) ?? null;
    return { layout, className: classes.filter((c) => c !== layout).join(" "), html, notes: str(o.notes) ?? str(o.speakerNotes) ?? "" };
  });
}

export function validateSlides(input: unknown): string | null {
  const d = (input ?? {}) as SlidesInput;
  if (typeof d.id !== "string" || !d.id.trim()) return "slides_write needs an `id`.";
  if (typeof d.title !== "string" || !d.title.trim()) return "slides_write needs a `title`.";
  const slides = readSlides(d.slides);
  if (slides.length === 0) return "slides_write needs `slides`: an array of { layout, html, notes }.";
  const missing = slides.findIndex((s) => !s);
  if (missing >= 0) return `Slide ${missing + 1} has no \`html\`. Each slide is { layout, html, notes }.`;
  return null;
}

export interface DeckVersion {
  label: string;
  note: string;
  title: string;
  theme: ThemeName;
  /** The theme's CSS followed by the deck's own. */
  css: string;
  slides: Slide[];
}

export interface DeckView {
  id: string;
  /** The tool call that wrote the newest of `versions`. */
  callId: string;
  versions: DeckVersion[];
  /** The newest version is still streaming in. */
  building: boolean;
}

export interface Decks {
  /** Each call as its card shows it: the deck's versions up to and including that call. */
  byCall: Map<string, DeckView>;
  /** Each deck with all its versions, by deck id. */
  byId: Map<string, DeckView>;
}

/** Every deck in a conversation. Failed calls aren't versions. */
export function deckViews(messages: SushUIMessage[]): Decks {
  const byCall = new Map<string, DeckView>();
  const byId = new Map<string, DeckView>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "dynamic-tool" || p.toolName !== SLIDES_WRITE || p.state === "output-error") continue;
      // Streaming input is parsed as it arrives, so any field may still be missing.
      const input = (p.input ?? {}) as SlidesInput;
      const id = typeof input.id === "string" && input.id ? input.id : p.toolCallId;
      const versions = byId.get(id)?.versions.slice() ?? [];
      const n = versions.length + 1;
      const prev = versions.at(-1);
      const theme = isTheme(input.theme) ? input.theme : (prev?.theme ?? DEFAULT_THEME);
      versions.push({
        label: `v${n}`,
        note: (typeof input.note === "string" && input.note) || (n === 1 ? "Created" : "Revised"),
        title: (typeof input.title === "string" && input.title) || prev?.title || "Untitled",
        theme,
        css: `${themeCss(theme)}\n${typeof input.css === "string" ? input.css : ""}`,
        slides: readSlides(input.slides).filter((sl): sl is Slide => !!sl),
      });
      const view = { id, callId: p.toolCallId, versions, building: p.state === "input-streaming" };
      byCall.set(p.toolCallId, view);
      byId.set(id, view);
    }
  }
  return { byCall, byId };
}

// --- the open deck ------------------------------------------------------------------

export interface DeckPanelState {
  deckId: string;
  /** Index into the deck's versions, or null to follow the newest. */
  version: number | null;
  /** The panel covers the chat. */
  expanded: boolean;
}

/** The deck shown beside each thread, by thread id. Not persisted: a reload starts with the panel closed. */
const panels = createStore<ReadonlyMap<string, DeckPanelState>>("sush.deck-panels", new Map(), false);

export const useDeckPanel = (threadId: string) =>
  useSyncExternalStore(panels.subscribe, () => panels.get().get(threadId) ?? null);

function setPanel(threadId: string, state: DeckPanelState | null) {
  panels.set((prev) => {
    const next = new Map(prev);
    if (state) next.set(threadId, state);
    else next.delete(threadId);
    return next;
  });
}

export const openDeck = (threadId: string, deckId: string, version: number | null = null) =>
  setPanel(threadId, { deckId, version, expanded: panels.get().get(threadId)?.expanded ?? false });
export const closeDeck = (threadId: string) => setPanel(threadId, null);
export function setDeckExpanded(threadId: string, expanded: boolean) {
  const cur = panels.get().get(threadId);
  if (cur) setPanel(threadId, { ...cur, expanded });
}

/** Calls the panel already opened for, so closing it while a deck streams keeps it closed. */
const autoOpened = new Set<string>();

/** Opens the panel the first time a call starts writing a deck. */
export function autoOpenDeck(threadId: string, view: DeckView) {
  if (!view.building || autoOpened.has(view.callId)) return;
  autoOpened.add(view.callId);
  openDeck(threadId, view.id);
}

// --- rendering ----------------------------------------------------------------------

const BASE_CSS = `
:host { all: initial; display: block; }
.slide {
  position: relative; width: ${SLIDE_W}px; height: ${SLIDE_H}px; overflow: hidden; box-sizing: border-box;
  background: #fff; color: #1c1917; font-family: "Geist Variable", system-ui, sans-serif; line-height: 1.25;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.slide *, .slide *::before, .slide *::after { box-sizing: border-box; }
.slide :where(h1, h2, h3, h4, p, ul, ol, figure, blockquote) { margin: 0; }
.slide img[data-remote], .slide img[data-search] { visibility: hidden; }
`;

/**
 * Removes anything that runs code or loads from elsewhere. The CSP blocks both too; this keeps markup tidy.
 * With `deferImages`, web images keep their URL in `data-remote` for `loadRemoteImages`, since the CSP won't load them.
 */
export function sanitizeHtml(html: string, deferImages = false): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.body.querySelectorAll("script, iframe, frame, object, embed, link, meta, base, form, style").forEach((n) => n.remove());
  for (const el of doc.body.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if (/^(href|src|xlink:href|action|formaction)$/.test(name) && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  if (deferImages) {
    for (const img of doc.body.querySelectorAll("img")) {
      const src = img.getAttribute("src")?.trim() ?? "";
      img.removeAttribute("srcset");
      if (!/^https?:\/\//i.test(src)) continue;
      img.removeAttribute("src");
      img.setAttribute("data-remote", src);
    }
  }
  return doc.body.innerHTML;
}

const sanitizeCss = (css: string) => css.replace(/@import[^;]*;?/gi, "");

const slideClass = (slide: Slide) =>
  `slide ${slide.layout ? `layout-${slide.layout} ` : ""}${slide.className.replace(/[^\w\s-]/g, "")}`.trim();

/** The markup a slide's shadow root holds. */
export function slideMarkup(css: string, slide: Slide): string {
  return `<style>${BASE_CSS}${sanitizeCss(css)}</style><div class="${slideClass(slide)}">${sanitizeHtml(slide.html, true)}</div>`;
}

/** Web images by URL or search: their blob URL once downloaded, or null if there wasn't one. Kept for the session. */
const remoteImages = new Map<string, Promise<string | null>>();

function cached(key: string, load: () => Promise<string>): Promise<string | null> {
  let p = remoteImages.get(key);
  if (!p) {
    p = load().catch(() => null);
    remoteImages.set(key, p);
  }
  return p;
}

const fetchImage = (url: string) => cached(`url:${url}`, () => api.imageFetch(url.replace(/^http:/i, "https:")));
const searchImage = (query: string) => cached(`search:${query.trim().toLowerCase()}`, () => api.imageSearch(query));

/**
 * The blob URL for a deferred image (see `sanitizeHtml`): its own URL if that loads, else a search for
 * `data-search` or, failing that, its alt text, since models often write URLs that don't exist.
 */
async function resolveImage(img: Element): Promise<string | null> {
  const remote = img.getAttribute("data-remote");
  const src = remote ? await fetchImage(remote) : null;
  if (src) return src;
  const query = img.getAttribute("data-search")?.trim() || img.getAttribute("alt")?.trim();
  return query ? searchImage(query) : null;
}

const isDeferred = (img: Element) => img.hasAttribute("data-remote") || img.hasAttribute("data-search");

/** Drops an image that can't be shown, and a figure left with nothing else in it. */
function dropImage(img: Element) {
  const figure = img.closest("figure");
  img.remove();
  if (figure && !figure.querySelector("img, svg") && !figure.textContent?.trim()) figure.remove();
}

/**
 * Shows the web images in rendered slide markup (see `sanitizeHtml`): each is downloaded in Rust and served
 * from the blob store. Images that fail, there or in the browser, are removed so the slide doesn't show a broken
 * picture. Resolves once every image has loaded or been removed.
 */
export async function loadRemoteImages(root: ParentNode): Promise<void> {
  const imgs = [...root.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(
    imgs.map(async (img) => {
      if (isDeferred(img)) {
        const src = await resolveImage(img);
        if (!img.isConnected) return;
        if (!src) return dropImage(img);
        img.src = src;
      }
      try {
        await img.decode();
        img.removeAttribute("data-remote");
        img.removeAttribute("data-search");
      } catch {
        if (img.isConnected) dropImage(img);
      }
    }),
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The bundled fonts' names, also matched by their Google Fonts names in an exported file. */
const withWebFonts = (s: string) =>
  s.replace(/(["']?)(Geist|Lora|Plus Jakarta Sans) Variable\1/g, (_m, _q, family) => `'${family} Variable', '${family}'`);

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Lora:ital,wght@0,400..700;1,400..700" +
  "&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&family=DM+Mono:ital,wght@0,400;0,500;1,400" +
  "&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap";

/** A slide's markup with its web and searched images inlined as `data:` URLs, so the file works offline. */
async function withInlineImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeHtml(html, true)}</body>`, "text/html");
  for (const img of doc.body.querySelectorAll("img")) {
    if (!isDeferred(img)) continue;
    const blob = await resolveImage(img);
    const data = blob ? await api.blobDataUrl(blob).catch(() => null) : null;
    if (!data) {
      dropImage(img);
      continue;
    }
    img.setAttribute("src", data);
    img.removeAttribute("data-remote");
    img.removeAttribute("data-search");
  }
  return doc.body.innerHTML;
}

/** A standalone HTML file of the deck: slides stacked and scaled to the window, one per page when printed. */
export async function exportDeckHtml(version: DeckVersion): Promise<string> {
  const bodies = await Promise.all(version.slides.map((s) => withInlineImages(s.html)));
  const slides = version.slides
    .map((s, i) => `<div class="frame"><div class="${slideClass(s)}">${bodies[i]}</div></div>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(version.title)}</title>
<link rel="stylesheet" href="${FONTS_URL}">
<style>
html, body { margin: 0; background: #141414; }
.deck { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px; }
.frame { width: min(100%, 1280px); aspect-ratio: 16 / 9; overflow: hidden; border-radius: 8px; }
.frame > .slide { transform: scale(var(--s, 0.6667)); transform-origin: 0 0; }
${BASE_CSS.replace(":host { all: initial; display: block; }", "")}
${withWebFonts(sanitizeCss(version.css))}
@page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
@media print {
  html, body { background: none; }
  .deck { padding: 0; gap: 0; }
  .frame { width: ${SLIDE_W}px; border-radius: 0; break-after: page; }
  .frame > .slide { transform: none; }
}
</style>
</head>
<body>
<main class="deck">
${withWebFonts(slides)}
</main>
<script>
const fit = () => document.querySelectorAll(".frame").forEach((f) => f.style.setProperty("--s", f.clientWidth / ${SLIDE_W}));
addEventListener("resize", fit);
fit();
</script>
</body>
</html>
`;
}

export const deckFileName = (title: string, ext: "html" | "pptx") =>
  `${title.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").toLowerCase() || "slides"}.${ext}`;
