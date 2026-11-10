// The CRM page's "Ask Sush" panel: a chat beside the table that works on the
// CRM (its runs get the CRM tools and instructions, `sessions.ts`). The
// record drawer's AI actions (enrich, catch up, next step) send their work
// here, so it streams, asks before changing anything, and can be followed up.

import { ContactIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { ChatView } from "@/components/chat-view";
import { Button } from "@/components/ui/button";
import type { ProviderModels } from "@/hooks/use-providers";
import { addCrmThread, crmPage, formatMoney, getCrm, getCrmThreadIds, recordById, stageOf, useCrmThreadIds } from "@/lib/crm";
import { sendMessage } from "@/lib/sessions";
import { createConversation, getConversations, useConversations } from "@/lib/store";
import type { CrmRecord } from "@/lib/tauri";

export const useAskOpen = () => useSyncExternalStore(crmPage.subscribe, () => crmPage.get().ask ?? false);
export const setAskOpen = (ask: boolean) => crmPage.set((s) => ({ ...s, ask }));

/** The panel's chat: the newest CRM thread that still exists, or a new one. */
function currentThread(fresh = false): string {
  const ids = getCrmThreadIds();
  const existing = getConversations();
  if (!fresh) {
    for (let i = ids.length - 1; i >= 0; i--) if (existing.some((c) => c.id === ids[i])) return ids[i];
  }
  const convo = createConversation(undefined, "CRM");
  addCrmThread(convo.id);
  return convo.id;
}

/** Send `label` to the panel's chat (the model also gets `instruction`) and open the panel. */
export function askCrm(label: string, instruction?: string) {
  const id = currentThread();
  setAskOpen(true);
  sendMessage(id, label, [], instruction ? { text: instruction } : undefined);
}

const SUGGESTIONS = [
  "Which deals close this month, and what's the total?",
  "Show me open deals with no activity in two weeks",
  "Which customers renew in the next 60 days?",
  "Who owns the most pipeline?",
];

export function CrmAskPanel({
  catalog,
  hasProviders,
  onOpenSettings,
  onOpenSession,
}: {
  catalog: ProviderModels[];
  hasProviders: boolean | null;
  onOpenSettings: () => void;
  onOpenSession: (id: string) => void;
}) {
  const ids = useCrmThreadIds();
  const conversations = useConversations();
  const id = [...ids].reverse().find((x) => conversations.some((c) => c.id === x));
  const conversation = conversations.find((c) => c.id === id);

  // Opened without a chat (first time, or its chat was deleted): start one.
  useEffect(() => {
    if (!id) currentThread(true);
  }, [id]);

  return (
    <aside aria-label="Ask Sush about your CRM" className="flex w-[26rem] max-w-full shrink-0 flex-col border-l bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <ContactIcon className="size-4 text-brand" />
        <h2 className="flex-1 text-sm font-medium">Ask Sush</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New chat"
          title="New chat"
          disabled={!conversation || conversation.messages.length === 0}
          onClick={() => currentThread(true)}
        >
          <PlusIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setAskOpen(false)}>
          <XIcon />
        </Button>
      </header>
      {conversation && (
        <PromptInputProvider key={conversation.id}>
        <ChatView
          key={conversation.id}
          conversation={conversation}
          catalog={catalog}
          hasProviders={hasProviders}
          onOpenSettings={onOpenSettings}
          onOpenSession={onOpenSession}
          emptyState={(ask) => (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Ask about your companies, contacts and deals, or have Sush update them. It shows you every change before making it.
              </p>
              <div className="flex flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    className="rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        />
        </PromptInputProvider>
      )}
    </aside>
  );
}

// --- the drawer's AI actions -----------------------------------------------------------------

/** One line about a record for an instruction: its id, so the model reads it, and what's known. */
function about(r: CrmRecord): string {
  const { settings } = getCrm();
  const bits = [`id ${r.id}`];
  const company = recordById(r.companyId);
  if (company) bits.push(`company "${company.name}" (id ${company.id})`);
  if (r.domain) bits.push(`domain ${r.domain}`);
  if (r.email) bits.push(`email ${r.email}`);
  const stage = stageOf(settings, r);
  if (stage) bits.push(`stage ${stage.name}`);
  if (r.value != null) bits.push(`value ${formatMoney(r.value, settings.currency)}`);
  return `the ${r.kind} "${r.name}" (${bits.join(", ")})`;
}

export interface CrmAction {
  id: string;
  label: string;
  hint: string;
  run: (r: CrmRecord) => void;
}

/** The AI actions a record offers. */
export function crmActions(r: CrmRecord): CrmAction[] {
  const enrich: CrmAction = {
    id: "enrich",
    label: "Enrich",
    hint: "Fill in missing details from the web",
    run: (x) =>
      askCrm(
        `Enrich ${x.name}`,
        `Research ${about(x)} on the web (web_search, web_fetch; start from its domain if it has one). Then, in ONE crm_write call, ` +
          "fill in only what's missing or clearly out of date: domain, category (industry), a short description in notes (keep any notes " +
          "already there: read them with crm_read first), and up to 3 key people as new contacts linked to the company, with title and " +
          "public work email only if published. Don't guess: leave out what you can't source. Then say in two lines what you found and where.",
      ),
  };
  const catchUp: CrmAction = {
    id: "catch-up",
    label: "Catch up",
    hint: "Summarize recent email and meetings",
    run: (x) =>
      askCrm(
        `Catch up on ${x.name}`,
        `Catch me up on ${about(x)}. Read it with crm_read. If a Gmail or calendar connector is connected, look for emails and meetings ` +
          "with its people or domain from the last 90 days. Log one dated summary on the record with crm_log (kind ai): what happened, " +
          "open questions, and the next step. If the stage looks out of date, propose the change with crm_write. If no mail or calendar " +
          "connector is connected, summarise from the CRM's own activity and say that connecting Gmail or Google Calendar would add more.",
      ),
  };
  const nextStep: CrmAction = {
    id: "next-step",
    label: "Next step",
    hint: "Suggest the next move and draft the email",
    run: (x) =>
      askCrm(
        `Next step for ${x.name}`,
        `Suggest the single best next step for ${about(x)}. Read it and its company with crm_read first. Give the step and one line on ` +
          "why. If the step is an email, write it (short, specific, in my voice) and, if a Gmail connector is connected, save it as a draft " +
          "with its draft tool; never send. If it's a meeting and a calendar connector is connected, suggest two times. Log the suggestion " +
          "with crm_log (kind ai).",
      ),
  };
  if (r.kind === "company") return [enrich, catchUp];
  if (r.kind === "contact") return [catchUp, { ...nextStep, hint: "Suggest a follow-up and draft it" }];
  return [nextStep, catchUp];
}
