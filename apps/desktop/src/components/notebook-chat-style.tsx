// How a notebook's chats answer: a role (research assistant, learning guide,
// critic, explain simply), the user's goal in their own words, and a length.
// Kept with the notebook in Rust (`notebook_set_chat`), which adds it to its
// chats' instructions (`notebooks::chat_section`); Studio outputs ignore it.

import { BookOpenCheckIcon, GraduationCapIcon, ScaleIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/PillTabs";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type ChatLength, type ChatRole, type ChatStyle, type Notebook } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export const ROLES: { role: ChatRole; label: string; hint: string; icon: ReactNode }[] = [
  { role: "default", label: "Research assistant", hint: "Answers from your sources, cited", icon: <BookOpenCheckIcon /> },
  { role: "guide", label: "Learning guide", hint: "Asks you questions and gives hints, so you learn it", icon: <GraduationCapIcon /> },
  { role: "critic", label: "Critic", hint: "Weighs the evidence and where sources disagree", icon: <ScaleIcon /> },
  { role: "simple", label: "Explain simply", hint: "Plain words and examples, for newcomers", icon: <SparklesIcon /> },
];

const LENGTHS: ChatLength[] = ["shorter", "default", "longer"];
const DEFAULT: ChatStyle = { role: "default", length: "default" };
const MAX_GOAL = 1000;

export const roleLabel = (role: ChatRole) => ROLES.find((r) => r.role === role)?.label ?? "Research assistant";

/** Whether the notebook's chats answer in a style the user set. */
export const hasChatStyle = (n: Notebook) => !!n.chat && (n.chat.role !== "default" || n.chat.length !== "default" || !!n.chat.goal);

export function ChatStyleDialog({ notebook, open, onOpenChange }: { notebook: Notebook; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [style, setStyle] = useState<ChatStyle>(notebook.chat ?? DEFAULT);
  const [saving, setSaving] = useState(false);
  // Start from what's saved each time it opens.
  useEffect(() => {
    if (open) setStyle(notebook.chat ?? DEFAULT);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      await api.notebookSetChat(notebook.id, { ...style, goal: style.goal?.trim() || undefined });
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn’t save how the chat answers", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure chat</DialogTitle>
          <DialogDescription>How this notebook’s chats answer. Answers still come from your sources, cited.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Answer as</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Answer as">
              {ROLES.map((r) => {
                const on = style.role === r.role;
                return (
                  <button
                    key={r.role}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setStyle((s) => ({ ...s, role: r.role }))}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 [&_svg]:size-4",
                      on ? "border-brand bg-brand/10" : "hover:border-brand/40 hover:bg-brand/5",
                    )}
                  >
                    <span className={cn("text-muted-foreground", on && "text-brand")} aria-hidden>
                      {r.icon}
                    </span>
                    <span className="text-sm font-medium">{r.label}</span>
                    <span className="text-xs text-muted-foreground">{r.hint}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="chat-goal">Your goal (optional)</Label>
            <Textarea
              id="chat-goal"
              value={style.goal ?? ""}
              maxLength={MAX_GOAL}
              onChange={(e) => setStyle((s) => ({ ...s, goal: e.target.value }))}
              placeholder="e.g. I’m preparing for a viva on chapter 3, so push me on the methods"
              className="min-h-20"
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Answer length</span>
            <PillTabs
              label="Answer length"
              tabs={["Shorter", "Default", "Longer"]}
              active={LENGTHS.indexOf(style.length)}
              onChange={(i) => setStyle((s) => ({ ...s, length: LENGTHS[i] }))}
              showPanels={false}
            />
          </div>
          <DialogFooter className="items-center">
            <Button type="button" variant="ghost" className="mr-auto" onClick={() => setStyle(DEFAULT)}>
              Reset
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
