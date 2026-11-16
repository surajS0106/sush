// Diagrams in docs: a ```diagram code block holding a small JSON spec of boxes and arrows,
// drawn as a top-down flow chart (each box a title, a line of detail, and optional chips;
// one box can be highlighted; arrows can carry a label). The model writes the spec, the
// user edits it as the block's source, and this lays it out.
//
// Plain DOM rather than React: the editor's code block preview (`createPreview`) hands back
// an element, and the read-only view mounts the same element.

export interface DiagramNode {
  id: string;
  label: string;
  detail?: string;
  /** Small chips inside the box, e.g. the kinds of block a page holds. */
  items?: string[];
  /** The box the diagram is about, drawn highlighted. */
  focus?: boolean;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The spec in a block's source, or why it can't be drawn. */
export function parseDiagram(source: string): DiagramSpec | { error: string } {
  if (!source.trim()) return { error: "Empty diagram" };
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: "The diagram's source isn't valid JSON." };
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const nodes: DiagramNode[] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray(o.nodes) ? o.nodes : []) {
    const r = (n ?? {}) as Record<string, unknown>;
    const id = str(r.id) ?? str(r.label);
    const label = str(r.label) ?? id;
    if (!id || !label || ids.has(id)) continue;
    ids.add(id);
    const items = Array.isArray(r.items) ? r.items.flatMap((i) => (str(i) ? [str(i)!] : [])) : undefined;
    nodes.push({ id, label, detail: str(r.detail) ?? str(r.description), items: items?.length ? items : undefined, focus: r.focus === true });
  }
  if (nodes.length === 0) return { error: "The diagram has no boxes." };
  const edges: DiagramEdge[] = [];
  for (const e of Array.isArray(o.edges) ? o.edges : []) {
    const r = (e ?? {}) as Record<string, unknown>;
    const from = str(r.from);
    const to = str(r.to);
    if (from && to && from !== to && ids.has(from) && ids.has(to)) edges.push({ from, to, label: str(r.label) });
  }
  return { title: str(o.title), nodes, edges };
}

/** Rows of node ids, top to bottom: each box one row below the lowest box pointing at it. */
export function layers(spec: DiagramSpec): string[][] {
  const depth = new Map(spec.nodes.map((n) => [n.id, 0]));
  // Longest path, relaxed a bounded number of times so a cycle can't loop forever.
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    let changed = false;
    for (const e of spec.edges) {
      const d = depth.get(e.from)! + 1;
      if (d > depth.get(e.to)! && d < spec.nodes.length) {
        depth.set(e.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows: string[][] = [];
  for (const n of spec.nodes) (rows[depth.get(n.id)!] ??= []).push(n.id);
  const placed = rows.filter(Boolean);
  // Children sit in their parents' order, so arrows cross as little as a simple pass allows.
  const order = new Map<string, number>();
  placed.forEach((row, r) => {
    if (r > 0) {
      const avg = (id: string) => {
        const ps = spec.edges.filter((e) => e.to === id).map((e) => order.get(e.from) ?? 0);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
      };
      row.sort((a, b) => avg(a) - avg(b));
    }
    row.forEach((id, i) => order.set(id, i));
  });
  return placed;
}

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The drawn diagram. Its arrows follow the boxes as the element is resized. */
export function renderDiagram(spec: DiagramSpec): HTMLElement {
  const figure = el("figure", "dgm");
  if (spec.title) figure.append(el("figcaption", "dgm-title", spec.title));
  const stage = el("div", "dgm-stage");
  const wires = document.createElementNS(SVG, "svg");
  wires.setAttribute("class", "dgm-wires");
  wires.setAttribute("aria-hidden", "true");
  stage.append(wires);

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const boxes = new Map<string, HTMLElement>();
  for (const row of layers(spec)) {
    const layer = el("div", "dgm-layer");
    for (const id of row) {
      const n = byId.get(id)!;
      const box = el("div", n.focus ? "dgm-node dgm-focus" : "dgm-node");
      box.append(el("div", "dgm-label", n.label));
      if (n.detail) box.append(el("div", "dgm-detail", n.detail));
      if (n.items) {
        const chips = el("div", "dgm-items");
        for (const i of n.items) chips.append(el("span", "dgm-chip", i));
        box.append(chips);
      }
      boxes.set(id, box);
      layer.append(box);
    }
    stage.append(layer);
  }
  const labels = spec.edges.map((e) => (e.label ? el("span", "dgm-edge-label", e.label) : null));
  for (const l of labels) if (l) stage.append(l);
  figure.append(stage);

  // Text summary for screen readers: the boxes are read in order, the arrows aren't.
  figure.setAttribute("role", "img");
  figure.setAttribute(
    "aria-label",
    `${spec.title ?? "Diagram"}: ${spec.edges.map((e) => `${byId.get(e.from)!.label} to ${byId.get(e.to)!.label}${e.label ? ` (${e.label})` : ""}`).join("; ")}`,
  );

  // The wires layer is sized by CSS to the stage and never by what's drawn, so drawing can't
  // change the layout and set off another resize (which kept the panel scrolling).
  let last = "";
  const draw = () => {
    const s = stage.getBoundingClientRect();
    if (s.width === 0) return;
    const size = `${Math.round(s.width)}x${Math.round(s.height)}`;
    if (size === last) return;
    last = size;
    wires.replaceChildren();
    const defs = document.createElementNS(SVG, "defs");
    defs.innerHTML = '<marker id="dgm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker>';
    wires.append(defs);
    // Arrows from one box share the level where they turn, so they read as one branch.
    const turn = new Map<string, number>();
    spec.edges.forEach((e, i) => {
      const a = boxes.get(e.from)!.getBoundingClientRect();
      const b = boxes.get(e.to)!.getBoundingClientRect();
      const x1 = a.left + a.width / 2 - s.left;
      const y1 = a.bottom - s.top;
      const x2 = b.left + b.width / 2 - s.left;
      const y2 = b.top - s.top - 2;
      if (!turn.has(e.from)) turn.set(e.from, y1 + Math.min(24, (y2 - y1) / 2));
      const mid = Math.min(turn.get(e.from)!, y2 - 8);
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", Math.abs(x1 - x2) < 1 ? `M${x1},${y1} V${y2}` : `M${x1},${y1} V${mid} H${x2} V${y2}`);
      path.setAttribute("marker-end", "url(#dgm-arrow)");
      wires.append(path);
      const label = labels[i];
      if (label) {
        label.style.left = `${x2 + 8}px`;
        label.style.top = `${(Math.abs(x1 - x2) < 1 ? (y1 + y2) / 2 : (mid + y2) / 2) - 8}px`;
      }
    });
  };
  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }).observe(stage);
  return figure;
}

let mermaidSeq = 0;

/** A ```mermaid diagram as SVG markup, in the app's light or dark theme. Mermaid loads on first use. */
export async function renderMermaid(source: string): Promise<string> {
  if (!source.trim()) throw new Error("empty");
  const { default: mermaid } = await import("mermaid");
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "inherit" });
  const { svg } = await mermaid.render(`doc-mermaid-${++mermaidSeq}`, source);
  return svg;
}

/** A ```diagram fence's source in streamed or stored Markdown, split from the text around it. */
export type DocSegment = { kind: "text"; text: string } | { kind: "diagram"; source: string; complete: boolean };

export function splitDiagrams(markdown: string): DocSegment[] {
  const out: DocSegment[] = [];
  const re = /^```diagram[^\n]*\n([\s\S]*?)(^```\s*$|$(?![\s\S]))/gm;
  let at = 0;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    if (m.index > at) out.push({ kind: "text", text: markdown.slice(at, m.index) });
    out.push({ kind: "diagram", source: m[1], complete: !!m[2] });
    at = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (at < markdown.length) out.push({ kind: "text", text: markdown.slice(at) });
  return out;
}

/** What the model is told about diagrams (in `doc_write`'s template). */
export const DIAGRAM_GUIDE =
  "For a flow, hierarchy, process or architecture, draw a diagram: a ```diagram code block holding JSON " +
  '{"title":"…","nodes":[{"id":"a","label":"Workspace","detail":"Teamspaces and the sidebar","items":["Text","To-do"],"focus":true}],' +
  '"edges":[{"from":"a","to":"b","label":"contains"}]}. It draws top to bottom from the boxes nothing points at; 3 to 9 ' +
  "boxes, labels of 1 to 3 words, detail one short line, `items` only for a box that groups small parts, `focus` on " +
  "at most the one box the diagram is about. Put a sentence before it saying what it shows. Use ```mermaid only for " +
  "sequence diagrams and timelines.";
