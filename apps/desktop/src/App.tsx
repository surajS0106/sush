import { MotionConfig } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { AppSidebar, type Page, type SessionMode } from "@/components/app-sidebar";
import { AutomationsPage } from "@/components/automations-page";
import { ChatView } from "@/components/chat-view";
import { ErrorBoundary } from "@/components/error-boundary";
import { NavControls, type Nav } from "@/components/nav-controls";
import { ReportsPage } from "@/components/reports-page";
import { WikiPage } from "@/components/wiki-page";
import { IncognitoToggle, SessionDialogs, SessionMenu } from "@/components/session-actions";
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
import { automationForThread, getAutomations, markSeen, startScheduler, useOpenRunRequest } from "@/lib/automations";
import { watchBudget } from "@/lib/budget";
import { useLayout } from "@/lib/layout";
import { openSettings, syncConnectors, useChatRequest, type ChatRequest } from "@/lib/library";
import {
  createIncognitoConversation,
  deleteConversation,
  getConversations,
  getOrCreateEmptyConversation,
  useConversations,
  type Conversation,
} from "@/lib/store";
import { errorMessage } from "@/lib/tauri";
import { cn, focusComposer } from "@/lib/utils";
import { whenLeader } from "@/lib/windows";
import { addWorkspace, getWorkspaces } from "@/lib/workspaces";

export default function App() {
  const conversations = useConversations();
  const { providers, catalog, refresh } = useProviders();
  const ids = conversations.map((c) => c.id);
  const [activeId, openSession, nav] = useSessionHistory(lastActiveTab() ?? conversations[0]?.id ?? null, ids);
  // The main area shows the open session, or a page like Automations; opening any session goes back to it.
  const [page, setPage] = useState<Page>("session");
  const setActiveId = (id: string | null) => {
    setPage("session");
    openSession(id);
  };
  const tabs = useTabs(activeId, ids, setActiveId);
  const { motion } = useAppearance();
  const layout = useLayout();

  const current = conversations.find((c) => c.id === activeId) ?? null;
  // Opening an automation's run counts as seeing it.
  useEffect(() => {
    const automation = page === "session" && activeId ? automationForThread(getAutomations(), activeId) : undefined;
    if (automation) markSeen(automation.id);
  }, [activeId, page]);
  // New sessions open in a tab of their own; `inPlace` reuses the active tab.
  const startChat = (inPlace = false) => (inPlace ? setActiveId : tabs.openInNewTab)(getOrCreateEmptyConversation().id);
  const startCowork = (workspaceId: string, inPlace = false) =>
    (inPlace ? setActiveId : tabs.openInNewTab)(getOrCreateEmptyConversation(workspaceId).id);
  const startInProject = (projectId: string) => tabs.openInNewTab(getOrCreateEmptyConversation(undefined, projectId).id);
  // "New" starts the same kind of session as the one open: a chat (in the same project), or Cowork in the same folder.
  const startNew = () =>
    current?.workspaceId
      ? startCowork(current.workspaceId)
      : current?.projectId && !current.incognito
        ? startInProject(current.projectId)
        : startChat();

  // The ghost starts an incognito chat (in this tab if it's untouched), or leaves the one that's open.
  const toggleIncognito = () => {
    if (current?.incognito) return startChat(true);
    const id = createIncognitoConversation().id;
    if (current && current.messages.length === 0) setActiveId(id);
    else tabs.openInNewTab(id);
  };
  // An incognito chat is gone once you leave it: Rust drops its messages and it never reaches disk.
  const previous = useRef(activeId);
  useEffect(() => {
    const left = previous.current;
    previous.current = activeId;
    if (left && left !== activeId && getConversations().find((c) => c.id === left)?.incognito) deleteConversation(left);
  }, [activeId]);
  const deleteSession = (id: string) => {
    tabs.close(id);
    deleteConversation(id);
  };

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
    setPage("session");
    setPrefill({ ...chatRequest, conversationId });
  }, [chatRequest]);
  useEffect(() => {
    if (prefill) requestAnimationFrame(focusComposer);
  }, [prefill]);
  const prefilled = prefill && prefill.conversationId === current?.id ? prefill : null;

  // Always have a conversation to type into.
  // Start the connectors that were on last time.
  // "Open" on a scheduled run's toast.
  const openRun = useOpenRunRequest();
  useEffect(() => {
    if (openRun) tabs.openInNewTab(openRun.threadId);
  }, [openRun]);

  // Run automations that come due while the app is open, from one window only.
  useEffect(() => {
    void syncConnectors();
    whenLeader(startScheduler);
  }, []);

  // Alert as usage crosses the budget's thresholds.
  useEffect(() => watchBudget(providers ?? []), [providers]);

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
            onNewInProject={startInProject}
            mode={mode}
            onSwitchMode={(m) => void switchMode(m)}
            onDelete={deleteSession}
            onOpenSettings={() => openSettings({ section: "general" })}
            nav={nav}
            page={page}
            onOpenPage={setPage}
          />
          <SidebarInset className="min-w-0">
            <AppHeader
              workspaceId={page === "session" ? current?.workspaceId : undefined}
              nav={nav}
              session={page === "session" ? current : null}
              onToggleIncognito={toggleIncognito}
            >
              <SessionTabs
                open={tabs.open}
                conversations={conversations}
                activeId={page === "session" ? activeId : null}
                onSelect={setActiveId}
                onClose={tabs.close}
                onReorder={tabs.reorder}
                onDetach={tabs.detach}
                onNew={startNew}
                activeMenu={
                  page === "session" &&
                  current && <SessionMenu conversation={current} onOpen={tabs.openInNewTab} onDelete={deleteSession} />
                }
              />
            </AppHeader>
            <ErrorBoundary title="Something went wrong showing this" resetKey={`${page}:${activeId}`}>
              {page === "automations" && <AutomationsPage onOpenSession={setActiveId} />}
              {(page === "security" || page === "review") && <ReportsPage key={page} kind={page} onOpenSession={tabs.openInNewTab} />}
              {page === "wiki" && <WikiPage onOpenSession={tabs.openInNewTab} />}
              {page === "session" && current && (
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
            </ErrorBoundary>
          </SidebarInset>
        </SidebarProvider>
        <SessionDialogs />
        <SettingsDialog providers={providers ?? []} onProvidersChanged={() => void refresh()} />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </MotionConfig>
  );
}

/** Doubles as the window's title bar: drag it to move the window, double-click to maximize. */
/**
 * Holds the session tabs (`children`; the active one carries the session's actions), then
 * the incognito toggle, or for a Cowork session the folder chip and the side panel toggles.
 */
function AppHeader({
  workspaceId,
  nav,
  session,
  onToggleIncognito,
  children,
}: {
  workspaceId?: string;
  nav: Nav;
  session: Conversation | null;
  onToggleIncognito: () => void;
  children: ReactNode;
}) {
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
          <NavControls nav={nav} coworkStatus />
          <Separator orientation="vertical" className="mx-2 data-vertical:h-4 data-vertical:self-auto" />
        </>
      )}
      {children}
      <span data-tauri-drag-region className="min-w-8 flex-1 self-stretch" />
      {workspaceId ? (
        <>
          <WorkspaceChip workspaceId={workspaceId} />
          <PanelToggles />
        </>
      ) : (
        session && <IncognitoToggle active={!!session.incognito} onToggle={onToggleIncognito} />
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
