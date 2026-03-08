import { useState, useEffect, useRef, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { ToastStack } from "./components/ToastStack";
import {
  useLoopDesktop,
} from "./hooks/useLoopDesktop";
import { KeyboardShortcut } from "./components/KeyboardShortcut";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { useGitStatus } from "./hooks/useGitStatus";
import { useReactScan } from "./hooks/useReactScan";
import { AppSidebarPane } from "./components/app/AppSidebarPane";
import { AppWorkspacePane } from "./components/app/AppWorkspacePane";
import { CommandApprovalSheet } from "./components/app/CommandApprovalSheet";
import {
  buildConversationWorktreeBranchName,
  resolveDraftBaseBranch,
} from "./utils/worktreeDraft";
import { submitDraftConversation } from "./utils/draftConversationSubmit";

const MOBILE_SIDEBAR_BREAKPOINT_PX = 920;
interface MemoryAwarePerformance extends Performance {
  memory?: {
    jsHeapSizeLimit: number;
    usedJSHeapSize: number;
  };
}

export default function App() {
  const app = useLoopDesktop();
  useReactScan(app.reactScanEnabled);
  const gitStatus = useGitStatus(app.backendUrl, app.selectedWorkspaceId, app.pushNotice);
  const applyToolReplyRef = useRef(app.applyToolResponseSuggestion);
  const sendToolReplyRef = useRef(app.sendToolResponseSuggestion);
  const retryMessageRef = useRef(app.retryFromMessage);
  const editMessageRef = useRef(app.editMessageInComposer);
  const pickAndCreateWorkspaceRef = useRef(app.pickAndCreateWorkspace);
  const deleteWorkspaceRef = useRef(app.deleteWorkspace);
  const selectWorkspaceRef = useRef(app.selectWorkspace);
  const selectConversationRef = useRef(app.selectConversation);
  const newConversationRef = useRef(app.newConversation);
  const deleteConversationRef = useRef(app.deleteConversation);
  const renameConversationRef = useRef(app.renameConversation);
  const loadMoreConversationsRef = useRef(app.loadMoreConversations);
  const selectedWorkspaceIdRef = useRef(app.selectedWorkspaceId);

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return window.innerWidth > MOBILE_SIDEBAR_BREAKPOINT_PX;
    }
    return true;
  });
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<
    Record<string, boolean>
  >({});
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [draftEnvMode, setDraftEnvMode] = useState<"local" | "worktree">("local");
  const [draftBaseBranch, setDraftBaseBranch] = useState("");
  const [isPreparingWorktree, setIsPreparingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // Navigation history (jumplist)
  const [, setHistoryState] = useState<{ list: string[]; index: number }>({
    list: [],
    index: -1,
  });
  const isNavigatingRef = useRef(false);

  const [isConnectionSettingsOpen, setIsConnectionSettingsOpen] =
    useState(false);

  const [isProfiling, setIsProfiling] = useState(false);
  const profilingLogsRef = useRef<string[]>([]);

  useEffect(() => {
    applyToolReplyRef.current = app.applyToolResponseSuggestion;
    sendToolReplyRef.current = app.sendToolResponseSuggestion;
    retryMessageRef.current = app.retryFromMessage;
    editMessageRef.current = app.editMessageInComposer;
    pickAndCreateWorkspaceRef.current = app.pickAndCreateWorkspace;
    deleteWorkspaceRef.current = app.deleteWorkspace;
    selectWorkspaceRef.current = app.selectWorkspace;
    selectConversationRef.current = app.selectConversation;
    newConversationRef.current = app.newConversation;
    deleteConversationRef.current = app.deleteConversation;
    renameConversationRef.current = app.renameConversation;
    loadMoreConversationsRef.current = app.loadMoreConversations;
    selectedWorkspaceIdRef.current = app.selectedWorkspaceId;
  }, [
    app.applyToolResponseSuggestion,
    app.deleteConversation,
    app.deleteWorkspace,
    app.editMessageInComposer,
    app.loadMoreConversations,
    app.newConversation,
    app.pickAndCreateWorkspace,
    app.renameConversation,
    app.retryFromMessage,
    app.selectConversation,
    app.selectedWorkspaceId,
    app.selectWorkspace,
    app.sendToolResponseSuggestion,
  ]);

  const handleUseToolReply = useCallback((text: string) => {
    applyToolReplyRef.current(text);
  }, []);

  const handleSendToolReply = useCallback((text: string) => {
    return sendToolReplyRef.current(text);
  }, []);

  const handleRetryMessage = useCallback((messageId: string) => {
    return retryMessageRef.current(messageId);
  }, []);

  const handleEditMessage = useCallback(
    (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => {
      editMessageRef.current(messageId, text, images);
    },
    [],
  );

  const handleOpenCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(true);
  }, []);

  const handlePickWorkspace = useCallback(() => {
    void pickAndCreateWorkspaceRef.current();
  }, []);

  const handleDeleteWorkspace = useCallback((workspaceId: string) => {
    void deleteWorkspaceRef.current(workspaceId);
  }, []);

  const handleSelectConversation = useCallback((conversationId: string, workspaceId: string) => {
    if (selectedWorkspaceIdRef.current !== workspaceId) {
      selectWorkspaceRef.current(workspaceId);
    }
    selectConversationRef.current(conversationId);
  }, []);

  const handleNewConversation = useCallback(() => {
    void newConversationRef.current();
  }, []);

  const handleDeleteConversation = useCallback((conversationId: string) => {
    void deleteConversationRef.current(conversationId);
  }, []);

  const handleRenameConversation = useCallback((conversationId: string, title: string) => {
    void renameConversationRef.current(conversationId, title);
  }, []);

  const handleLoadMoreConversations = useCallback((workspaceId: string) => {
    void loadMoreConversationsRef.current(workspaceId);
  }, []);

  // Track selected conversation history
  useEffect(() => {
    if (!app.selectedConversationId) return;
    if (isNavigatingRef.current) {
      isNavigatingRef.current = false;
      return;
    }
    setHistoryState((prev) => {
      const nextList = prev.list.slice(0, prev.index + 1);
      if (nextList[nextList.length - 1] === app.selectedConversationId) {
        return prev;
      }
      nextList.push(app.selectedConversationId);
      return { list: nextList, index: nextList.length - 1 };
    });
  }, [app.selectedConversationId]);

  useEffect(() => {
    if (!app.selectedWorkspaceId) {
      return;
    }
    setExpandedWorkspaceIds((prev) =>
      Object.prototype.hasOwnProperty.call(prev, app.selectedWorkspaceId)
        ? prev
        : { ...prev, [app.selectedWorkspaceId]: true },
    );
  }, [app.selectedWorkspaceId]);

  useEffect(() => {
    const validWorkspaceIds = new Set(
      app.workspaces.map((workspace) => workspace.id),
    );
    setExpandedWorkspaceIds((prev) => {
      const next: Record<string, boolean> = {};
      for (const [workspaceId, isExpanded] of Object.entries(prev)) {
        if (validWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = isExpanded;
        }
      }
      return next;
    });
  }, [app.workspaces]);

  useEffect(() => {
    setDraftBaseBranch((current) =>
      resolveDraftBaseBranch(current, gitStatus.status),
    );
  }, [app.selectedWorkspaceId, gitStatus.status]);

  useEffect(() => {
    if (!gitStatus.status?.isInitialized || !gitStatus.status.hasCommits) {
      setDraftEnvMode("local");
    }
  }, [gitStatus.status]);

  useEffect(() => {
    setWorktreeError(null);
    if (app.selectedConversationId) {
      setDraftEnvMode("local");
    }
  }, [app.selectedConversationId, app.selectedWorkspaceId]);

  const appShortcutHandler = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!(event.ctrlKey || event.metaKey)) {
        return false;
      }
      const key = event.key.toLowerCase();
      if (key === "o" && event.shiftKey) {
        void app.pickAndCreateWorkspace();
        return true;
      }
      if (key === "n") {
        void app.newConversation();
        return true;
      }
      if (key === "k") {
        setIsCommandPaletteOpen((prev) => !prev);
        return true;
      }
      if (key === "b") {
        setIsSidebarOpen((prev) => !prev);
        return true;
      }
      if (key === "o") {
        setHistoryState((prev) => {
          // If currently in an untracked state (e.g., new thread ''), return to the top of the history
          if (
            !app.selectedConversationId &&
            prev.list.length > 0 &&
            prev.index >= 0
          ) {
            isNavigatingRef.current = true;
            app.selectConversation(prev.list[prev.index]);
            return prev;
          }
          if (prev.index > 0) {
            isNavigatingRef.current = true;
            app.selectConversation(prev.list[prev.index - 1]);
            return { ...prev, index: prev.index - 1 };
          }
          return prev;
        });
        return true;
      }
      if (key === "i") {
        setHistoryState((prev) => {
          if (prev.index < prev.list.length - 1) {
            isNavigatingRef.current = true;
            app.selectConversation(prev.list[prev.index + 1]);
            return { ...prev, index: prev.index + 1 };
          }
          return prev;
        });
        return true;
      }
      if (key === "w" && event.shiftKey) {
        if (
          !app.selectedConversationId &&
          gitStatus.status?.isInitialized &&
          gitStatus.status.hasCommits
        ) {
          setDraftEnvMode((prev) => (prev === "local" ? "worktree" : "local"));
        }
        return true;
      }
      return false;
    },
    [app, gitStatus.status],
  );

  const handleComposerSubmit = async () => {
    setWorktreeError(null);
    if (!app.selectedConversationId && draftEnvMode === "worktree") {
      setIsPreparingWorktree(true);
      try {
        const result = await submitDraftConversation({
          selectedConversationId: app.selectedConversationId,
          draftEnvMode,
          draftBaseBranch,
          currentBranch: gitStatus.status?.branch || "",
          createWorktree: gitStatus.createWorktree,
          sendMessage: app.sendMessage,
          makeBranchName: buildConversationWorktreeBranchName,
        });
        if (!result.ok) {
          setWorktreeError(result.error);
        }
        return;
      } catch (e) {
        console.error(e);
        setWorktreeError(
          e instanceof Error ? e.message : "Failed to prepare worktree.",
        );
        return;
      } finally {
        setIsPreparingWorktree(false);
      }
    }
    await app.sendMessage();
  };

  const startConversationFromPalette = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!workspaceId) {
        return;
      }
      if (workspaceId !== app.selectedWorkspaceId) {
        app.selectWorkspace(workspaceId);
      }
      await app.newConversation();
      if (window.innerWidth <= MOBILE_SIDEBAR_BREAKPOINT_PX) {
        setIsSidebarOpen(false);
      }
    },
    [app],
  );

  const openConversationFromPalette = useCallback(
    async (workspaceId: string, conversationId: string): Promise<void> => {
      if (!workspaceId || !conversationId) {
        return;
      }
      if (workspaceId !== app.selectedWorkspaceId) {
        app.selectWorkspace(workspaceId);
      }
      app.selectConversation(conversationId);
      if (window.innerWidth <= MOBILE_SIDEBAR_BREAKPOINT_PX) {
        setIsSidebarOpen(false);
      }
    },
    [app],
  );

  const toggleWorkspace = useCallback((workspaceId: string) => {
    setExpandedWorkspaceIds((prev) => ({
      ...prev,
      [workspaceId]: !prev[workspaceId],
    }));
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(
      `(max-width: ${MOBILE_SIDEBAR_BREAKPOINT_PX}px)`,
    );
    const onChange = (e: MediaQueryListEvent) => {
      setIsSidebarOpen(!e.matches);
    };

    // Set initial state correctly
    setIsSidebarOpen(!mediaQuery.matches);

    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  // Setup PerformanceObserver for long tasks when profiling
  useEffect(() => {
    if (!isProfiling) return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          profilingLogsRef.current.push(
            `[${new Date().toISOString()}] ⚠️ LONG TASK DETECTED\n` +
            `  ├─ Duration:   ${entry.duration.toFixed(2)}ms\n` +
            `  ├─ Name:       ${entry.name}\n` +
            `  └─ Start Time: ${entry.startTime.toFixed(2)}ms`,
          );
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Fallback if longtask is not supported
    }
    return () => observer?.disconnect();
  }, [isProfiling]);

  const onRenderCallback = useCallback(
    (
      id: string,
      phase: "mount" | "update" | "nested-update",
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number,
    ) => {
      if (!isProfiling) return;
      const mem = (performance as MemoryAwarePerformance).memory;
      const memoryStr = mem
        ? `\n  ├─ Heap Limit:   ${Math.round(mem.jsHeapSizeLimit / 1048576)}MB (Used: ${Math.round(mem.usedJSHeapSize / 1048576)}MB)`
        : "";
      const log =
        `[${new Date().toISOString()}] ⚛️ ${id} [${phase.toUpperCase()}]\n` +
        `  ├─ Actual Time:  ${actualDuration.toFixed(2)}ms\n` +
        `  ├─ Base Time:    ${baseDuration.toFixed(2)}ms\n` +
        `  ├─ Commit Time:  ${(commitTime - startTime).toFixed(2)}ms (Start: ${startTime.toFixed(1)}, Commit: ${commitTime.toFixed(1)})${memoryStr}\n` +
        `  └─ App Context:  conversationId=${app.selectedConversationId || "none"}, isSending=${app.isSending}, status=${app.currentStatus}`;
      profilingLogsRef.current.push(log);
    },
    [isProfiling, app.selectedConversationId, app.isSending, app.currentStatus],
  );

  const toggleProfiling = useCallback(() => {
    if (isProfiling) {
      setIsProfiling(false);
      let content = profilingLogsRef.current.join("\n");
      if (!content)
        content = "No render events captured during profiling session.\n";

      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `activity-feed-profile-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      profilingLogsRef.current = [];
    } else {
      profilingLogsRef.current = [
        `--- Profiling Started at ${new Date().toISOString()} ---`,
      ];
      setIsProfiling(true);
    }
  }, [isProfiling]);

  return (
    <KeyboardShortcut priority={0} enabled onKeyDown={appShortcutHandler}>
      <div className="flex h-full w-full overflow-hidden bg-loop-900 text-loop-200 selection:bg-blue-500/30">
        <ToastStack toasts={app.notices} onDismiss={app.dismissNotice} />
        <CommandPalette
          open={isCommandPaletteOpen}
          backendUrl={app.backendUrl}
          workspaces={app.workspaces}
          selectedWorkspaceId={app.selectedWorkspaceId}
          onClose={() => setIsCommandPaletteOpen(false)}
          onStartNewConversation={startConversationFromPalette}
          onOpenConversation={openConversationFromPalette}
        />
        <AnimatePresence>
          {isConnectionSettingsOpen && (
            <ConnectionSettings
              onClose={() => setIsConnectionSettingsOpen(false)}
              sshTunnelConfig={app.sshTunnelConfig}
              setSshTunnelConfig={app.setSshTunnelConfig}
              sshTunnelStatus={app.sshTunnelStatus}
              sshTunnelError={app.sshTunnelError}
              connectTunnel={app.connectTunnel}
              disconnectTunnel={app.disconnectTunnel}
            />
          )}
        </AnimatePresence>

        <AppSidebarPane
          isSidebarOpen={isSidebarOpen}
          backendUrl={app.backendUrl}
          onBackendUrlChange={app.setBackendUrl}
          onOpenCommandPalette={handleOpenCommandPalette}
          onPickFolder={handlePickWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          hideLifecycle={app.hideLifecycle}
          onHideLifecycleChange={app.setHideLifecycle}
          showMascot={app.showMascot}
          onShowMascotChange={app.setShowMascot}
          reactScanEnabled={app.reactScanEnabled}
          onReactScanEnabledChange={app.setReactScanEnabled}
          workspaces={app.workspaces}
          isLoadingWorkspaces={app.isLoadingWorkspaces}
          selectedWorkspaceId={app.selectedWorkspaceId}
          expandedWorkspaceIds={expandedWorkspaceIds}
          onToggleWorkspace={toggleWorkspace}
          conversationsByWorkspace={app.conversationsByWorkspace}
          hasMoreConversationsByWorkspace={app.hasMoreConversationsByWorkspace}
          selectedConversationId={app.selectedConversationId}
          sendingConversations={app.sendingConversations}
          awaitingApprovalConversations={app.awaitingApprovalConversations}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          onLoadMoreConversations={handleLoadMoreConversations}
        />

        <AppWorkspacePane
          workspaceName={app.selectedWorkspace?.name ?? "No workspace selected"}
          conversationTitle={app.selectedConversation?.title ?? ""}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
          sshTunnelStatus={app.sshTunnelStatus}
          onOpenConnectionSettings={() => setIsConnectionSettingsOpen(true)}
          isProfiling={isProfiling}
          onToggleProfiling={toggleProfiling}
          isLoadingWorkspaces={app.isLoadingWorkspaces}
          workspaceCount={app.workspaces.length}
          isSending={app.isSending}
          showMascot={app.showMascot}
          selectedConversationId={app.selectedConversationId}
          activityPaneProps={{
            conversationId: app.selectedConversationId,
            containerRef: app.feedScrollRef,
            currentStatus: app.currentStatus,
            hideLifecycle: app.hideLifecycle,
            isLoadingHistory: app.isLoadingSelectedConversation,
            applyPatchToWorkspace: app.applyPatchToWorkspace,
            canCompose: app.canCompose,
            isSending: app.isSending,
            onUseToolReply: handleUseToolReply,
            onSendToolReply: handleSendToolReply,
            onRetryMessage: handleRetryMessage,
            onEditMessage: handleEditMessage,
            onRenderCallback,
          }}
          newThreadProps={{
            workspaceName: app.selectedWorkspace?.name ?? "No workspace selected",
            currentBranch: gitStatus.status?.branch || "main",
            draftBaseBranch,
            draftEnvMode,
            canCreateWorktree: Boolean(
              gitStatus.status?.isInitialized && gitStatus.status.hasCommits,
            ),
          }}
          composerDockProps={{
            approvalSheet: app.pendingCommandApproval ? (
              <CommandApprovalSheet
                approval={app.pendingCommandApproval}
                pendingCount={app.pendingCommandApprovalCount}
                isResolving={app.isResolvingCommandApproval}
                onResolve={(decision, message) => {
                  void app.resolveCommandApproval(decision, message);
                }}
              />
            ) : null,
            onSteerQueuedMessage: app.steerQueuedMessage,
            composerProps: {
              isSending: app.isSending,
              canCompose: app.canCompose,
              thinkingLevel: app.thinkingLevel,
              onThinkingLevelChange: app.setThinkingLevel,
              composerModel: app.composerModel,
              onComposerModelChange: app.setComposerModel,
              onSubmit: handleComposerSubmit,
              onStop: app.cancelStream,
            },
          }}
          environmentBarProps={{
            gitStatus,
            selectedConversationId: app.selectedConversationId,
            selectedConversation: app.selectedConversation,
            draftEnvMode,
            onDraftEnvModeChange: setDraftEnvMode,
            draftBaseBranch,
            onDraftBaseBranchChange: setDraftBaseBranch,
            isPreparingWorktree,
            worktreeError,
          }}
          powerlineProps={{
            backendUrl: app.backendUrl,
            workspaceId: app.selectedWorkspaceId,
            conversationId: app.selectedConversationId,
          }}
        />
      </div>
    </KeyboardShortcut>
  );
}
