// Lays commits out in lanes for a drawn commit graph (the pull request card's
// and the Cowork graph panel's), and the SVG paths between them.

export interface GraphNode {
  key: string;
  parents: string[];
}

export interface GraphEdge {
  /** Row indexes, child to parent. */
  from: number;
  to: number;
  /** The lane the edge runs down before it bends into the parent. */
  lane: number;
}

/** Row height, lane width, and the space left of the first lane. */
export interface GraphGeometry {
  row: number;
  lane: number;
  pad: number;
}

/**
 * Lay the rows out in lanes, newest first: each commit takes the lane that
 * was waiting for it (or a free one), its first parent continues that lane,
 * and other parents get lanes of their own. Parents not among the rows get no edge.
 */
export function layout(rows: GraphNode[]): { cols: number[]; edges: GraphEdge[]; lanes: number } {
  const index = new Map(rows.map((r, i) => [r.key, i]));
  const lanes: (string | null)[] = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  const cols: number[] = [];
  const edges: GraphEdge[] = [];
  rows.forEach((row, i) => {
    let col = lanes.indexOf(row.key);
    if (col === -1) col = free();
    // Every lane that was waiting for this commit ends here.
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === row.key) lanes[j] = null;
    cols[i] = col;
    row.parents.forEach((p, k) => {
      const to = index.get(p);
      if (to === undefined) return;
      let lane = lanes.indexOf(p);
      if (lane === -1) {
        lane = k === 0 && lanes[col] == null ? col : free();
        lanes[lane] = p;
      }
      edges.push({ from: i, to, lane });
    });
  });
  return { cols, edges, lanes: Math.max(1, lanes.length, ...cols.map((c) => c + 1)) };
}

export const laneX = (g: GraphGeometry, col: number) => g.pad + col * g.lane;
export const rowY = (g: GraphGeometry, row: number) => row * g.row + g.row / 2;

export function edgePath(g: GraphGeometry, e: GraphEdge, cols: number[]) {
  const [x1, y1, xl, x2, y2] = [laneX(g, cols[e.from]), rowY(g, e.from), laneX(g, e.lane), laneX(g, cols[e.to]), rowY(g, e.to)];
  const half = g.row / 2;
  if (x1 === xl && xl === x2) return `M${x1} ${y1}V${y2}`;
  if (e.to - e.from === 1) return `M${x1} ${y1}C${x1} ${y1 + half} ${x2} ${y2 - half} ${x2} ${y2}`;
  let d = `M${x1} ${y1}`;
  if (x1 !== xl) d += `C${x1} ${y1 + half} ${xl} ${y1 + half} ${xl} ${y1 + g.row}`;
  d += `V${xl !== x2 ? y2 - g.row : y2}`;
  if (xl !== x2) d += `C${xl} ${y2 - half} ${x2} ${y2 - half} ${x2} ${y2}`;
  return d;
}

/** "now", "6m", "2h", "3d", or the date. */
export function ago(seconds: number, now = Date.now()) {
  const s = Math.max(0, Math.round(now / 1000 - seconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
