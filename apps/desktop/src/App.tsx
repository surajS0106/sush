import { MotionConfig } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { AppSidebar, type SessionMode } from "@/components/app-sidebar";
import { ChatView } from "@/components/chat-view";
import { NavControls, type Nav } from "@/components/nav-controls";
import { lastActiveTab, SessionTabs, useTabs } from "@/components/session-tabs";
import { SettingsDialog } from "@/components/settings-dialog";
import { PanelToggles, WorkspaceChip } from "@/components/workspace-panel";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IS_MAC, useTrafficLights } from "@/components/window-controls";
import { useProviders } from "@/hooks/use-providers";
import { useAppearance } from "@/lib/appearance";
import { useLayout } from "@/lib/layout";
import { openSettings, syncConnectors, useChatRequest, type ChatRequest } from "@/lib/library";
import { deleteConversation, getOrCreateEmptyConversation, useConversations } from "@/lib/store";
import { errorMessage } from "@/lib/tauri";
import { cn, focusComposer } from "@/lib/utils";
import { addWorkspace, getWorkspaces } from "@/lib/workspaces";

export default function App() {
  const conversations = useConversations();
  const { providers, catalog, refresh } = useProviders();
  const ids = conversations.map((c) => c.id);
  const [activeId, setActiveId, nav] = useSessionHistory(lastActiveTab() ?? conversations[0]?.id ?? null, ids);
  const tabs = useTabs(activeId, ids, setActiveId);
  const { motion } = useAppearance();
  const layout = useLayout();

  const current = conversations.find((c) => c.id === activeId) ?? null;
  // New sessions open in a tab of their own; `inPlace` reuses the active tab.
  const startChat = (inPlace = false) => (inPlace ? setActiveId : tabs.openInNewTab)(getOrCreateEmptyConversation().id);
  const startCowork = (workspaceId: string, inPlace = false) =>
    (inPlace ? setActiveId : tabs.openInNewTab)(getOrCreateEmptyConversation(workspaceId).id);
  // "New" starts the same kind of session as the one open: a chat, or Cowork in the same folder.
  const startNew = () => (current?.workspaceId ? startCowork(current.workspaceId) : startChat());

  // The Chat / Cowork toggle switches the open tab's session. Cowork opens in the folder used most recently, or asks for one.
  const mode: SessionMode = current?.workspaceId ? "cowork" : "chat";
  const switchMode = async (to: SessionMode) => {
    if (to === mode) return;
    if (to === "chat") return startChat(true);
    const known = new Set(getWorkspaces().map((w) => w.id));
    const recent = conversations.find((c) => c.workspaceId && known.has(c.workspaceId))?.workspaceId ?? [...known][0];
    if (recent) return startCowork(recent, true);
    try {
      const added = await addWorkspace();
      if (added) startCowork(added.id, true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Ctrl/⌘+N or T starts a session in a new tab, Ctrl/⌘+W closes the tab, Ctrl+(Shift+)Tab cycles tabs,
  // Alt+←/→ walks the history.
  const keys = useRef({ startNew, nav, tabs, activeId });
  keys.current = { startNew, nav, tabs, activeId };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && (key === "n" || key === "t")) {
        e.preventDefault();
        keys.current.startNew();
      } else if (mod && !e.shiftKey && key === "w") {
        e.preventDefault();
        if (keys.current.activeId) keys.current.tabs.close(keys.current.activeId);
      } else if (e.ctrlKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        keys.current.tabs.cycle(e.shiftKey ? -1 : 1);
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
    tabs.openInNewTab(conversationId);
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
    if (!current) startChat();
  }, [current]);

  return (
    <MotionConfig reducedMotion={motion === "reduced" ? "always" : "user"}>
      <TooltipProvider>
        <SidebarProvider
          className="h-svh overflow-hidden"
          style={{ "--sidebar-width": `${layout.sidebar}px` } as React.CSSProperties}
        >
          <AppSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={startNew}
            onNewCowork={startCowork}
            mode={mode}
            onSwitchMode={(m) => void switchMode(m)}
            onDelete={(id) => {
              tabs.close(id);
              deleteConversation(id);
            }}
            onOpenSettings={() => openSettings({ section: "general" })}
            nav={nav}
          />
          <SidebarInset className="min-w-0">
            <AppHeader workspaceId={current?.workspaceId} nav={nav}>
              <SessionTabs
                open={tabs.open}
                conversations={conversations}
                activeId={activeId}
                onSelect={setActiveId}
                onClose={tabs.close}
                onReorder={tabs.reorder}
                onNew={startNew}
              />
            </AppHeader>
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
/** Holds the session tabs (`children`); for a Cowork session also the folder chip and the side panel toggles. */
function AppHeader({ workspaceId, nav, children }: { workspaceId?: string; nav: Nav; children: ReactNode }) {
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
          <Separator orientation="vertical" className="mx-2 data-vertical:h-4 data-vertical:self-auto" />
        </>
      )}
      {children}
      <span data-tauri-drag-region className="min-w-8 flex-1 self-stretch" />
      {workspaceId && (
        <>
          <WorkspaceChip workspaceId={workspaceId} />
          <PanelToggles />
        </>
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
