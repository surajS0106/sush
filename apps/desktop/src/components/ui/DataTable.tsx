"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CaretUpIcon, ArchiveIcon } from "@phosphor-icons/react";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export interface DataColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  sortable?: boolean;
  /** Initial px width. Omit on exactly one column to let it take the slack. */
  width?: number;
  sortAccessor?: (row: T) => string | number;
  render?: (row: T) => ReactNode;
  /** Return a number to draw a proportional bar behind the cell. */
  bar?: (row: T) => number;
}

export type SortState = { key: string; dir: "asc" | "desc" } | null;

interface DataTableProps<T> {
  data: T[];
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  selectable?: boolean;
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  density?: "comfortable" | "compact";
  loading?: boolean;
  emptyLabel?: string;
  rowActions?: (row: T) => ReactNode;
  minWidth?: number;
  /** Fires when a header click changes the sort, so a chart beside the table can follow it. */
  onSortChange?: (sort: SortState) => void;
}

export function DataTable<T>({
  data,
  columns,
  getRowId,
  selectable = false,
  selectedIds = [],
  onSelectedIdsChange,
  density = "comfortable",
  loading = false,
  emptyLabel = "Nothing here yet",
  rowActions,
  minWidth = 560,
  onSortChange,
}: DataTableProps<T>) {
  const reduce = useReducedMotion();
  const [sort, setSort] = useState<SortState>(null);
  const [widthOverrides, setWidthOverrides] = useState<Record<string, number>>({});
  const [guideX, setGuideX] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const headerChk = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allChecked = data.length > 0 && data.every((r) => selected.has(getRowId(r)));
  const someChecked = data.some((r) => selected.has(getRowId(r)));

  useEffect(() => {
    if (headerChk.current) headerChk.current.indeterminate = someChecked && !allChecked;
  }, [someChecked, allChecked]);

  const barMax = useMemo(() => {
    const m: Record<string, number> = {};
    for (const col of columns) {
      if (col.bar) m[col.key] = Math.max(1, ...data.map((r) => col.bar!(r)));
    }
    return m;
  }, [columns, data]);

  const sorted = useMemo(() => {
    if (!sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return data;
    const acc = col.sortAccessor ?? ((r: T) => (r as Record<string, unknown>)[sort.key] as string | number);
    return [...data].sort((a, b) => {
      const av = acc(a);
      const bv = acc(b);
      const r =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? r : -r;
    });
  }, [data, columns, sort]);

  const cycleSort = (key: string) => {
    const next: SortState =
      !sort || sort.key !== key ? { key, dir: "asc" } : sort.dir === "asc" ? { key, dir: "desc" } : null;
    setSort(next);
    onSortChange?.(next);
  };

  const toggleAll = () => onSelectedIdsChange?.(allChecked ? [] : data.map(getRowId));
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedIdsChange?.([...next]);
  };

  const gridTemplate = useMemo(() => {
    const parts: string[] = [];
    if (selectable) parts.push("2.75rem");
    columns.forEach((c) => {
      const w = widthOverrides[c.key] ?? c.width;
      parts.push(w ? w + "px" : "minmax(120px, 1fr)");
    });
    if (rowActions) parts.push("2.75rem");
    return parts.join(" ");
  }, [columns, widthOverrides, selectable, rowActions]);

  const startResize = (col: DataColumn<T>, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW =
      widthOverrides[col.key] ??
      col.width ??
      (e.currentTarget.parentElement?.getBoundingClientRect().width ?? 120);
    const rect = gridRef.current?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const w = Math.max(80, startW + (ev.clientX - startX));
      setWidthOverrides((prev) => ({ ...prev, [col.key]: w }));
      if (rect) setGuideX(ev.clientX - rect.left);
    };
    const up = () => {
      setGuideX(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pad = density === "compact" ? "py-1.5" : "py-2.5";

  return (
    <div className="relative w-full">
      <div data-lenis-prevent className="w-full overflow-x-auto rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div ref={gridRef} role="table" aria-rowcount={data.length} style={{ minWidth }}>
          <div
            role="row"
            style={{ gridTemplateColumns: gridTemplate }}
            className="sticky top-0 z-10 grid items-center border-b border-stone-200 bg-stone-50/95 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-900/95"
          >
            {selectable && (
              <div role="columnheader" className="flex items-center justify-center py-2">
                <input
                  ref={headerChk}
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={allChecked}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer rounded border-stone-300 accent-emerald-600"
                />
              </div>
            )}
            {columns.map((col, i) => {
              const active = sort?.key === col.key;
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={cx(
                    "relative flex select-none items-center gap-1 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500",
                    col.align === "right" && "justify-end",
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => cycleSort(col.key)}
                      className="flex items-center gap-1 rounded transition-colors hover:text-stone-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:hover:text-stone-100"
                    >
                      {col.header}
                      <motion.span
                        aria-hidden
                        animate={{
                          rotate: active && sort!.dir === "desc" ? 180 : 0,
                          opacity: active ? 1 : 0.25,
                        }}
                        transition={{ duration: reduce ? 0 : 0.2 }}
                        className={active ? "text-emerald-700 dark:text-emerald-400" : ""}
                      >
                        <CaretUpIcon size={11} weight="bold" />
                      </motion.span>
                    </button>
                  ) : (
                    col.header
                  )}
                  {i < columns.length - 1 && (
                    <span
                      role="separator"
                      aria-label={"Resize " + col.header + " column"}
                      onPointerDown={(e) => startResize(col, e)}
                      className="absolute -right-1 top-1/2 z-20 h-5 w-2 -translate-y-1/2 cursor-col-resize touch-none rounded-full transition-colors hover:bg-emerald-400/40"
                    />
                  )}
                </div>
              );
            })}
            {rowActions && <div role="columnheader" aria-label="Row actions" />}
          </div>

          <div role="rowgroup" className="relative divide-y divide-stone-100 dark:divide-stone-800/70">
            {loading ? (
              <SkeletonRows
                template={gridTemplate}
                rows={5}
                pad={pad}
                selectable={selectable}
                cols={columns.length}
              />
            ) : sorted.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-500">
                  <ArchiveIcon size={18} aria-hidden />
                </div>
                <p className="text-sm text-stone-500 dark:text-stone-400">{emptyLabel}</p>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {sorted.map((row) => {
                  const id = getRowId(row);
                  const isSel = selected.has(id);
                  return (
                    <motion.div
                      key={id}
                      role="row"
                      layout={reduce ? false : "position"}
                      initial={reduce ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={{
                        layout: { duration: reduce ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] },
                        opacity: { duration: 0.15 },
                      }}
                      style={{ gridTemplateColumns: gridTemplate }}
                      className={cx(
                        "group grid items-center text-sm transition-colors",
                        isSel
                          ? "bg-emerald-50/60 dark:bg-emerald-500/[0.07]"
                          : "hover:bg-emerald-500/10 dark:hover:bg-emerald-500/15",
                      )}
                    >
                      {selectable && (
                        <div className="flex items-center justify-center">
                          <input
                            type="checkbox"
                            aria-label={"Select row " + id}
                            checked={isSel}
                            onChange={() => toggleRow(id)}
                            className="h-4 w-4 cursor-pointer rounded border-stone-300 accent-emerald-600"
                          />
                        </div>
                      )}
                      {columns.map((col) => {
                        const barVal = col.bar?.(row);
                        const pct = barVal != null ? Math.min(1, barVal / barMax[col.key]) : 0;
                        return (
                          <div
                            key={col.key}
                            role="cell"
                            className={cx(
                              "relative overflow-hidden px-3 text-stone-700 dark:text-stone-200",
                              pad,
                              col.align === "right" && "text-right tabular-nums",
                            )}
                          >
                            {barVal != null && (
                              <motion.span
                                aria-hidden
                                className="pointer-events-none absolute inset-y-0 left-0 -z-0 border-r border-emerald-500/40 bg-emerald-500/[0.13] dark:border-emerald-400/40 dark:bg-emerald-400/[0.12]"
                                initial={reduce ? { width: pct * 100 + "%" } : { width: 0 }}
                                animate={{ width: pct * 100 + "%" }}
                                transition={{ duration: reduce ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] }}
                              />
                            )}
                            <span className="relative z-10">
                              {col.render
                                ? col.render(row)
                                : String((row as Record<string, unknown>)[col.key] ?? "")}
                            </span>
                          </div>
                        );
                      })}
                      {rowActions && (
                        <div className="flex items-center justify-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          {rowActions(row)}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>

      {guideX != null && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 z-30 h-full w-px bg-emerald-500"
          style={{ left: guideX }}
        />
      )}
    </div>
  );
}

function SkeletonRows({
  template,
  rows,
  pad,
  selectable,
  cols,
}: {
  template: string;
  rows: number;
  pad: string;
  selectable: boolean;
  cols: number;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="relative overflow-hidden">
      {!reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-10 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-white/10"
          initial={{ x: "-100%" }}
          animate={{ x: "300%" }}
          transition={{ duration: 1.3, repeat: Infinity, ease: "linear" }}
        />
      )}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ gridTemplateColumns: template }} className="grid items-center">
          {selectable && (
            <div className="flex justify-center py-3">
              <span className="h-4 w-4 rounded bg-stone-200 dark:bg-stone-800" />
            </div>
          )}
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className={cx("px-3", pad)}>
              <span
                className="block h-3.5 rounded bg-stone-200 dark:bg-stone-800"
                style={{ width: 40 + ((r + c) % 4) * 18 + "%" }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/*
Usage:

const columns: DataColumn<Service>[] = [
  { key: "name", header: "Service", sortable: true, width: 190,
    render: (r) => <strong>{r.name}</strong> },
  { key: "requests", header: "Requests", sortable: true, align: "right",
    bar: (r) => r.requests, render: (r) => r.requests.toLocaleString() },
];

const [selected, setSelected] = useState<string[]>([]);

<DataTable
  data={rows}
  columns={columns}
  getRowId={(r) => r.id}
  selectable
  selectedIds={selected}
  onSelectedIdsChange={setSelected}
  loading={isLoading}
  rowActions={(r) => <button onClick={() => remove(r.id)}>Delete</button>}
/>
*/
