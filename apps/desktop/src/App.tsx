import { MotionConfig } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatView } from "@/components/chat-view";
import { NavControls, type Nav } from "@/components/nav-controls";
import { SettingsDialog } from "@/components/settings-dialog";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IS_MAC, useTrafficLights } from "@/components/window-controls";
import { useProviders } from "@/hooks/use-providers";
import { useAppearance } from "@/lib/appearance";
import { openSettings, syncConnectors, useChatRequest, type ChatRequest } from "@/lib/library";
import { deleteConversation, getOrCreateEmptyConversation, useConversations } from "@/lib/store";
import { cn, focusComposer } from "@/lib/utils";

export default function App() {
  const conversations = useConversations();
  const { providers, catalog, refresh } = useProviders();
  const [activeId, setActiveId, nav] = useSessionHistory(conversations[0]?.id ?? null, conversations.map((c) => c.id));
  const { motion } = useAppearance();

  const current = conversations.find((c) => c.id === activeId) ?? null;
  const startNew = () => setActiveId(getOrCreateEmptyConversation().id);

  // Ctrl/⌘+N starts a session, Alt+←/→ walks the history.
  const keys = useRef({ startNew, nav });
  keys.current = { startNew, nav };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        keys.current.startNew();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (e.key === "ArrowLeft") keys.current.nav.back();
        else keys.current.nav.forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
            nav={nav}
          />
          <SidebarInset className="min-w-0">
            <AppHeader title={current && current.messages.length > 0 ? current.title : null} nav={nav} />
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

/** Doubles as the window's title bar: drag it to move the window, double-click to maximize. */
function AppHeader({ title, nav }: { title: string | null; nav: Nav }) {
  const { state, isMobile } = useSidebar();
  // The sidebar's title bar carries these while it's showing.
  const sidebarHidden = isMobile || state === "collapsed";
  const trafficLights = useTrafficLights();
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-12 shrink-0 items-center gap-0.5 px-2 select-none",
        // Clear the custom window controls, or the macOS traffic lights once the sidebar is hidden.
        IS_MAC ? trafficLights && sidebarHidden && "pl-20" : "pr-36",
      )}
    >
      {sidebarHidden && (
        <>
          <NavControls nav={nav} />
          {title && <Separator orientation="vertical" className="mx-2 data-vertical:h-4 data-vertical:self-auto" />}
        </>
      )}
      {title && (
        <span data-tauri-drag-region className={cn("truncate text-sm font-medium", !sidebarHidden && "px-2")}>
          {title}
        </span>
      )}
    </header>
  );
}

/** The open session plus back/forward stacks of the ones visited before it; deleted sessions are skipped. */
function useSessionHistory(initial: string | null, ids: string[]) {
  const [activeId, setActive] = useState(initial);
  const [past, setPast] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const live = (stack: string[]) => stack.filter((id) => id !== activeId && ids.includes(id));

  const open = (id: string | null) => {
    if (id === activeId) return;
    if (activeId) setPast([...past, activeId]);
    setFuture([]);
    setActive(id);
  };
  const step = (from: string[], to: string[], setFrom: (s: string[]) => void, setTo: (s: string[]) => void) => {
    const stack = live(from);
    const id = stack.pop();
    if (!id) return;
    setFrom(stack);
    setTo(activeId ? [...live(to), activeId] : live(to));
    setActive(id);
  };

  const nav: Nav = {
    canBack: live(past).length > 0,
    canForward: live(future).length > 0,
    back: () => step(past, future, setPast, setFuture),
    forward: () => step(future, past, setFuture, setPast),
  };
  return [activeId, open, nav] as const;
}
