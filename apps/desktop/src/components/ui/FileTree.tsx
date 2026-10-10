"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CaretRightIcon as PhCaretRight, FolderIcon as PhFolder, FolderOpenIcon as PhFolderOpen, FileIcon as PhFile } from "@phosphor-icons/react";

type FileStatus = "new" | "modified" | "deleted";

interface TreeNode {
  name: string;
  type: "folder" | "file";
  status?: FileStatus;
  children?: TreeNode[];
}

function ChevronIcon() {
  return <PhCaretRight size={12} weight="bold" aria-hidden />;
}

function FolderIcon({ open }: { open: boolean }) {
  return open ? <PhFolderOpen size={15} aria-hidden /> : <PhFolder size={15} aria-hidden />;
}

function FileIcon() {
  return <PhFile size={14} aria-hidden />;
}

interface FileTypeMeta {
  label: string;
  className: string;
}

const FILE_TYPE_MAP: Record<string, FileTypeMeta> = {
  ts: { label: "TS", className: "bg-blue-500 text-white" },
  tsx: { label: "TSX", className: "bg-sky-500 text-white" },
  js: { label: "JS", className: "bg-yellow-400 text-yellow-950" },
  jsx: { label: "JSX", className: "bg-amber-400 text-amber-950" },
  json: { label: "{}", className: "bg-amber-700 text-white" },
  css: { label: "#", className: "bg-blue-400 text-white" },
  scss: { label: "#", className: "bg-pink-400 text-white" },
  html: { label: "<>", className: "bg-orange-500 text-white" },
  md: { label: "M↓", className: "bg-stone-400 text-white" },
  yml: { label: "YML", className: "bg-emerald-400 text-white" },
  yaml: { label: "YML", className: "bg-emerald-400 text-white" },
  env: { label: "ENV", className: "bg-lime-600 text-white" },
  py: { label: "PY", className: "bg-emerald-500 text-white" },
  svg: { label: "SVG", className: "bg-teal-400 text-white" },
  png: { label: "IMG", className: "bg-teal-400 text-white" },
  jpg: { label: "IMG", className: "bg-teal-400 text-white" },
  jpeg: { label: "IMG", className: "bg-teal-400 text-white" },
  gif: { label: "IMG", className: "bg-teal-400 text-white" },
  webp: { label: "IMG", className: "bg-teal-400 text-white" },
};

function getFileTypeMeta(name: string): FileTypeMeta | null {
  const lower = name.toLowerCase();
  if (lower === "package.json") return { label: "PKG", className: "bg-red-500 text-white" };
  if (/\.(test|spec)\.[jt]sx?$/.test(lower)) return { label: "✓", className: "bg-emerald-500 text-white" };
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex === -1) return null;
  return FILE_TYPE_MAP[lower.slice(dotIndex + 1)] ?? null;
}

function badgeFontSize(label: string) {
  if (label.length <= 1) return "text-[8px]";
  if (label.length === 2) return "text-[7px]";
  if (label.length === 3) return "text-[6px]";
  return "text-[5px]";
}

function FileTypeIcon({ name }: { name: string }) {
  const meta = getFileTypeMeta(name);
  if (!meta) {
    return (
      <span className="text-stone-500 dark:text-stone-500">
        <FileIcon />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm font-bold leading-none tracking-tighter ${badgeFontSize(meta.label)} ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

const STATUS_TONE: Record<FileStatus, string> = {
  new: "text-green-600 dark:text-green-400",
  modified: "text-amber-700 dark:text-amber-400",
  deleted: "text-stone-500 dark:text-stone-500",
};

const STATUS_LABEL: Record<FileStatus, string> = {
  new: "new",
  modified: "modified",
  deleted: "deleted",
};

interface FlatRow {
  node: TreeNode;
  depth: number;
  path: string;
}

function flatten(nodes: TreeNode[], depth: number, parentPath: string, collapsed: Set<string>, out: FlatRow[]) {
  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    out.push({ node, depth, path });
    if (node.type === "folder" && node.children && !collapsed.has(path)) {
      flatten(node.children, depth + 1, path, collapsed, out);
    }
  }
}

export function FileTree({ tree, rootLabel }: { tree: TreeNode[]; rootLabel?: string }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(tree, 0, "", collapsed, out);
    return out;
  }, [tree, collapsed]);

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-2 dark:border-stone-800 dark:bg-stone-900">
      {rootLabel && <p className="px-2 pb-1.5 pt-1 font-mono text-xs font-semibold text-stone-500 dark:text-stone-500">{rootLabel}</p>}
      <ul role="tree" aria-label="File tree" className="flex flex-col">
        {rows.map((row, i) => {
          const { node, depth, path } = row;
          const isFolder = node.type === "folder";
          const isOpen = isFolder && !collapsed.has(path);
          const isSelected = selected === path;
          return (
            <motion.li
              key={path}
              role="treeitem"
              aria-selected={!isFolder && isSelected}
              aria-expanded={isFolder ? isOpen : undefined}
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.22, delay: Math.min(i, 12) * 0.045, ease: [0.16, 1, 0.3, 1] }}
            >
              <button
                type="button"
                onClick={() => (isFolder ? toggleFolder(path) : setSelected(path))}
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
                className={`group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
                  isSelected ? "bg-emerald-500/10" : "hover:bg-black/[0.03] dark:hover:bg-white/5"
                }`}
              >
                {isFolder ? (
                  <motion.span
                    animate={{ rotate: isOpen ? 90 : 0 }}
                    transition={{ duration: 0.15 }}
                    className="shrink-0 text-stone-500"
                  >
                    <ChevronIcon />
                  </motion.span>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span
                  className={`shrink-0 ${
                    isFolder ? "text-stone-500 dark:text-stone-500" : node.status === "deleted" ? "opacity-60" : ""
                  }`}
                >
                  {isFolder ? <FolderIcon open={isOpen} /> : <FileTypeIcon name={node.name} />}
                </span>
                <span
                  className={`truncate text-sm ${
                    node.status === "deleted" ? "text-stone-500 line-through dark:text-stone-500" : "text-stone-700 dark:text-stone-200"
                  } ${isFolder ? "font-medium" : ""}`}
                >
                  {node.name}
                </span>
                {!isFolder && node.status && (
                  <span className={`ml-auto shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] ${STATUS_TONE[node.status]}`}>
                    {STATUS_LABEL[node.status]}
                  </span>
                )}
              </button>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}