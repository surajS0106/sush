// Projects: named groups of chats with instructions every chat in them follows.
// The list lives in localStorage like the rest of the library; which project a
// chat is in is stored with the chat (`Conversation.projectId`).

import { useSyncExternalStore } from "react";

import { createStore, getConversations, setConversationProject } from "@/lib/store";

export interface Project {
  id: string;
  name: string;
  /** Added to the system prompt of every chat in the project. */
  instructions: string;
  createdAt: number;
}

const projects = createStore<Project[]>("sush.projects", []);

export const useProjects = () => useSyncExternalStore(projects.subscribe, projects.get);
export const getProject = (id: string | undefined) => (id ? projects.get().find((p) => p.id === id) : undefined);

export function createProject(name: string, instructions = ""): Project {
  const project: Project = { id: crypto.randomUUID(), name: name.trim() || "Untitled project", instructions, createdAt: Date.now() };
  projects.set((all) => [project, ...all]);
  return project;
}

export function updateProject(id: string, patch: Partial<Pick<Project, "name" | "instructions">>) {
  projects.set((all) => all.map((p) => (p.id === id ? { ...p, ...patch, name: patch.name?.trim() || p.name } : p)));
}

/** Delete a project; its chats are kept and go back to the session list. */
export function deleteProject(id: string) {
  for (const c of getConversations()) if (c.projectId === id) setConversationProject(c.id, undefined);
  projects.set((all) => all.filter((p) => p.id !== id));
}
