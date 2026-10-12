// Built-in looks for slide decks. A theme is a palette and type pairing; the
// layouts are shared, so the model only writes semantic HTML and picks a
// layout per slide. Every size is for the 1920×1080 canvas.

export const THEMES = {
  ember: {
    label: "Ember",
    vars: {
      bg: "#2b1e24", fg: "#f7ede4", muted: "#cdb9ad", accent: "#c8593f", accent2: "#e8b65a", onAccent: "#fff7f0",
      surface: "rgba(255, 255, 255, 0.06)", head: "'Lora Variable', Georgia, serif", headWeight: "500", tracking: "-0.01em", em: "#e8b65a",
    },
  },
  paper: {
    label: "Paper",
    vars: {
      bg: "#f6f1e9", fg: "#1d1a16", muted: "#6b6359", accent: "#d26b4a", accent2: "#f0c9a2", onAccent: "#fffaf4",
      surface: "#ece3d6", head: "'Lora Variable', Georgia, serif", headWeight: "500", tracking: "-0.015em", em: "#d26b4a",
    },
  },
  ocean: {
    label: "Ocean",
    vars: {
      bg: "#0c1a2e", fg: "#eaf2fb", muted: "#9fb3c8", accent: "#2fb8a6", accent2: "#4a7bd8", onAccent: "#04121f",
      surface: "rgba(255, 255, 255, 0.06)", head: "'Plus Jakarta Sans Variable', Arial, sans-serif", headWeight: "700", tracking: "-0.03em", em: "#2fb8a6",
    },
  },
  forest: {
    label: "Forest",
    vars: {
      bg: "#eef1ea", fg: "#1b3426", muted: "#55695b", accent: "#2f6b47", accent2: "#b9cf8f", onAccent: "#f3f7ef",
      surface: "#dfe6d7", head: "'Lora Variable', Georgia, serif", headWeight: "600", tracking: "-0.01em", em: "#2f6b47",
    },
  },
  mono: {
    label: "Mono",
    vars: {
      bg: "#0d0d0d", fg: "#f4f4f2", muted: "#9a9a96", accent: "#ff5a36", accent2: "#2a2a28", onAccent: "#0d0d0d",
      surface: "#1b1b1a", head: "'Geist Variable', Arial, sans-serif", headWeight: "700", tracking: "-0.045em", em: "#ff5a36",
    },
  },
  blush: {
    label: "Blush",
    vars: {
      bg: "#fbeee9", fg: "#3a1424", muted: "#7d5563", accent: "#b33a5b", accent2: "#f2a77c", onAccent: "#fff5f2",
      surface: "#f5ddd6", head: "'Lora Variable', Georgia, serif", headWeight: "600", tracking: "-0.01em", em: "#b33a5b",
    },
  },
} as const;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];
export const DEFAULT_THEME: ThemeName = "ember";

export const LAYOUTS = ["cover", "section", "statement", "bullets", "split", "cards", "stats", "quote", "image", "closing"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const isTheme = (t: unknown): t is ThemeName => typeof t === "string" && t in THEMES;
export const isLayout = (l: unknown): l is Layout => typeof l === "string" && (LAYOUTS as readonly string[]).includes(l);

/** What the model is told about the building blocks, in the tool description. */
export const LAYOUT_GUIDE =
  "Layouts (one per slide): " +
  "cover (eyebrow, h1, p.lead; big shapes on the right), " +
  "section (a divider: eyebrow, h2, on the accent color), " +
  "statement (one bold h2 sentence, optional p), " +
  "bullets (eyebrow, h2, ul or ol of 3–5 short items), " +
  "split (two <div>s side by side: e.g. text left, ul or .cards right), " +
  "cards (eyebrow, h2, then .cards holding 2–4 .card each with h3 and p), " +
  "stats (eyebrow, h2, then .stats holding 2–4 .stat each with .num and .label), " +
  "quote (blockquote then cite), " +
  "image (eyebrow, h2, p on the left; one <img> as the slide's last element fills the right half, edge to edge), " +
  "closing (h2 and p, centered). " +
  "Wrap a word or two of a heading in <em> for an accent-colored italic. Other classes: .eyebrow (small caps label), " +
  ".lead (larger paragraph), .band (a strong full-width strip, e.g. a takeaway), .muted. " +
  "Images also fit as one of split's two columns, at the top of a .card, or as the last element of a cover (shown in a circle).";

const LAYOUT_CSS = `
.slide {
  background: var(--bg); color: var(--fg); font-family: var(--body);
  padding: 120px 140px; display: flex; flex-direction: column; justify-content: center; gap: 36px;
}
.slide > * { position: relative; z-index: 1; }
.slide::before, .slide::after { content: none; position: absolute; z-index: 0; pointer-events: none; }
.slide h1, .slide h2 {
  font-family: var(--head); font-weight: var(--head-weight); letter-spacing: var(--tracking);
  line-height: 1.04; text-wrap: balance; max-width: 1500px;
}
.slide h1 { font-size: 156px; }
.slide h2 { font-size: 100px; }
.slide h3 { font-size: 46px; font-weight: 600; line-height: 1.15; }
.slide :is(h1, h2, blockquote) em { font-style: italic; color: var(--em); }
.slide p { font-size: 40px; line-height: 1.42; color: var(--muted); max-width: 1320px; text-wrap: pretty; }
.slide p.lead { font-size: 50px; line-height: 1.35; }
.slide .muted { color: var(--muted); }
.slide .eyebrow {
  font-size: 28px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent);
}
.slide ul, .slide ol { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 30px; }
.slide li { position: relative; padding-left: 64px; font-size: 44px; line-height: 1.32; max-width: 1400px; }
.slide ul > li::before {
  content: ""; position: absolute; left: 4px; top: 14px; width: 26px; height: 26px; border-radius: 50%; background: var(--accent);
}
.slide ol { counter-reset: item; }
.slide ol > li { counter-increment: item; }
.slide ol > li::before {
  content: counter(item, decimal-leading-zero); position: absolute; left: 0; top: 6px;
  font-family: "DM Mono", monospace; font-size: 30px; color: var(--accent);
}
.slide .band {
  background: var(--accent); color: var(--on-accent); border-radius: 24px; padding: 40px 56px;
  font-size: 40px; font-weight: 500; line-height: 1.3;
}
.slide .cards { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 40px; }
.slide .card {
  background: var(--surface); border-radius: 32px; padding: 56px 52px; display: flex; flex-direction: column; gap: 22px;
}
.slide .card p { font-size: 34px; }
.slide .stats { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 56px; margin-top: 24px; }
.slide .stat { border-top: 6px solid var(--accent); padding-top: 36px; }
.slide .stat .num {
  font-family: var(--head); font-weight: var(--head-weight); letter-spacing: var(--tracking);
  font-size: 150px; line-height: 1; color: var(--fg);
}
.slide .stat .label { font-size: 34px; line-height: 1.35; color: var(--muted); margin-top: 20px; }
.slide blockquote {
  font-family: var(--head); font-weight: var(--head-weight); font-size: 84px; line-height: 1.18;
  letter-spacing: var(--tracking); max-width: 1500px; margin: 0;
}
.slide cite { display: block; font-style: normal; font-size: 32px; color: var(--muted); letter-spacing: 0.04em; }

/* images: cropped to fill their box, never stretched */
.slide img { display: block; max-width: 100%; object-fit: cover; border-radius: 28px; background: var(--surface); }
.slide figure { display: flex; flex-direction: column; gap: 20px; }
.slide figcaption { font-size: 28px; color: var(--muted); }
.slide .card img { width: 100%; height: 300px; border-radius: 20px; }
.slide.layout-split > img, .slide.layout-split > figure > img { width: 100%; height: 720px; }
.slide.layout-cover > img {
  position: absolute; z-index: 2; right: 150px; top: 50%; transform: translateY(-50%);
  width: 600px; height: 600px; border-radius: 50%; border: 14px solid var(--bg);
}
.slide.layout-image { padding-right: 1060px; }
.slide.layout-image > img {
  position: absolute; top: 0; right: 0; width: 920px; height: 100%; border-radius: 0;
}

/* cover: overlapping discs bleeding off the top right */
.slide.layout-cover { padding-right: 760px; }
.slide.layout-cover h1 { font-size: 164px; }
.slide.layout-cover::before {
  content: ""; width: 900px; height: 900px; right: -180px; top: -240px; border-radius: 50%; background: var(--accent);
}
.slide.layout-cover::after {
  content: ""; width: 640px; height: 640px; right: -40px; top: 240px; border-radius: 50%; background: var(--accent2);
}

/* section: a full-color divider with a ring */
.slide.layout-section { background: var(--accent); color: var(--on-accent); }
.slide.layout-section .eyebrow, .slide.layout-section p { color: var(--on-accent); opacity: 0.75; }
.slide.layout-section h2 { font-size: 136px; }
.slide.layout-section h2 em { color: var(--on-accent); }
.slide.layout-section::after {
  content: ""; width: 760px; height: 760px; right: -220px; bottom: -300px; border-radius: 50%;
  border: 6px solid var(--on-accent); opacity: 0.35;
}

/* statement: one big sentence under a short accent rule */
.slide.layout-statement h2 { font-size: 118px; max-width: 1560px; }
.slide.layout-statement::before {
  content: ""; left: 140px; top: 120px; width: 140px; height: 14px; border-radius: 7px; background: var(--accent);
}

/* bullets: heading and list, with a quarter disc in the corner */
.slide.layout-bullets { justify-content: flex-start; padding-top: 140px; }
.slide.layout-bullets h2 { margin-bottom: 20px; }
.slide.layout-bullets::after {
  content: ""; width: 520px; height: 520px; right: -260px; bottom: -260px; border-radius: 50%; background: var(--accent2); opacity: 0.85;
}

/* split: two columns, the right one on a panel */
.slide.layout-split { display: grid; grid-template-columns: 1fr 1fr; align-items: center; column-gap: 200px; }
.slide.layout-split > div { display: flex; flex-direction: column; gap: 32px; }
.slide.layout-split::before { content: ""; top: 0; right: 0; width: 50%; height: 100%; background: var(--surface); }
.slide.layout-split .cards { grid-auto-flow: row; gap: 28px; }

/* cards and stats: heading at the top, content below */
.slide.layout-cards, .slide.layout-stats { justify-content: flex-start; padding-top: 140px; }
.slide.layout-cards .cards, .slide.layout-stats .stats { margin-top: auto; }

/* quote: an oversized opening mark */
.slide.layout-quote { padding-left: 200px; gap: 56px; }
.slide.layout-quote::before {
  content: "\\201C"; left: 120px; top: 30px; font-family: var(--head); font-size: 420px; line-height: 1; color: var(--accent);
}

/* closing: centered, with a rising disc */
.slide.layout-closing { align-items: center; text-align: center; }
.slide.layout-closing h2 { font-size: 132px; }
.slide.layout-closing::before {
  content: ""; width: 1300px; height: 1300px; left: 310px; top: 640px; border-radius: 50%; background: var(--accent); opacity: 0.18;
}
`;

/** The CSS a theme adds to every slide, before the deck's own CSS. */
export function themeCss(theme: ThemeName): string {
  const v = THEMES[theme].vars;
  return `
.slide {
  --bg: ${v.bg}; --fg: ${v.fg}; --muted: ${v.muted}; --accent: ${v.accent}; --accent2: ${v.accent2};
  --on-accent: ${v.onAccent}; --surface: ${v.surface}; --head: ${v.head}; --head-weight: ${v.headWeight};
  --tracking: ${v.tracking}; --em: ${v.em}; --body: "Geist Variable", Arial, sans-serif;
}
${LAYOUT_CSS}`;
}
