// What docx-preview doesn't draw the way Word does, rewritten in a copy of the document before
// it's shown (the file itself is never changed):
//
// - Auto spacing (`w:beforeAutospacing` / `w:afterAutospacing`, common in documents that came from
//   the web or Google Docs): Word spaces such paragraphs 14pt, but not between items of a list;
//   docx-preview reads only the plain `before`/`after` values, so every bullet gets a gap.
// - Horizontal lines drawn as floating shapes (Insert → Shapes → Line, often under résumé
//   headings): docx-preview skips anchored shapes, so they become the paragraph's border.

import JSZip from "jszip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const DOCUMENT = "word/document.xml";
/** Word's auto spacing: 14pt, in twentieths of a point. */
const AUTO_SPACING = "280";

const child = (el: Element | null | undefined, name: string) =>
  el ? (Array.from(el.children).find((c) => c.namespaceURI === W && c.localName === name) ?? null) : null;

const on = (el: Element, name: string) => {
  const v = el.getAttributeNS(W, name);
  return v === "1" || v === "true" || v === "on";
};

function pPr(doc: Document, p: Element): Element {
  const found = child(p, "pPr");
  if (found) return found;
  const created = doc.createElementNS(W, "w:pPr");
  p.insertBefore(created, p.firstChild);
  return created;
}

const isListItem = (p: Element | undefined) => !!p && !!child(child(p, "pPr"), "numPr");

function autoSpacing(paras: Element[]) {
  paras.forEach((p, i) => {
    const spacing = child(child(p, "pPr"), "spacing");
    if (!spacing) return;
    if (on(spacing, "beforeAutospacing")) {
      spacing.setAttributeNS(W, "w:before", isListItem(p) && isListItem(paras[i - 1]) ? "0" : AUTO_SPACING);
      spacing.removeAttributeNS(W, "beforeAutospacing");
    }
    if (on(spacing, "afterAutospacing")) {
      spacing.setAttributeNS(W, "w:after", isListItem(p) && isListItem(paras[i + 1]) ? "0" : AUTO_SPACING);
      spacing.removeAttributeNS(W, "afterAutospacing");
    }
  });
}

/** Floating straight lines, drawn flat, become a top or bottom border of the paragraph they're anchored to. */
function lineShapes(doc: Document) {
  for (const geom of Array.from(doc.getElementsByTagNameNS(A, "prstGeom"))) {
    if (geom.getAttribute("prst") !== "line") continue;
    const anchor = geom.closest("anchor");
    if (!anchor || anchor.namespaceURI !== WP) continue;
    const extent = Array.from(anchor.children).find((c) => c.localName === "extent");
    const cx = Number(extent?.getAttribute("cx") ?? 0);
    const cy = Number(extent?.getAttribute("cy") ?? 0);
    if (!cx || cy > cx / 20) continue; // not a horizontal rule
    const p = anchor.closest("p");
    if (!p || p.namespaceURI !== W) continue;
    const vertical = Array.from(anchor.children).find((c) => c.localName === "positionV");
    const offset = Number(vertical?.querySelector("posOffset")?.textContent ?? 0);
    const side = vertical?.getAttribute("relativeFrom") === "paragraph" && offset < 0 ? "top" : "bottom";

    const props = pPr(doc, p);
    let borders = child(props, "pBdr");
    if (!borders) {
      borders = doc.createElementNS(W, "w:pBdr");
      props.insertBefore(borders, child(props, "spacing") ?? child(props, "ind") ?? child(props, "rPr"));
    }
    if (!child(borders, side)) {
      const border = doc.createElementNS(W, `w:${side}`);
      border.setAttributeNS(W, "w:val", "single");
      border.setAttributeNS(W, "w:sz", "6");
      border.setAttributeNS(W, "w:space", "1");
      border.setAttributeNS(W, "w:color", "auto");
      borders.appendChild(border);
    }
    // The shape itself, with its legacy fallback.
    const holder = anchor.closest("AlternateContent");
    (holder && holder.namespaceURI === MC ? holder : anchor.closest("drawing"))?.remove();
  }
}

/** The document as docx-preview should see it. Anything unexpected leaves it as it was. */
export async function previewFixups(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const file = zip.file(DOCUMENT);
    if (!file) return bytes;
    const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return bytes;
    autoSpacing(Array.from(doc.getElementsByTagNameNS(W, "p")));
    lineShapes(doc);
    zip.file(DOCUMENT, new XMLSerializer().serializeToString(doc));
    return await zip.generateAsync({ type: "uint8array" });
  } catch (e) {
    console.warn("Couldn't adjust the document for its preview", e);
    return bytes;
  }
}
