// Profile pictures. The account's `image` (better-auth) holds either an
// uploaded photo as a small JPEG data URL or a built-in avatar's id
// ("sush:avatar/<key>"): pixel-art sushi drawn like the mascot.

const PREFIX = "sush:avatar/";

export interface AvatarDef {
  key: string;
  label: string;
  /** Tile behind the sprite. */
  background: string;
  /** 12×12, one character per pixel; "." is transparent. */
  sprite: string[];
  colors: Record<string, string>;
}

// Shared by every sprite: eyes, blush, rice and nori.
const BASE: Record<string, string> = {
  E: "#2b2b2b",
  P: "#f7a39b",
  R: "#fff8ee",
  r: "#e3d1b8",
  N: "#0f5e5c",
};

const NIGIRI = [
  "............",
  "............",
  "..TTTTTTTT..",
  ".TTtTTTTtTT.",
  "TTTTtTTtTTTT",
  "RRRRRRRRRRRR",
  "RRRERRRRERRR",
  "RRPRRRRRRPRR",
  "RRRRRRRRRRRR",
  "rRRRRRRRRRRr",
  ".rrrrrrrrrr.",
  "............",
];

const MAKI = [
  "............",
  "....NNNN....",
  "..NNRRRRNN..",
  ".NRRRRRRRRN.",
  ".NRERRRRERN.",
  "NRRRFFFFRRRN",
  "NRPRFffFRPRN",
  "NRRRFFFFRRRN",
  ".NRRRRRRRRN.",
  ".NRRRRRRRRN.",
  "..NNRRRRNN..",
  "....NNNN....",
];

export const AVATARS: AvatarDef[] = [
  { key: "salmon", label: "Salmon nigiri", background: "#ffe1d8", sprite: NIGIRI, colors: { T: "#f0533f", t: "#ff8f73" } },
  { key: "maguro", label: "Tuna nigiri", background: "#fbdde2", sprite: NIGIRI, colors: { T: "#c8283c", t: "#e45a6b" } },
  { key: "ebi", label: "Shrimp nigiri", background: "#ffe9d6", sprite: NIGIRI, colors: { T: "#ff8a5c", t: "#fff1e6" } },
  {
    key: "tamago",
    label: "Tamago",
    background: "#fff2c4",
    sprite: [
      "............",
      "............",
      "..TTTNNTTT..",
      ".TTtTNNTtTT.",
      "TTTTtNNtTTTT",
      "RRRRRNNRRRRR",
      "RRRERNNRERRR",
      "RRPRRNNRRPRR",
      "RRRRRNNRRRRR",
      "rRRRRNNRRRRr",
      ".rrrrNNrrrr.",
      "............",
    ],
    colors: { T: "#f6c945", t: "#ffe08a" },
  },
  { key: "sake-maki", label: "Salmon roll", background: "#d9efea", sprite: MAKI, colors: { F: "#f0533f", f: "#ff8f73" } },
  { key: "kappa-maki", label: "Cucumber roll", background: "#e2f2d9", sprite: MAKI, colors: { F: "#3f9b4a", f: "#a8dc8c" } },
  {
    key: "onigiri",
    label: "Onigiri",
    background: "#dce8fb",
    sprite: [
      ".....RR.....",
      "....RRRR....",
      "....RRRR....",
      "...RRRRRR...",
      "...RERRER...",
      "..RPRRRRPR..",
      "..RRRRRRRR..",
      ".RRRRRRRRRR.",
      ".RRRNNNNRRR.",
      "RRRRNNNNRRRR",
      "rrrrNNNNrrrr",
      "............",
    ],
    colors: {},
  },
  {
    key: "wasabi",
    label: "Wasabi",
    background: "#eef3d2",
    sprite: [
      "............",
      "............",
      ".....GG.....",
      "....GGGG....",
      "...GGgGGG...",
      "..GGGGGGGG..",
      "..GEGGGGEG..",
      ".GGPGGGGPGG.",
      ".GGGGGGGGGG.",
      "GGGGGGGGGGGG",
      ".gggggggggg.",
      "............",
    ],
    colors: { G: "#8cc63f", g: "#6aa22a" },
  },
  {
    key: "ikura",
    label: "Ikura",
    background: "#ffe6cc",
    sprite: [
      "............",
      "...IIiIII...",
      "..IiIIIIiI..",
      "NNNNNNNNNNNN",
      "NNNNNNNNNNNN",
      "NNNWNNNNWNNN",
      "NNPNNNNNNPNN",
      "NNNNNNNNNNNN",
      "NNNNNNNNNNNN",
      "nNNNNNNNNNNn",
      ".nnnnnnnnnn.",
      "............",
    ],
    colors: { I: "#f57c1f", i: "#ffc27a", W: "#fff8ee", n: "#0a4644" },
  },
  {
    key: "inari",
    label: "Inari",
    background: "#f6e7cf",
    sprite: [
      "............",
      "...RRRRRR...",
      "..RRRRRRRR..",
      ".KKKKKKKKKK.",
      "KKKkKKKKkKKK",
      "KKKEKKKKEKKK",
      "KKPKKKKKKPKK",
      "KKKKkKKkKKKK",
      "KKKKKKKKKKKK",
      "kKKKKKKKKKKk",
      ".kkkkkkkkkk.",
      "............",
    ],
    colors: { K: "#d98b3a", k: "#b56a24" },
  },
  {
    key: "temaki",
    label: "Hand roll",
    background: "#fde3ec",
    sprite: [
      "............",
      "..SSRRRRGG..",
      ".RSSRRRRGGR.",
      "NNNNNNNNNNNN",
      ".NNWNNNNWNN.",
      ".NPNNNNNNPN.",
      "..NNNNNNNN..",
      "..NNNNNNNN..",
      "...NNNNNN...",
      "....NNNN....",
      ".....NN.....",
      "............",
    ],
    colors: { S: "#f0533f", G: "#3f9b4a", W: "#fff8ee" },
  },
  {
    key: "matcha",
    label: "Matcha",
    background: "#e9e4f6",
    sprite: [
      "............",
      "....h..h....",
      ".....h..h...",
      ".MMMMMMMMMM.",
      "CCCCCCCCCCCC",
      "CCCECCCCECCC",
      "CCPCCCCCCPCC",
      "CCCCCCCCCCCC",
      ".CCCCCCCCCC.",
      "..cccccccc..",
      "...cccccc...",
      "............",
    ],
    colors: { h: "#b3a9cf", M: "#7fa650", C: "#c9b79c", c: "#a89274" },
  },
];

export const avatarId = (key: string) => PREFIX + key;

/** The built-in avatar an account image names, if it names one. */
export function builtinAvatar(image: string | null | undefined): AvatarDef | undefined {
  if (!image?.startsWith(PREFIX)) return undefined;
  const key = image.slice(PREFIX.length);
  return AVATARS.find((a) => a.key === key);
}

/** One rect per horizontal run of same-colored pixels. */
export function spriteRects(avatar: AvatarDef): { x: number; y: number; w: number; fill: string }[] {
  const colors = { ...BASE, ...avatar.colors };
  const rects: { x: number; y: number; w: number; fill: string }[] = [];
  avatar.sprite.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let w = 1;
      while (row[x + w] === c) w++;
      if (c !== ".") rects.push({ x, y, w, fill: colors[c] });
      x += w;
    }
  });
  return rects;
}

const PHOTO_SIZE = 256;

/**
 * Center-crops an image file to a square and scales it to 256px, as a JPEG
 * data URL (tens of KB), small enough to keep on the account itself.
 */
export async function photoToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image Sush can read.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext("2d")!;
  // JPEG has no alpha; give transparent PNGs a white backdrop instead of black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}
