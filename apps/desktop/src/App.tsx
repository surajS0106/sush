import { MotionConfig } from "motion/react";
import { useEffect, useState } from "react";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatView } from "@/components/chat-view";
import { SettingsDialog } from "@/components/settings-dialog";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProviders } from "@/hooks/use-providers";
import { useAppearance } from "@/lib/appearance";
import { openSettings, syncConnectors, useChatRequest, type ChatRequest } from "@/lib/library";
import { deleteConversation, getOrCreateEmptyConversation, useConversations } from "@/lib/store";
import { focusComposer } from "@/lib/utils";

export default function App() {
  const conversations = useConversations();
  const { providers, catalog, refresh } = useProviders();
  const [activeId, setActiveId] = useState<string | null>(() => conversations[0]?.id ?? null);
  const { motion } = useAppearance();

  const current = conversations.find((c) => c.id === activeId) ?? null;
  const startNew = () => setActiveId(getOrCreateEmptyConversation().id);

  // A request to start a chat with a prefilled prompt, e.g. "/create-skill " from Settings.
  const chatRequest = useChatRequest();
  const [prefill, setPrefill] = useState<(ChatRequest & { conversationId: string }) | null>(null);
  useEffect(() => {
    if (!chatRequest) return;
    const conversationId = getOrCreateEmptyConversation().id;
    setActiveId(conversationId);
    setPrefill({ ...chatRequest, conversationId });
  }, [chatRequest]);
  useEffect(() => {
    if (prefill) requestAnimationFrame(focusComposer);
  }, [prefill]);
  const prefilled = prefill && prefill.conversationId === current?.id ? prefill : null;

  // Always have a conversation to type into.
  // Start the connectors that were on last time.
  useEffect(() => {
    void syncConnectors();
  }, []);

  useEffect(() => {
    if (!current) startNew();
  }, [current]);

  return (
    <MotionConfig reducedMotion={motion === "reduced" ? "always" : "user"}>
      <TooltipProvider>
        <SidebarProvider className="h-svh overflow-hidden">
          <AppSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={startNew}
            onDelete={(id) => {
              deleteConversation(id);
              if (id === activeId) setActiveId(null);
            }}
            onOpenSettings={() => openSettings({ section: "general" })}
          />
          <SidebarInset className="min-w-0">
            <header className="flex h-12 shrink-0 items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              {current && current.messages.length > 0 && (
                <>
                  <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
                  <span className="truncate text-sm font-medium">{current.title}</span>
                </>
              )}
            </header>
            {current && (
              // Re-keyed on a prefill so the composer picks it up even if this chat was already open.
              <PromptInputProvider key={prefilled?.id ?? current.id} initialInput={current.messages.length === 0 ? prefilled?.prompt : undefined}>
                <ChatView
                  conversation={current}
                  catalog={catalog}
                  // Known as soon as the provider list loads; the catalog waits on every model list.
                  hasProviders={providers ? providers.length > 0 : null}
                  onOpenSettings={() => openSettings({ section: "providers" })}
                />
              </PromptInputProvider>
            )}
          </SidebarInset>
        </SidebarProvider>
        <SettingsDialog providers={providers ?? []} onProvidersChanged={() => void refresh()} />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </MotionConfig>
  );
}
