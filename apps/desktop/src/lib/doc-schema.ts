// The docs editor's block schema (BlockNote): the default blocks, code blocks that know a
// set of languages, and a diagram block of Sush's own (components/doc-diagram-block.tsx).
// Kept out of the editor's component file so that file exports only components and
// hot-reloads on its own. Also the Markdown conversions that keep diagram fences whole.

import { BlockNoteEditor, BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs } from "@blocknote/core";

import { DiagramBlock } from "@/components/doc-diagram-block";

const LANGUAGES = {
  text: { name: "Plain text", aliases: ["txt", "plain"] },
  mermaid: { name: "Mermaid" },
  typescript: { name: "TypeScript", aliases: ["ts", "tsx"] },
  javascript: { name: "JavaScript", aliases: ["js", "jsx"] },
  python: { name: "Python", aliases: ["py"] },
  rust: { name: "Rust", aliases: ["rs"] },
  go: { name: "Go" },
  java: { name: "Java" },
  swift: { name: "Swift" },
  bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
  json: { name: "JSON" },
  yaml: { name: "YAML", aliases: ["yml"] },
  html: { name: "HTML" },
  css: { name: "CSS" },
  sql: { name: "SQL" },
  markdown: { name: "Markdown", aliases: ["md"] },
};

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    diagram: DiagramBlock(),
    codeBlock: createCodeBlockSpec({ defaultLanguage: "text", supportedLanguages: LANGUAGES }),
  },
});

/** The docs editor, typed with this schema. */
export type DocEditor = BlockNoteEditor<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>;

/** A fenced diagram, closed: ```diagram or ```mermaid. */
const FENCE = /^(```|~~~)(diagram|mermaid)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;

/**
 * Markdown as blocks. BlockNote's own parser would make a diagram fence a code block,
 * so fences become diagram blocks here and the text between them goes to BlockNote.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function markdownToBlocks(editor: DocEditor, markdown: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  let at = 0;
  const text = (t: string) => {
    if (t.trim()) out.push(...editor.tryParseMarkdownToBlocks(t));
  };
  for (const m of markdown.matchAll(FENCE)) {
    text(markdown.slice(at, m.index));
    out.push({ type: "diagram", props: { source: m[3].replace(/\s+$/, ""), lang: m[2] } });
    at = m.index! + m[0].length;
  }
  text(markdown.slice(at));
  return out;
}

/** Blocks as Markdown, diagram blocks as their fences. */
export function blocksToMarkdown(editor: DocEditor, blocks = editor.document): string {
  const parts: string[] = [];
  let run: typeof blocks = [];
  const flush = () => {
    const t = run.length ? editor.blocksToMarkdownLossy(run).trim() : "";
    if (t) parts.push(t);
    run = [];
  };
  for (const b of blocks) {
    if (b.type === "diagram") {
      flush();
      const props = b.props as { source: string; lang: string };
      parts.push(`\`\`\`${props.lang || "diagram"}\n${props.source.trim()}\n\`\`\``);
    } else run.push(b);
  }
  flush();
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/** Markdown as HTML, through the editor's converter, for copying and exporting. */
export function markdownToHtml(markdown: string): string {
  const editor = BlockNoteEditor.create({ schema });
  return editor.blocksToHTMLLossy(markdownToBlocks(editor, markdown));
}
