// Export a deck to PowerPoint. Each slide is rendered offscreen exactly as the
// panel shows it, then read back from the layout the browser computed: boxes
// with a fill or border become shapes, blocks of text become editable text
// boxes with their runs' weight, style and color, and speaker notes carry over.
// What PowerPoint can't draw (gradients, blend modes) falls back to the
// nearest solid color.

import PptxGenJS from "pptxgenjs";

import { loadRemoteImages, slideMarkup, SLIDE_H, SLIDE_W, type DeckVersion } from "@/lib/slides";
import { api } from "@/lib/tauri";

/** 13.333 × 7.5 in, PowerPoint's widescreen size: 144 canvas px per inch, so 1px is 0.5pt. */
const PX_PER_IN = 144;
const PT_PER_PX = 72 / PX_PER_IN;
const inch = (px: number) => px / PX_PER_IN;

type PptxSlide = ReturnType<PptxGenJS["addSlide"]>;
type TextRun = { text: string; options?: PptxGenJS.TextPropsOptions };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- colors ---------------------------------------------------------------------------

const canvas = document.createElement("canvas").getContext("2d");

/** A CSS color as PowerPoint wants it: hex without '#', and transparency 0–100. */
function color(css: string, opacity = 1): { color: string; transparency: number } | null {
  let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(css);
  if (!m && canvas) {
    // Normalise anything else (named, hex, color()) through a canvas.
    canvas.fillStyle = "#000";
    canvas.fillStyle = css;
    const v = String(canvas.fillStyle);
    if (v.startsWith("#")) return { color: v.slice(1).toUpperCase(), transparency: Math.round((1 - opacity) * 100) };
    m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(v);
  }
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const a = alpha * opacity;
  if (a <= 0.01) return null;
  const hex = [m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("");
  return { color: hex.toUpperCase(), transparency: Math.round((1 - a) * 100) };
}

/** A box's fill: its background color, or the first stop of a gradient. */
function fillOf(cs: CSSStyleDeclaration, opacity: number) {
  const bg = color(cs.backgroundColor, opacity);
  if (bg) return bg;
  if (cs.backgroundImage.includes("gradient")) {
    const stop = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(cs.backgroundImage);
    if (stop) return color(stop[1], opacity);
  }
  return null;
}

// --- fonts ----------------------------------------------------------------------------

/** The app's bundled fonts aren't installed with Office, so use the closest everyday face. */
function fontFace(family: string) {
  const first = family.split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (/^Lora/i.test(first) || /serif$/i.test(first)) return "Georgia";
  if (/mono/i.test(first)) return "Courier New";
  if (/^(Geist|Plus Jakarta|system-ui|sans-serif)/i.test(first)) return "Arial";
  return first;
}

const px = (v: string) => parseFloat(v) || 0;

// --- reading a rendered slide -----------------------------------------------------------

class SlideReader {
  constructor(
    private pptx: PptxGenJS,
    private slide: PptxSlide,
    private origin: DOMRect,
    /** Each loaded image's bytes as a `data:` URL. */
    private images: Map<HTMLImageElement, string>,
  ) {}

  rect(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: r.left - this.origin.left, y: r.top - this.origin.top, w: r.width, h: r.height };
  }

  /** A filled or outlined box: ellipse, rounded rectangle or rectangle by its corner radius. */
  box(r: Rect, cs: CSSStyleDeclaration, opacity: number) {
    if (r.w < 1 || r.h < 1) return;
    const fill = fillOf(cs, opacity);
    const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
    const uniform = widths.every((w) => w > 0 && w === widths[0]);
    const line = uniform ? color(cs.borderTopColor, opacity) : null;
    if (fill || line) {
      const radius = cs.borderTopLeftRadius;
      const half = Math.min(r.w, r.h) / 2;
      const rad = radius.endsWith("%") ? (parseFloat(radius) / 50) * half : px(radius);
      const ellipse = rad >= half - 1;
      this.slide.addShape(ellipse ? this.pptx.ShapeType.ellipse : rad > 0 ? this.pptx.ShapeType.roundRect : this.pptx.ShapeType.rect, {
        x: inch(r.x),
        y: inch(r.y),
        w: inch(r.w),
        h: inch(r.h),
        fill: fill ?? { color: "FFFFFF", transparency: 100 },
        line: line ? { color: line.color, transparency: line.transparency, width: widths[0] * PT_PER_PX } : { type: "none" },
        ...(!ellipse && rad > 0 ? { rectRadius: Math.min(1, rad / half) } : {}),
      });
    }
    // Single-side borders (e.g. a rule above a stat) become thin bars.
    if (!uniform) {
      const sides: [number, string, Rect][] = [
        [widths[0], cs.borderTopColor, { x: r.x, y: r.y, w: r.w, h: widths[0] }],
        [widths[1], cs.borderRightColor, { x: r.x + r.w - widths[1], y: r.y, w: widths[1], h: r.h }],
        [widths[2], cs.borderBottomColor, { x: r.x, y: r.y + r.h - widths[2], w: r.w, h: widths[2] }],
        [widths[3], cs.borderLeftColor, { x: r.x, y: r.y, w: widths[3], h: r.h }],
      ];
      for (const [w, c, s] of sides) {
        const fillColor = w > 0 ? color(c, opacity) : null;
        if (fillColor) this.slide.addShape(this.pptx.ShapeType.rect, { x: inch(s.x), y: inch(s.y), w: inch(s.w), h: inch(s.h), fill: fillColor, line: { type: "none" } });
      }
    }
  }

  /** Text styled as one block, with its own alignment and line height. */
  text(runs: TextRun[], r: Rect, cs: CSSStyleDeclaration) {
    if (!runs.some((run) => run.text.trim())) return;
    const fontSize = px(cs.fontSize);
    const lineHeight = cs.lineHeight === "normal" ? fontSize * 1.2 : px(cs.lineHeight);
    const align = cs.textAlign === "center" ? "center" : cs.textAlign === "right" || cs.textAlign === "end" ? "right" : "left";
    // Office's text measures a little wider than the browser's; give left-aligned text room so lines don't rewrap.
    const slack = align === "left" ? Math.min(r.w * 0.06, SLIDE_W - (r.x + r.w)) : 0;
    this.slide.addText(runs, {
      x: inch(r.x),
      y: inch(r.y),
      w: inch(r.w + Math.max(0, slack)),
      h: inch(Math.max(r.h, lineHeight)),
      margin: 0,
      valign: "top",
      align,
      fit: "none",
      lineSpacingMultiple: fontSize ? Math.max(0.8, lineHeight / fontSize) : 1,
    });
  }

  /** Styles of one run of text, from the element it sits in. */
  runOptions(cs: CSSStyleDeclaration, opacity: number): PptxGenJS.TextPropsOptions {
    const c = color(cs.color, opacity);
    return {
      fontFace: fontFace(cs.fontFamily),
      fontSize: Math.max(1, Math.round(px(cs.fontSize) * PT_PER_PX * 10) / 10),
      bold: Number(cs.fontWeight) >= 600,
      italic: cs.fontStyle === "italic",
      ...(c ? { color: c.color, transparency: c.transparency } : {}),
      ...(cs.letterSpacing !== "normal" && px(cs.letterSpacing) ? { charSpacing: px(cs.letterSpacing) * PT_PER_PX } : {}),
    };
  }

  /** An absolutely positioned ::before / ::after: a decorative shape, a bullet, a quote mark or a list number. */
  pseudo(el: Element, which: "::before" | "::after", opacity: number) {
    const ps = getComputedStyle(el, which);
    const content = ps.content;
    if (!content || content === "none" || content === "normal" || ps.position !== "absolute" || ps.display === "none") return;
    const host = this.rect(el);
    const cs = getComputedStyle(el);
    const t = /matrix\(([^)]+)\)/.exec(ps.transform)?.[1].split(",").map(Number);
    const w = px(ps.width);
    const h = px(ps.height);
    const left = ps.left !== "auto" ? px(ps.left) : host.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(ps.right) - w;
    const top = ps.top !== "auto" ? px(ps.top) : host.h - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(ps.bottom) - h;
    const r: Rect = {
      x: host.x + px(cs.borderLeftWidth) + left + (t ? t[4] : 0),
      y: host.y + px(cs.borderTopWidth) + top + (t ? t[5] : 0),
      w,
      h,
    };
    const alpha = opacity * Number(ps.opacity || 1);
    this.box(r, ps, alpha);

    let label = /^["'](.*)["']$/.exec(content)?.[1] ?? "";
    if (content.startsWith("counter(")) {
      const n = [...(el.parentElement?.children ?? [])].filter((s) => s.tagName === el.tagName).indexOf(el) + 1;
      label = content.includes("leading-zero") ? String(n).padStart(2, "0") : String(n);
    }
    if (label) this.text([{ text: label, options: this.runOptions(ps, alpha) }], { ...r, w: Math.max(w, px(ps.fontSize) * label.length), h: Math.max(h, px(ps.fontSize)) }, ps);
  }

  /** Text and inline elements inside a block, as runs; block children are read on their own. */
  runs(el: Element, opacity: number, blocks: Element[]): TextRun[] {
    const out: TextRun[] = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const cs = getComputedStyle(node.parentElement!);
        let text = (node.textContent ?? "").replace(/\s+/g, " ");
        if (cs.textTransform === "uppercase") text = text.toUpperCase();
        if (text) out.push({ text, options: this.runOptions(cs, opacity) });
      } else if (node instanceof HTMLBRElement) {
        out.push({ text: "", options: { breakLine: true } });
      } else if (node instanceof Element) {
        const cs = getComputedStyle(node);
        if (cs.display === "none") continue;
        if (cs.display.startsWith("inline") && !(node instanceof SVGElement)) out.push(...this.runs(node, opacity * Number(cs.opacity), blocks));
        else blocks.push(node);
      }
    }
    // Trim the whitespace HTML leaves at a block's edges.
    if (out[0]) out[0].text = out[0].text.trimStart();
    const last = out.at(-1);
    if (last) last.text = last.text.trimEnd();
    return out;
  }

  walk(el: Element, inherited: number) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const opacity = inherited * Number(cs.opacity);
    if (opacity <= 0.01) return;
    const r = this.rect(el);

    if (el instanceof HTMLImageElement) {
      const data = this.images.get(el);
      if (!data || r.w < 1 || r.h < 1) return;
      this.box(r, cs, opacity);
      const radius = cs.borderTopLeftRadius;
      const round = radius.endsWith("%") ? parseFloat(radius) >= 50 : px(radius) >= Math.min(r.w, r.h) / 2 - 1;
      const pos = { x: inch(r.x), y: inch(r.y), w: inch(r.w), h: inch(r.h) };
      this.slide.addImage({
        data: data.replace(/^data:/, ""),
        ...pos,
        // Cover crops by the picture's own proportions, given as its w and h.
        ...(cs.objectFit === "cover" && el.naturalWidth && el.naturalHeight
          ? { w: inch(el.naturalWidth), h: inch(el.naturalHeight), sizing: { type: "cover" as const, w: pos.w, h: pos.h } }
          : {}),
        ...(round ? { rounding: true } : {}),
      });
      return;
    }

    if (el instanceof SVGSVGElement) {
      const svg = el.cloneNode(true) as SVGSVGElement;
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("width", String(r.w));
      svg.setAttribute("height", String(r.h));
      const data = btoa(unescape(encodeURIComponent(svg.outerHTML)));
      this.slide.addImage({ data: `image/svg+xml;base64,${data}`, x: inch(r.x), y: inch(r.y), w: inch(r.w), h: inch(r.h) });
      return;
    }

    this.box(r, cs, opacity);
    this.pseudo(el, "::before", opacity);

    const blocks: Element[] = [];
    const runs = this.runs(el, opacity, blocks);
    if (runs.length) {
      const content: Rect = {
        x: r.x + px(cs.borderLeftWidth) + px(cs.paddingLeft),
        y: r.y + px(cs.borderTopWidth) + px(cs.paddingTop),
        w: r.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight),
        h: r.h - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom),
      };
      this.text(runs, content, cs);
    }
    for (const child of blocks) this.walk(child, opacity);
    this.pseudo(el, "::after", opacity);
  }

  read(root: HTMLElement) {
    const cs = getComputedStyle(root);
    const bg = fillOf(cs, 1);
    if (bg) this.slide.background = bg;
    // The slide's own shapes sit under its content (z-index 0 vs 1), so draw both first.
    this.pseudo(root, "::before", 1);
    this.pseudo(root, "::after", 1);
    for (const child of root.children) this.walk(child, 1);
  }
}

/** Builds the .pptx and returns it as base64. */
export async function exportDeckPptx(version: DeckVersion): Promise<string> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "SUSH_WIDE", width: SLIDE_W / PX_PER_IN, height: SLIDE_H / PX_PER_IN });
  pptx.layout = "SUSH_WIDE";
  pptx.title = version.title;

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-${SLIDE_W * 2}px;top:0;width:${SLIDE_W}px;height:${SLIDE_H}px;pointer-events:none;`;
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  try {
    for (const s of version.slides) {
      shadow.innerHTML = slideMarkup(version.css, s);
      await loadRemoteImages(shadow);
      const images = new Map<HTMLImageElement, string>();
      for (const img of shadow.querySelectorAll("img")) {
        const data = img.src.startsWith("data:") ? img.src : await api.blobDataUrl(img.src).catch(() => null);
        if (data) images.set(img, data);
      }
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const root = shadow.querySelector<HTMLElement>(".slide");
      const slide = pptx.addSlide();
      if (root) new SlideReader(pptx, slide, root.getBoundingClientRect(), images).read(root);
      if (s.notes) slide.addNotes(s.notes);
    }
  } finally {
    host.remove();
  }
  return (await pptx.write({ outputType: "base64" })) as string;
}
