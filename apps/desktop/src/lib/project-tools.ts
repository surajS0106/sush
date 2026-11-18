// The model's tools for the user's Projects (`lib/projects.ts`): named groups of chats
// whose instructions every chat in them follows.
//
//   project_list    runs at once: projects, their instructions, chat counts, and this chat's project
//   project_manage  create, rename, change instructions, delete, or file this chat; asks with a card

import type { AppToolset, Args, PlanResult, ToolContext, ToolResult } from "@/lib/app-tool-kit";
import { clip, findBy, str } from "@/lib/app-tool-kit";
import { createProject, deleteProject, getProject, getProjects, updateProject } from "@/lib/projects";
import { getConversations, setConversationProject } from "@/lib/store";
import type { ToolSpec } from "@/lib/tauri";

export const PROJECT_LIST = "project_list";
export const PROJECT_MANAGE = "project_manage";

const ACTIONS = ["create", "update", "delete", "file", "unfile"] as const;
type Action = (typeof ACTIONS)[number];

const listTool: ToolSpec = {
  name: PROJECT_LIST,
  description:
    "List the user's projects in Sush: named groups of chats, each with instructions every chat in it follows. Also says which " +
    "project this chat is in. Use it before changing a project with project_manage.",
  inputSchema: { type: "object", properties: {} },
};

const manageTool: ToolSpec = {
  name: PROJECT_MANAGE,
  description:
    "Create a project, rename it or change its instructions (update), delete it, or file this chat under a project (file) or " +
    "take it out (unfile). create with fileThisChat files this chat in the new project at once. Deleting keeps its chats. " +
    "The user approves each change.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      project: { type: "string", description: "Its id or exact name, for update, delete and file." },
      name: { type: "string", description: "The name, for create, or a new name for update." },
      instructions: { type: "string", description: "Replaces the instructions; read them first to keep what's there." },
      fileThisChat: { type: "boolean", description: "With create: file this chat in the new project." },
    },
    required: ["action"],
  },
};

const chatsIn = (projectId: string) => getConversations().filter((c) => c.projectId === projectId).length;
const thisChat = (ctx: ToolContext) => (ctx.threadId ? getConversations().find((c) => c.id === ctx.threadId) : undefined);

async function read(_name: string, _args: Args, ctx: ToolContext): Promise<ToolResult> {
  const all = getProjects();
  const current = getProject(thisChat(ctx)?.projectId);
  return {
    output: JSON.stringify({
      projects: all.map((p) => ({ id: p.id, name: p.name, chats: chatsIn(p.id), instructions: clip(p.instructions, 1500) || undefined })),
      thisChat: current ? `In "${current.name}"` : "Not in a project",
      ...(all.length === 0 ? { note: "No projects yet." } : {}),
    }),
  };
}

async function plan(_name: string, args: Args, ctx: ToolContext): Promise<PlanResult> {
  const action = str(args.action) as Action;
  if (!ACTIONS.includes(action)) return { error: `action must be one of ${ACTIONS.join(", ")}.` };
  const instructions = typeof args.instructions === "string" ? args.instructions.trim() : undefined;
  const chat = thisChat(ctx);
  const noChat = "This chat can't be filed: it isn't a saved chat (incognito, or a sub-agent's).";

  if (action === "create") {
    const name = str(args.name);
    if (!name) return { error: "Give the new project a `name`." };
    if (getProjects().some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: `There's already a project "${name}". Use update or file instead.` };
    const file = args.fileThisChat === true;
    if (file && (!chat || chat.incognito)) return { error: noChat };
    return {
      title: `Create the project “${name}”?`,
      rows: [{ label: "Name", value: name }, ...(file ? [{ label: "This chat", value: "Filed in it" }] : [])],
      body: instructions || undefined,
      confirm: "Create",
      apply: () => {
        const p = createProject(name, instructions ?? "");
        if (file && chat) setConversationProject(chat.id, p.id);
        return { output: `Created "${p.name}" (${p.id})${file ? " and filed this chat in it" : ""}.` };
      },
    };
  }

  if (action === "unfile") {
    if (!chat) return { error: noChat };
    const current = getProject(chat.projectId);
    if (!current) return { error: "This chat isn't in a project." };
    return {
      title: `Take this chat out of “${current.name}”?`,
      rows: [{ label: "Chat", value: chat.title }],
      confirm: "Take out",
      apply: () => {
        setConversationProject(chat.id, undefined);
        return { output: `Took this chat out of "${current.name}".` };
      },
    };
  }

  const found = findBy(getProjects(), str(args.project), (p) => p.name, "project", PROJECT_LIST);
  if (!found.ok) return { error: found.error };
  const p = found.item;
  const quoted = `“${p.name}”`;

  if (action === "file") {
    if (!chat || chat.incognito) return { error: noChat };
    if (chat.projectId === p.id) return { error: `This chat is already in ${quoted}.` };
    const from = getProject(chat.projectId);
    return {
      title: `File this chat in ${quoted}?`,
      rows: [{ label: "Chat", value: chat.title }, ...(from ? [{ label: "Moves from", value: from.name }] : [])],
      body: p.instructions ? `Its instructions apply from your next message:\n\n${clip(p.instructions, 600)}` : undefined,
      confirm: "File it",
      apply: () => {
        setConversationProject(chat.id, p.id);
        return { output: `Filed this chat in "${p.name}". Its instructions apply from the next message.` };
      },
    };
  }

  if (action === "delete") {
    const n = chatsIn(p.id);
    return {
      title: `Delete the project ${quoted}?`,
      rows: [{ label: "Its chats", value: n ? `${n} kept, back in the session list` : "None" }],
      confirm: "Delete",
      destructive: true,
      apply: () => {
        deleteProject(p.id);
        return { output: `Deleted the project "${p.name}". Its chats were kept.` };
      },
    };
  }

  // update
  const name = str(args.name);
  const rows: { label: string; value: string; before?: string }[] = [];
  const patch: { name?: string; instructions?: string } = {};
  if (name && name !== p.name) {
    patch.name = name;
    rows.push({ label: "Name", before: p.name, value: name });
  }
  if (instructions !== undefined && instructions !== p.instructions) {
    patch.instructions = instructions;
    rows.push({ label: "Instructions", value: instructions ? "Replaced (below)" : "Cleared" });
  }
  if (rows.length === 0) return { error: `Nothing would change: pass a new name or instructions for ${quoted}.` };
  return {
    title: `Change ${quoted}?`,
    rows,
    body: patch.instructions || undefined,
    confirm: "Save",
    apply: () => {
      updateProject(p.id, patch);
      return { output: `Updated "${patch.name ?? p.name}".` };
    },
  };
}

export const projectToolset: AppToolset = {
  id: "projects",
  noun: "your projects",
  specs: [listTool, manageTool],
  reads: new Set([PROJECT_LIST]),
  read,
  plan,
};
