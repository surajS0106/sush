// The fallback for a finished reply whose model placed no `topic_lookup` photos: each
// section gets the photo whose caption best matches its heading and text, if any
// matches well enough. A wrong photo is worse than none, so a weak match adds nothing.

import { stripCitations } from "@/lib/citations";

export interface PlaceablePhoto {
  id: number;
  caption: string;
}

const MAX_PLACED = 4;
const HEADING_WEIGHT = 3;
// One shared word is too often a coincidence: "presidency" also fits a map of trips.
const MIN_SHARED = 2;
const MIN_WORD = 4;
// A word in this share of the captions says nothing about any one of them.
const COMMON_SHARE = 1 / 3;
const COMMON_FROM = 6;
const STOP_WORDS = new Set([
  "about", "after", "also", "before", "between", "during", "from", "have", "into", "over", "that", "their", "them", "then", "they",
  "this", "those", "were", "when", "where", "which", "while", "with", "photo", "image", "picture",
]);

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

function words(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of text.toLowerCase().replace(/’/g, "'").split(/[^\p{L}\p{N}']+/u)) {
    const word = raw.replace(/^'+|'+$/g, "").replace(/'s$/, "");
    if (word.length < MIN_WORD || STOP_WORDS.has(word)) continue;
    found.add(word.length > MIN_WORD && word.endsWith("s") ? word.slice(0, -1) : word);
  }
  return found;
}

/** The same word, or nearly: "Cuba" and "Cuban", but not "mass" and "Massachusetts". */
const related = (a: string, b: string) => a === b || (Math.abs(a.length - b.length) <= 2 && (a.startsWith(b) || b.startsWith(a)));

const matches = (caption: Set<string>, section: Set<string>) => [...caption].filter((word) => [...section].some((other) => related(word, other))).length;

interface Section {
  heading: string;
  lines: string[];
}

/** Sections by heading, or by paragraph in a reply that has none. Code blocks are never split. */
function sections(text: string): Section[] {
  const lines = text.split("\n");
  let fenced = false;
  const outside = lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
  const hasHeadings = lines.some((line, i) => outside[i] && HEADING.test(line));
  const out: Section[] = [{ heading: "", lines: [] }];
  lines.forEach((line, i) => {
    const heading = outside[i] ? HEADING.exec(line) : null;
    if (heading) {
      out.push({ heading: heading[1], lines: [line] });
      return;
    }
    out[out.length - 1].lines.push(line);
    if (!hasHeadings && outside[i] && !line.trim()) out.push({ heading: "", lines: [] });
  });
  return out.filter((section) => section.lines.some((line) => line.trim()));
}

const firstLine = (section?: Section) => section?.lines.find((line) => line.trim()) ?? "";
const lastLine = (section: Section) => [...section.lines].reverse().find((line) => line.trim()) ?? "";

/**
 * `text` with `[photos](id)` markers after the sections that match a photo. The photos it
 * uses are removed from `photos`, so the next text in a reply can't use them again.
 */
export function placePhotos(text: string, photos: PlaceablePhoto[], subject: string): string {
  const parts = sections(text);
  const skip = words(subject);
  const candidates = photos.map((photo) => ({ photo, words: words(photo.caption) }));
  const counts = new Map<string, number>();
  for (const { words: caption } of candidates) for (const word of caption) counts.set(word, (counts.get(word) ?? 0) + 1);
  const useful = (word: string) =>
    ![...skip].some((other) => related(word, other)) && (candidates.length < COMMON_FROM || (counts.get(word) ?? 0) / candidates.length <= COMMON_SHARE);
  for (const candidate of candidates) candidate.words = new Set([...candidate.words].filter(useful));

  const placed: Map<number, number> = new Map();
  parts.forEach((section, at) => {
    if (placed.size >= MAX_PLACED) return;
    // The first stretch sits right under the card, and a photo would split a list in two.
    if (at === 0 && !section.heading) return;
    const next = parts[at + 1];
    if (next && !next.heading && LIST_ITEM.test(lastLine(section)) && LIST_ITEM.test(firstLine(next))) return;
    const heading = words(section.heading);
    const body = words(stripCitations(section.lines.filter((line) => !HEADING.test(line)).join(" ")));
    let best: { id: number; score: number } | null = null;
    for (const { photo, words: caption } of candidates) {
      if ([...placed.values()].includes(photo.id)) continue;
      if (matches(caption, new Set([...heading, ...body])) < MIN_SHARED) continue;
      const score = matches(caption, heading) * HEADING_WEIGHT + matches(caption, body);
      if (!best || score > best.score) best = { id: photo.id, score };
    }
    if (best) placed.set(at, best.id);
  });
  if (placed.size === 0) return text;

  for (const id of placed.values()) photos.splice(photos.findIndex((photo) => photo.id === id), 1);
  return parts
    .flatMap((section, at) => {
      const body = section.lines.join("\n").trimEnd();
      const id = placed.get(at);
      return id === undefined ? [body] : [body, `[photos](${id})`];
    })
    .join("\n\n");
}

/** For a finished reply: its text parts with photos placed, by part index. Empty if the model placed any itself. */
export function autoPlacedTexts(parts: readonly { type: string; text?: string }[], photosOf: (part: unknown) => { photos: PlaceablePhoto[]; subject: string } | null): Map<number, string> {
  const out = new Map<number, string>();
  if (parts.some((part) => part.type === "text" && part.text?.includes("[photos]("))) return out;
  let lookup: { photos: PlaceablePhoto[]; subject: string } | null = null;
  parts.forEach((part, i) => {
    lookup = photosOf(part) ?? lookup;
    if (part.type !== "text" || !part.text || !lookup || lookup.photos.length === 0) return;
    const placed = placePhotos(part.text, lookup.photos, lookup.subject);
    if (placed !== part.text) out.set(i, placed);
  });
  return out;
}
