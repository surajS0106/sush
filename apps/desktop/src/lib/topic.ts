// The `topic_lookup` tool: photos and articles about a person, place or thing, as a card
// in the chat (`components/topic-card.tsx`), and the article's text for the model to
// answer from. It comes from Wikipedia through Rust (`sush_core::topic`), with no key.

import { api, errorMessage, type Topic, type ToolSpec } from "@/lib/tauri";
import { autoPlacedTexts, type PlaceablePhoto } from "@/lib/topic-placement";

export const TOPIC_LOOKUP = "topic_lookup";

const MAX_QUERY = 200;
const MAX_CAPTION = 120;
/** Photos on the card above the reply; the model places the others between its sections. */
export const PHOTOS_ON_CARD = 3;

export const topicTool: ToolSpec = {
  name: TOPIC_LOOKUP,
  description:
    "Get photos, a reliable summary and articles about a notable subject, and show the photos and articles to the user as a " +
    "card. Call it before answering whenever the user asks who or what a person, place, organisation, event, " +
    "creative work, animal, or historical or scientific subject is, or asks to learn about one. That includes " +
    "questions about a notable subject's recent news, roles or upcoming work (a film's cast, a person's new job): " +
    "call it for the subject's photos and background as well as web_search for what's new, not instead of it. " +
    "Don't call it for code, maths, advice, opinions, writing, the user's own work, or news with no notable subject.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The subject's full name as an encyclopedia would title it, in English: 'John F. Kennedy', not 'who was jfk'.",
      },
    },
    required: ["query"],
  },
};

const NOTE =
  "The user sees the photos in `onCard` (their captions) and `references` on a card above your reply, so never say the " +
  "lookup found no photos when `onCard` has some. Don't add image links or a list of sources. " +
  "Place photos from `photos` between your sections: after a section, on a line of its own, write [photos](4) or up to " +
  "three together as [photos](5,6), using the numbers of photos whose captions fit that section. Use a photo once, place " +
  "one wherever a caption fits, and leave a section without one when none does. Open with one direct sentence that bolds the subject's name, then, for who or what " +
  "the subject is, a full overview: key facts as a short list, what it's known for, and why it matters, in headed " +
  "sections where there's enough to say. For a narrower question, answer it fully with the context around it. Base facts on `extract`. Right after a fact from it, " +
  'write the marker [cite](URL "TITLE") with `url` and `title`, which the app shows as a numbered source. You have only ' +
  "read the titles of `references`, so don't say what they claim. If this is the wrong subject, call the tool again " +
  "with a more exact name.";

/** What the tool's output holds; `cardOnly` stays out of what the model reads. */
export interface TopicOutput extends Omit<Topic, "images"> {
  /** The captions of the photos already on the card, so the model knows they were shown. */
  onCard: string[];
  /** The photos the model can place, numbered from 1 by their place in `cardOnly.images`. */
  photos: { id: number; caption: string }[];
  note: string;
  cardOnly: { images: Topic["images"] };
}

export async function runTopicLookup(input: unknown): Promise<{ output: TopicOutput } | { errorText: string }> {
  const { query } = (input ?? {}) as { query?: unknown };
  if (typeof query !== "string" || !query.trim()) return { errorText: "topic_lookup needs a `query`." };
  if (query.length > MAX_QUERY) return { errorText: `\`query\` must be ${MAX_QUERY} characters or fewer.` };
  let topic: Topic | null;
  try {
    topic = await api.topicLookup(query.trim());
  } catch (e) {
    return { errorText: `Couldn't look that up: ${errorMessage(e)}. Answer from what you know and say the photos and articles couldn't be loaded.` };
  }
  if (!topic) return { errorText: `Found no article for "${query}". Try its full name, or answer from what you know.` };
  const { images, ...rest } = topic;
  const photos = images.flatMap((image, i) =>
    i >= PHOTOS_ON_CARD && image.caption ? [{ id: i + 1, caption: image.caption.slice(0, MAX_CAPTION) }] : [],
  );
  const onCard = images.slice(0, PHOTOS_ON_CARD).map((image) => image.caption?.slice(0, MAX_CAPTION) ?? `A photo of ${topic.title}`);
  return { output: { ...rest, onCard, photos, note: NOTE, cardOnly: { images } } };
}

/** The photos a `[photos](…)` marker names, from the latest lookup before it in the message. */
export function placedPhotos(parts: readonly unknown[], at: number, ids: number[]): { title: string; images: Topic["images"] } | null {
  for (let i = at - 1; i >= 0; i--) {
    const part = parts[i] as { type?: string; toolName?: string; state?: string; output?: TopicOutput };
    if (part.type !== "dynamic-tool" || part.toolName !== TOPIC_LOOKUP || part.state !== "output-available") continue;
    const all = part.output?.cardOnly?.images ?? [];
    const images = ids.filter((id) => id > PHOTOS_ON_CARD).flatMap((id) => all[id - 1] ?? []);
    return images.length > 0 ? { title: part.output?.title ?? "", images } : null;
  }
  return null;
}

/** A lookup's photos left for the fallback to place: the ones off the card that have captions. */
function placeable(part: unknown): { photos: PlaceablePhoto[]; subject: string } | null {
  const p = part as { type?: string; toolName?: string; state?: string; output?: TopicOutput };
  if (p.type !== "dynamic-tool" || p.toolName !== TOPIC_LOOKUP || p.state !== "output-available") return null;
  const photos = (p.output?.cardOnly?.images ?? []).flatMap((image, i) => (i >= PHOTOS_ON_CARD && image.caption ? [{ id: i + 1, caption: image.caption }] : []));
  return { photos, subject: p.output?.title ?? "" };
}

/** A finished reply's text parts with photos placed, for when the model placed none itself. */
export const autoPlacedPhotos = (parts: readonly { type: string; text?: string }[]) => autoPlacedTexts(parts, placeable);
