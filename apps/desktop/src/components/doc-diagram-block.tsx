// The diagram block in docs: a block of its own (not a code block) that draws a ```diagram
// spec with Sush's renderer (lib/diagram.ts), or a ```mermaid one with Mermaid. Hovering
// shows "⋯": edit the source (with the drawing updating as you type), copy it, or delete
// the block. In the stored Markdown it stays a fenced block (`blocksToMarkdown` in
// lib/doc-schema.ts), so the model reads and writes it as text.

import { createReactBlockSpec } from "@blocknote/react";
import { CopyIcon, EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { parseDiagram, renderDiagram, renderMermaid } from "@/lib/diagram";

/** Draws `source` into a box; an error says what's wrong instead. */
function Drawing({ source, lang }: { source: string; lang: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = useMemo(() => (lang === "mermaid" ? null : parseDiagram(source)), [source, lang]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let live = true;
    if (lang === "mermaid") {
      setError(null);
      renderMermaid(source).then(
        (svg) => {
          if (!live) return;
          host.innerHTML = svg;
        },
        () => live && setError(source.trim() ? "This Mermaid diagram has an error." : "Empty diagram"),
      );
    } else if (spec && !("error" in spec)) {
      setError(null);
      host.replaceChildren(renderDiagram(spec));
    } else {
      host.replaceChildren();
      setError(spec && "error" in spec ? spec.error : "Empty diagram");
    }
    return () => {
      live = false;
    };
  }, [spec, source, lang]);

  return (
    <>
      <div ref={ref} className={lang === "mermaid" ? "doc-diagram" : undefined} hidden={!!error} />
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
    </>
  );
}

export const DiagramBlock = createReactBlockSpec(
  {
    type: "diagram",
    propSchema: {
      source: { default: "" },
      /** "diagram" for Sush's own, or "mermaid". */
      lang: { default: "diagram" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const [editing, setEditing] = useState(false);
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const [draft, setDraft] = useState(block.props.source);
      const save = () => {
        if (draft !== block.props.source) editor.updateBlock(block, { props: { source: draft } });
        setEditing(false);
      };
      return (
        <div
          className="doc-widget group/widget w-full"
          contentEditable={false}
          // The editor shouldn't take keys or clicks meant for the source box and menu.
          onKeyDown={(e) => e.stopPropagation()}
          onDoubleClick={() => {
            setDraft(block.props.source);
            setEditing(true);
          }}
        >
          <Drawing source={editing ? draft : block.props.source} lang={block.props.lang} />
          {editing && (
            <div className="mt-4 flex flex-col gap-2">
              <textarea
                autoFocus
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                }}
                aria-label="Diagram source"
                className="min-h-40 w-full resize-y rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <div className="flex justify-end gap-2 text-sm">
                <button type="button" onClick={() => setEditing(false)} className="rounded-md px-3 py-1 hover:bg-accent">
                  Cancel
                </button>
                <button type="button" onClick={save} className="rounded-md bg-foreground px-3 py-1 text-background hover:bg-foreground/90">
                  Done
                </button>
              </div>
            </div>
          )}
          {!editing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Diagram options"
                  className="absolute top-2 right-2 flex h-7 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground opacity-0 transition-opacity group-hover/widget:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <EllipsisIcon className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onSelect={() => {
                    setDraft(block.props.source);
                    setEditing(true);
                  }}
                >
                  <PencilIcon /> Edit source
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void navigator.clipboard.writeText(block.props.source).then(() => toast.success("Diagram source copied"))}
                >
                  <CopyIcon /> Copy source
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => editor.removeBlocks([block])}>
                  <Trash2Icon /> Delete diagram
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      );
    },
    // Copied or exported, a diagram reads as its title and steps: the drawing needs the app.
    toExternalHTML: ({ block }) => {
      const spec = block.props.lang === "mermaid" ? null : parseDiagram(block.props.source);
      if (!spec || "error" in spec) return <pre>{block.props.source}</pre>;
      const label = new Map(spec.nodes.map((n) => [n.id, n.label]));
      return (
        <figure>
          {spec.title && <figcaption><strong>{spec.title}</strong></figcaption>}
          <ul>
            {spec.edges.map((e, i) => (
              <li key={i}>
                {label.get(e.from)} → {label.get(e.to)}
                {e.label ? ` (${e.label})` : ""}
              </li>
            ))}
          </ul>
        </figure>
      );
    },
  },
);
