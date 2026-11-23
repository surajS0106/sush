// The docs editor's block schema (BlockNote): the default blocks, code blocks that know a
// set of languages, and a diagram block of Sush's own (components/doc-diagram-block.tsx).
// Kept out of the editor's component file so that file exports only components and
// hot-reloads on its own. Also the Markdown conversions that keep diagram fences whole.

import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";

import { DiagramBlock } from "@/components/doc-diagram-block";
import { stripProviderCitations } from "@/lib/citations";
import { codeBlockSpec } from "@/lib/doc-code-block";

/** Code block languages, keyed by Shiki's language id (what highlighting loads). */
const LANGUAGES = {
  text: { name: "Plain text", aliases: ["txt", "plain"] },
  bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  css: { name: "CSS" },
  diff: { name: "Diff" },
  dockerfile: { name: "Dockerfile", aliases: ["docker"] },
  go: { name: "Go" },
  graphql: { name: "GraphQL", aliases: ["gql"] },
  html: { name: "HTML" },
  java: { name: "Java" },
  javascript: { name: "JavaScript", aliases: ["js"] },
  jsx: { name: "JSX" },
  json: { name: "JSON" },
  kotlin: { name: "Kotlin", aliases: ["kt"] },
  markdown: { name: "Markdown", aliases: ["md"] },
  mermaid: { name: "Mermaid" },
  php: { name: "PHP" },
  powershell: { name: "PowerShell", aliases: ["ps1"] },
  python: { name: "Python", aliases: ["py"] },
  ruby: { name: "Ruby", aliases: ["rb"] },
  rust: { name: "Rust", aliases: ["rs"] },
  scss: { name: "SCSS" },
  sql: { name: "SQL" },
  swift: { name: "Swift" },
  toml: { name: "TOML" },
  tsx: { name: "TSX" },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  xml: { name: "XML" },
  yaml: { name: "YAML", aliases: ["yml"] },
};

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    diagram: DiagramBlock(),
    codeBlock: codeBlockSpec({ defaultLanguage: "text", supportedLanguages: LANGUAGES }),
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
export function markdownToBlocks(editor: DocEditor, source: string): any[] {
  const markdown = stripProviderCitations(source);
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
