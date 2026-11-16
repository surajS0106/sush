// The grips on a table's rows and columns in docs, and their menu.
//
// Press and hold a grip, drag, and let go: the row or column moves there. A line shows
// where it will land and its old place is tinted. BlockNote's own drag uses the webview's
// HTML drag and drop, which the app's window doesn't deliver reliably (Tauri takes it on
// Windows), so this one runs on pointer events, like the Board's cards.
//
// A click without a drag still opens the grip's menu (BlockNote opens it on click; a drag
// swallows the click that follows). The menu has BlockNote's own Add and Delete items and
// header row / column toggles (BlockNote's aren't exported).

import { TableHandlesExtension } from "@blocknote/core/extensions";
import {
  AddButton,
  DeleteButton,
  TableHandle,
  TableHandleMenu,
  useBlockNoteEditor,
  useComponentsContext,
  useExtension,
  useExtensionState,
  type TableHandleProps,
} from "@blocknote/react";

interface Cell {
  type?: string;
  props?: { colspan?: number; rowspan?: number };
}
interface Table {
  type: "tableContent";
  headerRows?: number;
  headerCols?: number;
  columnWidths?: (number | undefined)[];
  rows: { cells: unknown[] }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = ReturnType<typeof useBlockNoteEditor<any, any, any>>;
type Orientation = "row" | "column";

/** A merged cell spans more than one row or column; moving across it would break the table. */
const merged = (t: Table) =>
  t.rows.some((r) => r.cells.some((c) => ((c as Cell)?.props?.colspan ?? 1) > 1 || ((c as Cell)?.props?.rowspan ?? 1) > 1));

/** Moves row or column `from` so it ends up at `to`, reading the table as it is now. */
function reorder(editor: Editor, blockId: string, orientation: Orientation, from: number, to: number) {
  const fresh = editor.getBlock(blockId);
  if (!fresh || from === to) return;
  const t = fresh.content as unknown as Table;
  const rows = t.rows.map((r) => ({ ...r, cells: [...r.cells] }));
  let columnWidths = t.columnWidths;
  if (orientation === "row") {
    if (to < 0 || to >= rows.length) return;
    rows.splice(to, 0, ...rows.splice(from, 1));
  } else {
    if (to < 0 || to >= (rows[0]?.cells.length ?? 0)) return;
    for (const r of rows) r.cells.splice(to, 0, ...r.cells.splice(from, 1));
    if (columnWidths) {
      columnWidths = [...columnWidths];
      columnWidths.splice(to, 0, ...columnWidths.splice(from, 1));
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.updateBlock(blockId, { content: { ...t, rows, columnWidths } } as any);
}

function useTableState(orientation: Orientation) {
  return useExtensionState(TableHandlesExtension, {
    selector: (s) => ({ block: s?.block, index: orientation === "column" ? s?.colIndex : s?.rowIndex }),
  });
}

// --- dragging ---------------------------------------------------------------------------

/** How far the pointer goes before a press becomes a drag; less is a click. */
const DRAG_START = 4;

/** Swallows the click a drag ends with, so it doesn't open the grip's menu. */
function swallowNextClick() {
  const eat = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", eat, { capture: true, once: true });
  // If the drag ended where no click fires, a later click must still work.
  setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
}

function overlay(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  document.body.append(el);
  return el;
}

interface Drag {
  editor: Editor;
  handles: { freezeHandles: () => void; unfreezeHandles: () => void } | undefined;
  blockId: string;
  orientation: Orientation;
  from: number;
  x: number;
  y: number;
}

function startDrag(d: Drag) {
  const row = d.orientation === "row";
  let dragging = false;
  let to = d.from;
  let line: HTMLDivElement | null = null;
  let ghost: HTMLDivElement | null = null;

  const table = () => d.editor.domElement?.querySelector<HTMLTableElement>(`[data-id="${CSS.escape(d.blockId)}"] table`) ?? null;
  const slots = (t: HTMLTableElement) =>
    row ? [...t.rows].map((r) => r.getBoundingClientRect()) : [...(t.rows[0]?.cells ?? [])].map((c) => c.getBoundingClientRect());
  const place = (el: HTMLElement, left: number, top: number, width: number, height: number) =>
    Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

  const update = (x: number, y: number) => {
    const t = table();
    if (!t || !line || !ghost) return;
    const box = t.getBoundingClientRect();
    const rects = slots(t);
    if (rects.length === 0) return;
    const at = row ? y : x;
    // The gap the pointer is nearest: before the first slot whose middle it hasn't passed.
    let gap = rects.findIndex((r) => at < (row ? r.top + r.height / 2 : r.left + r.width / 2));
    if (gap === -1) gap = rects.length;
    to = gap > d.from ? gap - 1 : gap;
    const edge = gap === rects.length ? (row ? rects[gap - 1].bottom : rects[gap - 1].right) : row ? rects[gap].top : rects[gap].left;
    const src = rects[d.from];
    if (row) {
      place(line, box.left, edge - 1, box.width, 2);
      place(ghost, box.left, src.top, box.width, src.height);
    } else {
      place(line, edge - 1, box.top, 2, box.height);
      place(ghost, src.left, box.top, src.width, box.height);
    }
    // Dropping back where it was shows no line.
    line.hidden = to === d.from;
  };

  const begin = () => {
    dragging = true;
    d.handles?.freezeHandles();
    document.body.classList.add("doc-table-dragging", row ? "doc-table-dragging-row" : "doc-table-dragging-col");
    ghost = overlay("doc-table-drag-ghost");
    line = overlay("doc-table-drop-line");
  };

  const end = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    line?.remove();
    ghost?.remove();
    document.body.classList.remove("doc-table-dragging", "doc-table-dragging-row", "doc-table-dragging-col");
    if (dragging) {
      d.handles?.unfreezeHandles();
      swallowNextClick();
    }
  };

  function move(e: PointerEvent) {
    if (!dragging && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START) return;
    if (!dragging) begin();
    e.preventDefault();
    update(e.clientX, e.clientY);
  }
  function up() {
    const moved = dragging && to !== d.from;
    end();
    if (moved) reorder(d.editor, d.blockId, d.orientation, d.from, to);
  }
  function cancel() {
    end();
  }
  function key(e: KeyboardEvent) {
    if (e.key !== "Escape" || !dragging) return;
    e.preventDefault();
    end();
  }

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}

// --- the menu ---------------------------------------------------------------------------

/** "Header row" on the first row's grip, "Header column" on the first column's. */
function HeaderToggle({ orientation }: { orientation: Orientation }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const { block, index } = useTableState(orientation);
  if (!block || index !== 0) return null;
  const t = block.content as unknown as Table;
  const key = orientation === "row" ? "headerRows" : "headerCols";
  const on = !!t[key];
  return (
    <Components.Generic.Menu.Item
      checked={on}
      onClick={() => {
        const fresh = editor.getBlock(block.id);
        if (!fresh) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.updateBlock(block.id, { content: { ...(fresh.content as unknown as Table), [key]: on ? undefined : 1 } } as any);
      }}
    >
      {orientation === "row" ? "Header row" : "Header column"}
    </Components.Generic.Menu.Item>
  );
}

function DocTableMenu({ orientation }: { orientation: Orientation }) {
  return (
    <TableHandleMenu orientation={orientation}>
      {orientation === "row" ? (
        <>
          <AddButton orientation="row" side="above" />
          <AddButton orientation="row" side="below" />
        </>
      ) : (
        <>
          <AddButton orientation="column" side="left" />
          <AddButton orientation="column" side="right" />
        </>
      )}
      <DeleteButton orientation={orientation} />
      <HeaderToggle orientation={orientation} />
    </TableHandleMenu>
  );
}

// --- the grip ---------------------------------------------------------------------------

/** A table grip: hold and drag to move its row or column; click for its menu. */
export function DocTableHandle(props: TableHandleProps) {
  const editor = useBlockNoteEditor();
  const handles = useExtension(TableHandlesExtension) as Drag["handles"];
  const { block, index } = useTableState(props.orientation);
  // BlockNote renders the menu with the grip's orientation; its prop type just doesn't say so.
  const Menu = DocTableMenu as unknown as React.FC;
  return (
    <div
      className="doc-table-grip"
      onPointerDownCapture={(e) => {
        if (e.button !== 0 || !block || index === undefined || merged(block.content as unknown as Table)) return;
        startDrag({ editor, handles, blockId: block.id, orientation: props.orientation, from: index, x: e.clientX, y: e.clientY });
      }}
      // The grip is also an HTML drag source for BlockNote; that drag would cancel this one.
      onDragStartCapture={(e) => e.preventDefault()}
    >
      <TableHandle {...props} tableHandleMenu={Menu} />
    </div>
  );
}
