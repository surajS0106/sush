// The `ask_user` tool: the model asks the user multiple-choice questions and
// waits for the answers. It runs in the UI (AskUserCard), not in Rust; the
// answers go back to the model as the tool result.

import type { ToolSpec } from "@/lib/tauri";

export const ASK_USER = "ask_user";

export const askUserTool: ToolSpec = {
  name: ASK_USER,
  description:
    "Ask the user one or more multiple-choice questions and wait for their answers. Use it when a choice " +
    "only the user can make would materially change your response, e.g. ambiguous requirements or " +
    "picking between approaches. Don't use it for things you can reasonably decide or infer yourself. " +
    "Questions are shown one at a time; the user can pick options, type their own answer, or skip a question.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, phrased for the user." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: { type: "string" },
              description: "Short answer choices. The user can also type a different answer.",
            },
            multiSelect: { type: "boolean", description: "Allow picking more than one option. Defaults to false." },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

export interface AskUserQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
}

/** One entry per question, in order. `answer` is null when the user skipped it. */
export type AskUserOutput = { question: string; answer: string[] | null }[];

/** Validate the model's input; models occasionally send malformed arguments. */
export function parseAskUserInput(input: unknown): AskUserQuestion[] | null {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskUserQuestion[] = [];
  for (const q of raw) {
    if (typeof q?.question !== "string" || !Array.isArray(q.options)) return null;
    const options = q.options.filter((o: unknown): o is string => typeof o === "string" && o.trim() !== "");
    if (options.length === 0) return null;
    questions.push({ question: q.question, options, multiSelect: q.multiSelect === true });
  }
  return questions;
}
