// The workflow editor: a palette of steps, the canvas they sit on joined by
// curves (top to bottom), and the inspector for the picked step. Everything is
// pointer events (Tauri takes the webview's drag and drop on Windows).
//
// Canvas keys: arrows move between steps, Alt+arrows nudge (Shift for more),
// A connects from the picked step, Delete removes, ⌘Z / ⇧⌘Z undo and redo,
// ⇧1 fits the view, V and C pick the Select and Comment tools, Space+drag
// pans, ⌘+wheel or pinch zooms, Esc backs out.

import {
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  PlusIcon,
  ScanIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { WorkflowInspector } from "@/components/workflow-inspector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderModels } from "@/hooks/use-providers";
import { useSession } from "@/lib/auth";
import {
  commitMove,
  connect,
  defOf,
  durationText,
  editGraph,
  GROUPS,
  humanize,
  isTrigger,
  moveNodes,
  NODE_DEFS,
  newNode,
  redo,
  removeEdge,
  removeNodes,
  undo,
  updateWorkflow,
  type NodeDef,
  type NodeType,
  type Port,
  type StepRun,
  type WfComment,
  type WfNode,
  type WfRun,
  type Workflow,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";

export const NODE_W = 240;
export const NODE_H = 76;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

/** Where a port sits on its node, in canvas coordinates. */
function portAt(n: WfNode, port: Port | "in"): { x: number; y: number } {
  if (port === "in") return { x: n.x + NODE_W / 2, y: n.y };
  const ports = defOf(n.type).ports;
  const i = Math.max(0, ports.indexOf(port));
  return { x: n.x + (NODE_W * (i + 1)) / (ports.length + 1), y: n.y + NODE_H };
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
}

interface View {
  x: number;
  y: number;
  zoom: number;
}

type Selection = { node: string } | { edge: string } | null;

export interface CanvasHandle {
  fit: () => void;
  select: (nodeId: string) => void;
}

export const WorkflowEditor = forwardRef<
  CanvasHandle,
  {
    workflow: Workflow;
    run?: WfRun;
    onOpenStep: (nodeId: string) => void;
    /** Models to pick from, for a step's own model. */
    catalog: ProviderModels[];
  }
>(function WorkflowEditor({ workflow, run, onOpenStep, catalog }, ref) {
  const [selection, setSelection] = useState<Selection>(null);
  const selectedNode = selection && "node" in selection ? workflow.nodes.find((n) => n.id === selection.node) : undefined;
  const canvas = useRef<CanvasHandle & { dropAt: (type: NodeType, clientX: number, clientY: number) => boolean; addAfter: (type: NodeType) => void }>(null);

  useImperativeHandle(ref, () => ({
    fit: () => canvas.current?.fit(),
    select: (nodeId) => setSelection({ node: nodeId }),
  }));

  return (
    <div className="flex min-h-0 flex-1">
      <Palette
        onDrop={(type, x, y) => canvas.current?.dropAt(type, x, y) ?? false}
        onAdd={(type) => canvas.current?.addAfter(type)}
      />
      <Canvas ref={canvas} workflow={workflow} run={run} selection={selection} onSelect={setSelection} onOpenStep={onOpenStep} />
      <WorkflowInspector
        workflow={workflow}
        catalog={catalog}
        node={selectedNode}
        onSelect={(id) => setSelection(id ? { node: id } : null)}
        onClose={() => setSelection(null)}
      />
    </div>
  );
});

// --- palette ---------------------------------------------------------------------------------

function Palette({ onDrop, onAdd }: { onDrop: (type: NodeType, clientX: number, clientY: number) => boolean; onAdd: (type: NodeType) => void }) {
  const [query, setQuery] = useState("");
  const [ghost, setGhost] = useState<{ def: NodeDef; x: number; y: number } | null>(null);
  const q = query.trim().toLowerCase();
  const items = NODE_DEFS.filter((d) => !q || `${d.label} ${d.subtitle} ${d.description}`.toLowerCase().includes(q));

  const startDrag = (def: NodeDef, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      active = true;
      setGhost({ def, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("user-select");
      setGhost(null);
      if (active) onDrop(def.type, ev.clientX, ev.clientY);
      else onAdd(def.type);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside aria-label="Steps" className="flex w-60 shrink-0 flex-col border-r bg-background">
      <div className="relative p-3">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a step" aria-label="Find a step" className="h-8 pl-8" />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {GROUPS.map((g) => {
          const defs = items.filter((d) => d.group === g.id);
          if (defs.length === 0) return null;
          return (
            <section key={g.id} className="mb-3">
              <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{g.label}</h3>
              <ul className="flex flex-col gap-0.5">
                {defs.map((d) => (
                  <li key={d.type}>
                    <button
                      type="button"
                      onPointerDown={(e) => startDrag(d, e)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onAdd(d.type);
                        }
                      }}
                      title={`${d.description} Drag onto the canvas, or click to add after the picked step.`}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <NodeIcon def={d} small />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{d.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{d.subtitle}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {ghost && (
        <div className="pointer-events-none fixed z-50 flex w-48 -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg border bg-card p-2 text-sm shadow-lg" style={{ left: ghost.x, top: ghost.y }}>
          <NodeIcon def={ghost.def} small />
          {ghost.def.label}
        </div>
      )}
    </aside>
  );
}

export function NodeIcon({ def, small }: { def: NodeDef; small?: boolean }) {
  const Icon = def.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        small ? "size-6" : "size-8",
        def.group === "trigger" || def.group === "agent" ? "bg-brand/12 text-brand" : "bg-muted text-foreground/80",
      )}
    >
      <Icon className={small ? "size-3.5" : "size-4"} />
    </span>
  );
}

// --- canvas ----------------------------------------------------------------------------------

type Drag =
  | { kind: "pan"; startX: number; startY: number; view: View }
  | { kind: "node"; id: string; startX: number; startY: number; origin: { x: number; y: number }; before: { nodes: WfNode[]; edges: Workflow["edges"] }; moved: boolean }
  | { kind: "connect"; from: string; port: Port; x: number; y: number };

const Canvas = forwardRef<
  CanvasHandle & { dropAt: (type: NodeType, clientX: number, clientY: number) => boolean; addAfter: (type: NodeType) => void },
  {
    workflow: Workflow;
    run?: WfRun;
    selection: Selection;
    onSelect: (s: Selection) => void;
    onOpenStep: (nodeId: string) => void;
  }
>(function Canvas({ workflow, run, selection, onSelect, onOpenStep }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 80, y: 60, zoom: 1 });
  const [tool, setTool] = useState<"select" | "comment">("select");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [space, setSpace] = useState(false);
  const [connectFrom, setConnectFrom] = useState<{ id: string; port: Port } | null>(null);
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [newComment, setNewComment] = useState<{ x: number; y: number } | null>(null);
  const { data: session } = useSession();
  const id = workflow.id;

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
    },
    [view],
  );

  const fit = useCallback(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r || workflow.nodes.length === 0) return;
    const minX = Math.min(...workflow.nodes.map((n) => n.x));
    const minY = Math.min(...workflow.nodes.map((n) => n.y));
    const maxX = Math.max(...workflow.nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...workflow.nodes.map((n) => n.y + NODE_H));
    const pad = 64;
    const zoom = Math.min(1.2, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
    setView({ zoom, x: (r.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (r.height - (maxY - minY) * zoom) / 2 - minY * zoom });
  }, [workflow.nodes]);

  // Open on the whole graph.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === id) return;
    fitted.current = id;
    requestAnimationFrame(fit);
  }, [id, fit]);

  /** Where a new step goes: below the picked one (or the lowest one), or the middle of the view. */
  const spotAfter = (after?: WfNode) => {
    if (after) return { x: after.x, y: after.y + NODE_H + 72 };
    const r = box.current?.getBoundingClientRect();
    return r ? toWorld(r.left + r.width / 2 - (NODE_W / 2) * view.zoom, r.top + r.height / 3) : { x: 0, y: 0 };
  };

  const add = (type: NodeType, at: { x: number; y: number }, linkFrom?: WfNode) => {
    const def = defOf(type);
    if (def.group === "trigger" && workflow.nodes.some(isTrigger)) {
      toast("A workflow has one trigger", { description: "Pick the trigger and change its type in the inspector, or delete it first." });
      return;
    }
    const node = newNode(type, at, workflow.nodes);
    editGraph(id, (g) => {
      const edges = [...g.edges];
      const port = linkFrom ? defOf(linkFrom.type).ports[0] : undefined;
      // An End step has no way out, so nothing links from it.
      if (linkFrom && port && def.group !== "trigger") {
        edges.push({ id: crypto.randomUUID().slice(0, 8), from: linkFrom.id, port, to: node.id });
      }
      return { nodes: [...g.nodes, node], edges };
    });
    onSelect({ node: node.id });
  };

  useImperativeHandle(ref, () => ({
    fit,
    select: (nodeId) => onSelect({ node: nodeId }),
    dropAt: (type, clientX, clientY) => {
      const r = box.current?.getBoundingClientRect();
      if (!r || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
      const p = toWorld(clientX, clientY);
      add(type, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
      return true;
    },
    addAfter: (type) => {
      const picked = selection && "node" in selection ? workflow.nodes.find((n) => n.id === selection.node) : undefined;
      const lowest = [...workflow.nodes].sort((a, b) => b.y - a.y)[0];
      const after = picked ?? lowest;
      add(type, spotAfter(after), after);
    },
  }));

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = cx ?? r.left + r.width / 2;
    const py = cy ?? r.top + r.height / 2;
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: px - r.left - (px - r.left - v.x) * k, y: py - r.top - (py - r.top - v.y) * k };
    });
  };

  // Wheel: pan; with ⌘/Ctrl (and trackpad pinch) zoom. Non-passive so the page doesn't scroll.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Pointer drags: panning, moving a step, drawing a connection.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (drag.kind === "pan") setView({ ...drag.view, x: drag.view.x + e.clientX - drag.startX, y: drag.view.y + e.clientY - drag.startY });
      else if (drag.kind === "node") {
        const dx = (e.clientX - drag.startX) / view.zoom;
        const dy = (e.clientY - drag.startY) / view.zoom;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        moveNodes(id, { [drag.id]: { x: drag.origin.x + dx, y: drag.origin.y + dy } });
      } else {
        const p = toWorld(e.clientX, e.clientY);
        setDrag({ ...drag, x: p.x, y: p.y });
      }
    };
    const up = (e: PointerEvent) => {
      if (drag.kind === "node" && drag.moved) commitMove(id, drag.before);
      if (drag.kind === "connect") {
        const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x instanceof HTMLElement && x.dataset.nodeId) as HTMLElement | undefined;
        const to = el?.dataset.nodeId;
        if (to && to !== drag.from) {
          const why = connect(id, drag.from, drag.port, to);
          if (why) toast(why);
        }
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, id, toWorld, view.zoom]);

  const onBackgroundDown = (e: ReactPointerEvent) => {
    if (e.button === 1 || space || (e.button === 0 && tool === "select")) {
      if (e.button === 0 && !space) {
        onSelect(null);
        setConnectFrom(null);
        setOpenComment(null);
      }
      setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, view });
      box.current?.focus();
      return;
    }
    if (e.button === 0 && tool === "comment") {
      setNewComment(toWorld(e.clientX, e.clientY));
      setOpenComment(null);
    }
  };

  const onNodeDown = (n: WfNode, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    box.current?.focus();
    if (space) {
      setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, view });
      return;
    }
    if (connectFrom) {
      if (connectFrom.id !== n.id) {
        const why = connect(id, connectFrom.id, connectFrom.port, n.id);
        if (why) toast(why);
      }
      setConnectFrom(null);
      return;
    }
    onSelect({ node: n.id });
    setDrag({ kind: "node", id: n.id, startX: e.clientX, startY: e.clientY, origin: { x: n.x, y: n.y }, before: { nodes: workflow.nodes, edges: workflow.edges }, moved: false });
  };

  const onPortDown = (n: WfNode, port: Port, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = portAt(n, port);
    setDrag({ kind: "connect", from: n.id, port, x: p.x, y: p.y });
  };

  // Keys, while the canvas has focus.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const picked = selection && "node" in selection ? workflow.nodes.find((n) => n.id === selection.node) : undefined;
    if (e.key === " " && !space) {
      e.preventDefault();
      setSpace(true);
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(id);
      else if (!undo(id)) toast("Nothing to undo");
      return;
    }
    if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) {
      e.preventDefault();
      fit();
      return;
    }
    if (e.key === "Escape") {
      if (connectFrom) setConnectFrom(null);
      else if (newComment || openComment) {
        setNewComment(null);
        setOpenComment(null);
      } else if (tool === "comment") setTool("select");
      else onSelect(null);
      return;
    }
    if (mod) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (picked) removeNodes(id, [picked.id]);
      else if (selection && "edge" in selection) removeEdge(id, selection.edge);
      onSelect(null);
      return;
    }
    if (e.key.toLowerCase() === "v") setTool("select");
    if (e.key.toLowerCase() === "c") setTool("comment");
    if (e.key.toLowerCase() === "a" && picked && defOf(picked.type).ports.length) {
      const port = defOf(picked.type).ports[0];
      setConnectFrom({ id: picked.id, port });
      toast("Pick the step to connect to", { description: "Esc cancels." });
      return;
    }
    if (e.key.toLowerCase() === "e" && picked) {
      document.getElementById("workflow-connections")?.focus();
      return;
    }
    const dirs: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const dir = dirs[e.key];
    if (!dir) return;
    e.preventDefault();
    if (e.altKey && picked) {
      const step = e.shiftKey ? 50 : 10;
      editGraph(id, (g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === picked.id ? { ...n, x: n.x + dir[0] * step, y: n.y + dir[1] * step } : n)) }));
      return;
    }
    // Move to the nearest step that way.
    const from = picked ?? workflow.nodes[0];
    if (!from) return;
    const candidates = workflow.nodes
      .filter((n) => n.id !== from.id)
      .map((n) => ({ n, dx: n.x - from.x, dy: n.y - from.y }))
      .filter(({ dx, dy }) => (dir[0] ? Math.sign(dx) === dir[0] && Math.abs(dx) >= Math.abs(dy) / 2 : Math.sign(dy) === dir[1] && Math.abs(dy) >= Math.abs(dx) / 2))
      .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
    const next = picked ? candidates[0]?.n : from;
    if (next) onSelect({ node: next.id });
  };

  const steps = run?.steps ?? {};
  const pickedNode = selection && "node" in selection ? selection.node : null;
  const pickedEdge = selection && "edge" in selection ? selection.edge : null;
  const comments = workflow.comments;

  const saveComment = (text: string) => {
    if (!newComment || !text.trim()) return;
    const c: WfComment = {
      id: crypto.randomUUID().slice(0, 8),
      x: newComment.x,
      y: newComment.y,
      text: text.trim(),
      author: session?.user?.name || "You",
      resolved: false,
      createdAt: Date.now(),
    };
    updateWorkflow(id, (w) => ({ ...w, comments: [...w.comments, c] }));
    setNewComment(null);
    setTool("select");
  };

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-muted/30">
      <div
        ref={box}
        role="application"
        aria-label="Workflow canvas. Arrows move between steps; A connects; Delete removes; Shift+1 fits the view."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.key === " " && setSpace(false)}
        onBlur={() => setSpace(false)}
        onPointerDown={onBackgroundDown}
        className={cn(
          "absolute inset-0 outline-none",
          (space || drag?.kind === "pan") && "cursor-grabbing",
          space && !drag && "cursor-grab",
          tool === "comment" && !space && "cursor-crosshair",
          connectFrom && "cursor-copy",
        )}
        style={{
          backgroundImage: "radial-gradient(circle, color-mix(in oklab, var(--foreground) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="pointer-events-none absolute overflow-visible" width="1" height="1" aria-hidden>
            {workflow.edges.map((e) => {
              const from = workflow.nodes.find((n) => n.id === e.from);
              const to = workflow.nodes.find((n) => n.id === e.to);
              if (!from || !to) return null;
              const d = curve(portAt(from, e.port), portAt(to, "in"));
              const taken = steps[e.from]?.status === "done" && steps[e.from]?.port === e.port;
              const flowing = taken && (steps[e.to]?.status === "running" || steps[e.to]?.status === "waiting");
              const picked = pickedEdge === e.id;
              return (
                <g key={e.id}>
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      onSelect({ edge: e.id });
                      box.current?.focus();
                    }}
                  />
                  {picked && <path d={d} fill="none" strokeWidth={8} className="stroke-brand/25" />}
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={picked || taken ? 2 : 1.5}
                    strokeDasharray={flowing ? "6 6" : undefined}
                    className={cn(taken || picked ? "stroke-brand" : "stroke-foreground/30", flowing && "motion-safe:animate-[wf-dash_0.8s_linear_infinite]")}
                  />
                  {e.port !== "out" && (
                    <text x={portAt(from, e.port).x + 6} y={portAt(from, e.port).y + 16} className="fill-muted-foreground text-[10px]">
                      {e.port === "yes" ? "Yes" : "No"}
                    </text>
                  )}
                </g>
              );
            })}
            {drag?.kind === "connect" &&
              (() => {
                const from = workflow.nodes.find((n) => n.id === drag.from);
                return from ? <path d={curve(portAt(from, drag.port), { x: drag.x, y: drag.y })} fill="none" strokeWidth={2} strokeDasharray="4 4" className="stroke-brand" /> : null;
              })()}
          </svg>

          {workflow.nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              summary={humanize(workflow, summary(n))}
              step={steps[n.id]}
              picked={pickedNode === n.id}
              connecting={!!connectFrom && connectFrom.id !== n.id}
              onPointerDown={(e) => onNodeDown(n, e)}
              onPortDown={(port, e) => onPortDown(n, port, e)}
              onOpenStep={() => onOpenStep(n.id)}
            />
          ))}

          {comments.map((c) => (
            <CommentPin
              key={c.id}
              comment={c}
              open={openComment === c.id}
              onOpen={() => {
                setOpenComment(openComment === c.id ? null : c.id);
                setNewComment(null);
              }}
              onClose={() => setOpenComment(null)}
              onResolve={() => updateWorkflow(id, (w) => ({ ...w, comments: w.comments.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)) }))}
              onDelete={() => {
                updateWorkflow(id, (w) => ({ ...w, comments: w.comments.filter((x) => x.id !== c.id) }));
                setOpenComment(null);
              }}
            />
          ))}
          {newComment && <NewComment at={newComment} onSave={saveComment} onCancel={() => setNewComment(null)} />}
        </div>
      </div>

      {workflow.nodes.length <= 1 && (
        <p className="pointer-events-none absolute inset-x-0 bottom-20 text-center text-sm text-muted-foreground">
          Drag steps from the left onto the canvas, or click one to add it after the picked step.
        </p>
      )}

      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-card p-1 shadow-sm" role="toolbar" aria-label="Canvas">
        <ToolButton label="Select" shortcut="V" on={tool === "select"} onClick={() => setTool("select")}>
          <MousePointer2Icon />
        </ToolButton>
        <ToolButton label="Comment" shortcut="C" on={tool === "comment"} onClick={() => setTool("comment")}>
          <MessageSquarePlusIcon />
        </ToolButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton label="Zoom out" shortcut="⌘ wheel" onClick={() => zoomBy(1 / 1.2)}>
          <ZoomOutIcon />
        </ToolButton>
        <span className="w-10 text-center text-xs text-muted-foreground tabular-nums">{Math.round(view.zoom * 100)}%</span>
        <ToolButton label="Zoom in" shortcut="⌘ wheel" onClick={() => zoomBy(1.2)}>
          <ZoomInIcon />
        </ToolButton>
        <ToolButton label="Fit to view" shortcut="⇧1" onClick={fit}>
          <ScanIcon />
        </ToolButton>
      </div>
    </div>
  );
});

function ToolButton({ label, shortcut, on, onClick, children }: { label: string; shortcut: string; on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={on} onClick={onClick} className={cn(on && "bg-muted text-foreground")}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <span className="text-muted-foreground">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** One line under a step's name: what it's set to do. */
function summary(n: WfNode): string {
  const c = n.config;
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (n.type) {
    case "crm-event": {
      const what = { any: "Any change", created: "Added", updated: "Changed", "stage-changed": "Moves stage", deleted: "Deleted" }[s(c.event) || "any"];
      return `${what}${c.kind && c.kind !== "any" ? ` · ${c.kind}s` : ""}`;
    }
    case "agent":
      return s(c.prompt) || "Say what it should do";
    case "tool":
      return s(c.tool) || "Pick a tool";
    case "if":
      return c.mode === "ai" ? s(c.question) || "Ask a yes/no question" : c.left ? `${s(c.left)} ${s(c.op)} ${s(c.right)}` : "Set a condition";
    case "approval":
      return s(c.message) || "Waits for you";
    case "delay":
      return `${s(c.minutes) || 0} min`;
    case "parallel":
      return "Branches run side by side";
    case "join":
      return c.mode === "first" ? "Goes on at the first branch" : "Waits for every branch";
    case "end":
      return c.outcome === "failed" ? `Fails${c.message ? `: ${s(c.message)}` : ""}` : s(c.message) || "Finishes the run";
    case "crm-update":
      return [c.stage && `stage → ${c.stage}`, c.owner && `owner → ${c.owner}`, c.value && `value → ${c.value}`, c.field && `${c.field}`].filter(Boolean).join(", ") || "Pick what to change";
    case "crm-log":
      return s(c.body) || "Write what to log";
    case "board-task":
      return s(c.title) || "Task title";
    case "notify":
      return s(c.title) || "Notification";
    case "cowork":
      return s(c.prompt) || "Prompt";
    default:
      return defOf(n.type).subtitle;
  }
}

function NodeCard({
  node,
  summary: line,
  step,
  picked,
  connecting,
  onPointerDown,
  onPortDown,
  onOpenStep,
}: {
  node: WfNode;
  summary: string;
  step?: StepRun;
  picked: boolean;
  connecting: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPortDown: (port: Port, e: ReactPointerEvent) => void;
  onOpenStep: () => void;
}) {
  const def = defOf(node.type);
  const trigger = def.group === "trigger";
  const status = step?.status;
  return (
    <div
      data-node-id={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${node.label}, ${def.subtitle}${status && status !== "pending" ? `, ${status}` : ""}`}
      aria-pressed={picked}
      onPointerDown={onPointerDown}
      onDoubleClick={() => step?.threadId && onOpenStep()}
      className={cn(
        "absolute flex cursor-default flex-col gap-1 rounded-xl border bg-card p-2 text-sm shadow-xs transition-[box-shadow,opacity,border-color]",
        picked && "border-brand ring-3 ring-brand/20",
        connecting && "hover:border-brand",
        status === "running" && "border-brand",
        status === "waiting" && "border-brand border-dashed",
        status === "failed" && "border-coral",
        status === "skipped" && "opacity-50",
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <NodeIcon def={def} small />
        <span className="min-w-0 flex-1 truncate font-medium">{node.label}</span>
        <StatusMark step={step} />
      </div>
      <p className="truncate pl-8 text-xs text-muted-foreground">{line}</p>
      {!trigger && <span aria-hidden className="absolute -top-1.5 left-1/2 size-3 -translate-x-1/2 rounded-full border-2 border-card bg-foreground/40" />}
      {def.ports.map((p, i) => (
        <button
          key={p}
          type="button"
          tabIndex={-1}
          aria-label={`Connect from ${p === "out" ? "this step" : p === "yes" ? "Yes" : "No"}`}
          title={p === "out" ? "Drag to connect" : `${p === "yes" ? "Yes" : "No"}: drag to connect`}
          onPointerDown={(e) => onPortDown(p, e)}
          className={cn(
            "absolute -bottom-2 size-4 -translate-x-1/2 cursor-crosshair rounded-full border-2 border-card transition-transform hover:scale-125",
            p === "no" ? "bg-foreground/40" : "bg-brand",
          )}
          style={{ left: `${((i + 1) / (def.ports.length + 1)) * 100}%` }}
        />
      ))}
    </div>
  );
}

function StatusMark({ step }: { step?: StepRun }) {
  if (!step || step.status === "pending" || step.status === "skipped") return null;
  if (step.status === "running") return <LoaderCircleIcon aria-label="Running" className="size-4 animate-spin text-brand" />;
  if (step.status === "waiting") return <span className="rounded-full bg-brand/12 px-1.5 text-[10px] font-medium text-brand">Waiting</span>;
  if (step.status === "failed") return <CircleAlertIcon aria-label="Failed" className="size-4 text-coral" />;
  const ms = step.endedAt && step.startedAt ? step.endedAt - step.startedAt : null;
  return (
    <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
      <CheckIcon className="size-3 text-brand" />
      {ms != null && durationText(ms)}
    </span>
  );
}

function CommentPin({
  comment,
  open,
  onOpen,
  onClose,
  onResolve,
  onDelete,
}: {
  comment: WfComment;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onResolve: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="absolute" style={{ left: comment.x, top: comment.y }} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`Comment by ${comment.author}: ${comment.text}`}
        onClick={onOpen}
        className={cn(
          "flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none border-2 border-card bg-brand text-[11px] font-semibold text-brand-foreground shadow-sm",
          comment.resolved && "bg-muted text-muted-foreground",
        )}
      >
        {comment.author.charAt(0).toUpperCase()}
      </button>
      {open && (
        <div className="absolute top-1 left-2 z-10 w-64 rounded-lg border bg-popover p-3 text-sm shadow-md">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{comment.author}</span>
            <span className="flex-1">{new Date(comment.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded p-0.5 hover:bg-muted">
              <XIcon className="size-3.5" />
            </button>
          </div>
          <p className="break-words whitespace-pre-wrap">{comment.text}</p>
          <div className="mt-2 flex justify-end gap-1">
            <Button variant="ghost" size="xs" onClick={onDelete}>
              <Trash2Icon />
              Delete
            </Button>
            <Button variant="outline" size="xs" onClick={onResolve}>
              {comment.resolved ? "Reopen" : "Resolve"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewComment({ at, onSave, onCancel }: { at: { x: number; y: number }; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="absolute z-10 w-64 rounded-lg border bg-popover p-2 shadow-md" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSave(text);
          }
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Add a comment (Enter posts, Shift+Enter for a new line)"
        aria-label="Comment"
        rows={3}
        className="w-full resize-none rounded-md bg-transparent p-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => onSave(text)} disabled={!text.trim()}>
          <PlusIcon />
          Post
        </Button>
      </div>
    </div>
  );
}

/** Steps in reading order (top to bottom, then left to right), for the run panel. */
export function inOrder(nodes: WfNode[]): WfNode[] {
  return [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
}

export const useNodeOrder = (nodes: WfNode[]) => useMemo(() => inOrder(nodes), [nodes]);
