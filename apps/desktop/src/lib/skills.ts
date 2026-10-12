// Skills the way Claude Code and Copilot run them:
//   - The system prompt lists each enabled skill's name and description only; the model
//     loads the full instructions with the `skill` tool when a request matches.
//   - The user can invoke any skill explicitly with `/skill-name args`. The message is
//     expanded with the skill's instructions before it's sent.
//   - Skills are created in chat: the built-in `/create-skill` command has Sush interview
//     the user and save the result with `skill_save`, which the user approves.

import { CREATE_AUTOMATION_INSTRUCTIONS } from "@/lib/automation-save";
import { activeSkills, availableSkills, saveSkill, type Skill } from "@/lib/library";
import type { ToolSpec } from "@/lib/tauri";

export const SKILL = "skill";
export const SKILL_SAVE = "skill_save";

/** `Code review` -> `code-review`: the skill's slash command and the name the model uses. */
export const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";

export interface SlashCommand {
  name: string;
  description: string;
  instructions: string;
  /** A user's or plugin's skill; built-ins have none. */
  skill?: Skill;
}

const CREATE_SKILL_INSTRUCTIONS = `Help the user create a skill: standing instructions that you (or another assistant) will follow to do a kind of task the way they want.

1. Work out what the skill is for. If this chat already shows the task being done, start from that: the approach that worked, the user's preferences and corrections, and the output they accepted. Otherwise ask what the task is, when it should apply, and what a great result looks like. Ask at most a few focused questions, using ask_user when it's available; don't interrogate.
2. Draft the skill:
   - name: short and specific, e.g. "Code review" (its slash command becomes /code-review)
   - description: one sentence saying when to use it. You'll read only this to decide when the skill applies, so name the triggers ("When the user asks for...").
   - instructions: markdown, second person ("When asked to..."). Cover the method, the format, and the pitfalls. Generalise away one-off details (specific files, dates, numbers) unless they're part of the method.
3. Call skill_save with the draft. The user sees it and approves or rejects it. To change an existing skill, pass its command name as \`replaces\`.
4. Once saved, tell the user they can run it with its slash command, or just ask and it applies automatically.`;

const BUILT_INS: SlashCommand[] = [
  {
    name: "create-skill",
    description: "Create a new skill with Sush, from a description or from this chat",
    instructions: CREATE_SKILL_INSTRUCTIONS,
  },
  {
    name: "create-automation",
    description: "Set up an automation: a prompt Sush runs on a schedule",
    instructions: CREATE_AUTOMATION_INSTRUCTIONS,
  },
];

/** Every command the user can type: built-ins, then skills (on or off; slash invokes either). */
export function slashCommands(): SlashCommand[] {
  const builtIn = new Set(BUILT_INS.map((c) => c.name));
  const fromSkills = availableSkills()
    .map((s) => ({ name: slugify(s.name), description: s.description, instructions: s.instructions, skill: s }))
    .filter((c) => !builtIn.has(c.name));
  return [...BUILT_INS, ...fromSkills];
}

export const findCommand = (name: string) => slashCommands().find((c) => c.name === name.toLowerCase());

/** `/code-review src/app.ts` -> the command and its arguments, if the command exists. */
export function parseSlash(text: string): { command: SlashCommand; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const command = findCommand(match[1]);
  return command ? { command, args: match[2]?.trim() ?? "" } : null;
}

/** The known command a draft starts with, e.g. `/code-review` in `/code-review src/`; for highlighting. */
export function leadingCommand(text: string): string | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/i.exec(text);
  return match && findCommand(match[1]) ? match[0] : null;
}

/** What the model receives for a user message that starts with a slash command. */
export function expandSlash(text: string): string {
  const parsed = parseSlash(text);
  if (!parsed) return text;
  const { command, args } = parsed;
  return (
    `The user invoked /${command.name}. Follow these instructions for this request:\n\n` +
    `<skill name="${command.name}">\n${command.instructions}\n</skill>\n\n` +
    (args ? `<arguments>\n${args}\n</arguments>` : "The user gave no arguments.")
  );
}

// --- model-facing ---------------------------------------------------------------

/** The system prompt section listing the skills the model may load on its own. */
export function skillsPrompt(): string | null {
  const skills = activeSkills();
  if (skills.length === 0) return null;
  return (
    "You have skills: instructions for specific kinds of tasks. When a request matches a skill's " +
    "description, call the skill tool with its name before you respond, then follow what it returns. " +
    "Messages the user starts with /<name> already include that skill's instructions.\n\n" +
    `<available_skills>\n${skills.map((s) => `- ${slugify(s.name)}: ${s.description || s.name}`).join("\n")}\n</available_skills>`
  );
}

export const skillTool: ToolSpec = {
  name: SKILL,
  description: "Load a skill's full instructions by name. Use it when the request matches a skill in <available_skills>.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "The skill name, e.g. code-review" } },
    required: ["name"],
  },
};

export const skillSaveTool: ToolSpec = {
  name: SKILL_SAVE,
  description:
    "Save a skill the user asked you to create or change. The user reviews it before it's saved. " +
    "Use it when running /create-skill or when the user asks you to turn something into a skill.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short title, e.g. 'Code review'" },
      description: { type: "string", description: "One sentence on when to use the skill" },
      instructions: { type: "string", description: "The markdown instructions" },
      replaces: { type: "string", description: "Command name of an existing skill this updates, if any" },
    },
    required: ["name", "description", "instructions"],
  },
};

export interface SkillSaveInput {
  name: string;
  description: string;
  instructions: string;
  replaces?: string;
}

export function parseSkillSave(input: unknown): SkillSaveInput | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.name !== "string" || !i.name.trim() || typeof i.instructions !== "string" || !i.instructions.trim()) {
    return null;
  }
  return {
    name: i.name.trim(),
    description: typeof i.description === "string" ? i.description.trim() : "",
    instructions: i.instructions,
    replaces: typeof i.replaces === "string" && i.replaces.trim() ? i.replaces.trim().replace(/^\//, "") : undefined,
  };
}

/** The user's own skill a save would overwrite. Plugin skills are edited by reloading the plugin. */
export function skillToReplace(input: SkillSaveInput): Skill | undefined {
  const own = availableSkills().filter((s) => !s.pluginId);
  const slug = slugify(input.replaces ?? input.name);
  return own.find((s) => slugify(s.name) === slug);
}

export function loadSkill(name: string): { output: string } | { errorText: string } {
  const command = findCommand(slugify(name));
  if (!command) {
    const names = activeSkills().map((s) => slugify(s.name));
    return { errorText: `No skill named ${name}. Available: ${names.join(", ") || "none"}.` };
  }
  return { output: command.instructions };
}

export function applySkillSave(input: SkillSaveInput): Skill {
  const existing = skillToReplace(input);
  return saveSkill({
    id: existing?.id,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    enabled: existing?.enabled ?? true,
  });
}
