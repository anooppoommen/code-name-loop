import { useState, useEffect, useRef, useCallback, Profiler } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AppHeader } from "./components/AppHeader";
import { ActivityFeed } from "./components/ActivityFeed";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { ToastStack } from "./components/ToastStack";
import {
  useLoopDesktop,
  type CommandApprovalDecision,
  type PendingCommandApproval,
} from "./hooks/useLoopDesktop";
import { KeyboardShortcut } from "./components/KeyboardShortcut";
import { QueuedMessages } from "./components/QueuedMessages";
import { Powerline } from "./components/Powerline";
import { WorkingRobotFlare } from "./components/activity-feed/WorkingRobotFlare";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { useGitStatus } from "./hooks/useGitStatus";

const MOBILE_SIDEBAR_BREAKPOINT_PX = 920;
const COMMAND_APPROVAL_OPTIONS: Array<{
  decision: CommandApprovalDecision;
  label: string;
  keyHint: string;
}> = [
    { decision: "deny", label: "Deny", keyHint: "1" },
    { decision: "allow_once", label: "Allow once", keyHint: "2" },
    { decision: "allow_session", label: "Allow in session", keyHint: "3" },
  ];

interface MemoryAwarePerformance extends Performance {
  memory?: {
    jsHeapSizeLimit: number;
    usedJSHeapSize: number;
  };
}

export default function App() {
  const app = useLoopDesktop();

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

  const gitStatus = useGitStatus(app.backendUrl, app.selectedWorkspaceId);

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
      return false;
    },
    [app],
  );

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

        <AnimatePresence initial={false}>
          {isSidebarOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 260, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
              className="h-full shrink-0 overflow-hidden border-r border-loop-700 bg-loop-800 max-[920px]:w-full max-[920px]:h-auto pt-7"
            >
              <Sidebar
                backendUrl={app.backendUrl}
                onBackendUrlChange={app.setBackendUrl}
                onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
                onPickFolder={() => void app.pickAndCreateWorkspace()}
                onDeleteWorkspace={(workspaceId) => {
                  void app.deleteWorkspace(workspaceId);
                }}
                hideLifecycle={app.hideLifecycle}
                onHideLifecycleChange={app.setHideLifecycle}
                showMascot={app.showMascot}
                onShowMascotChange={app.setShowMascot}
                workspaces={app.workspaces}
                isLoadingWorkspaces={app.isLoadingWorkspaces}
                selectedWorkspaceId={app.selectedWorkspaceId}
                expandedWorkspaceIds={expandedWorkspaceIds}
                onToggleWorkspace={toggleWorkspace}
                conversationsByWorkspace={app.conversationsByWorkspace}
                hasMoreConversationsByWorkspace={
                  app.hasMoreConversationsByWorkspace
                }
                selectedConversationId={app.selectedConversationId}
                sendingConversations={app.sendingConversations}
                awaitingApprovalConversations={
                  app.awaitingApprovalConversations
                }
                onSelectConversation={(conversationId, workspaceId) => {
                  if (app.selectedWorkspaceId !== workspaceId) {
                    app.selectWorkspace(workspaceId);
                  }
                  app.selectConversation(conversationId);
                }}
                onNewConversation={() => void app.newConversation()}
                onDeleteConversation={(conversationId) => {
                  void app.deleteConversation(conversationId);
                }}
                onRenameConversation={(conversationId, title) => {
                  void app.renameConversation(conversationId, title);
                }}
                onLoadMoreConversations={(workspaceId) => {
                  void app.loadMoreConversations(workspaceId);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-[920px]:h-auto max-[920px]:overflow-visible">
          <AppHeader
            workspaceName={
              app.selectedWorkspace?.name ?? "No workspace selected"
            }
            conversationTitle={app.selectedConversation?.title ?? ""}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
            sshTunnelStatus={app.sshTunnelStatus}
            onOpenConnectionSettings={() => setIsConnectionSettingsOpen(true)}
            isProfiling={isProfiling}
            onToggleProfiling={toggleProfiling}
          />
          {app.isLoadingWorkspaces && app.workspaces.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-4 text-loop-500">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-loop-500/20 border-t-loop-500" />
                <p className="text-sm font-medium">Loading workspaces...</p>
              </div>
            </div>
          ) : (
            <>
              <AnimatePresence initial={false}>
                {app.isSending && app.showMascot ? (
                  <motion.div
                    key="working-robot-flare"
                    initial={{ opacity: 0, y: 10, scale: 0.88 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.9 }}
                    transition={{
                      duration: 0.34,
                      ease: [0.645, 0.045, 0.355, 1],
                    }}
                    className="pointer-events-none absolute right-4 top-12 z-30"
                  >
                    <WorkingRobotFlare />
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <div className="min-h-0 flex-1 overflow-hidden">
                <div className="flex h-full w-full min-h-0 flex-col">
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <Profiler id="ActivityFeed" onRender={onRenderCallback}>
                      <ActivityFeed
                        conversationId={app.selectedConversationId}
                        containerRef={app.feedScrollRef}
                        currentStatus={app.currentStatus}
                        hideLifecycle={app.hideLifecycle}
                        isLoadingHistory={app.isLoadingSelectedConversation}
                        applyPatchToWorkspace={app.applyPatchToWorkspace}
                        canCompose={app.canCompose}
                        isSending={app.isSending}
                        onUseToolReply={app.applyToolResponseSuggestion}
                        onSendToolReply={app.sendToolResponseSuggestion}
                        onRetryMessage={app.retryFromMessage}
                        onEditMessage={app.editMessageInComposer}
                      />
                    </Profiler>
                  </div>

                  <div className="relative mx-auto w-full max-w-[720px] shrink-0">
                    <QueuedMessages
                      messages={app.queuedMessages}
                      onReorder={app.reorderQueuedMessage}
                      onRemove={app.removeQueuedMessage}
                      onSteer={app.steerQueuedMessage}
                    />
                    <div className="relative z-10">
                      <AnimatePresence initial={false} mode="wait">
                        {app.pendingCommandApproval ? (
                          <CommandApprovalSheet
                            approval={app.pendingCommandApproval}
                            pendingCount={app.pendingCommandApprovalCount}
                            isResolving={app.isResolvingCommandApproval}
                            onResolve={(decision, message) =>
                              void app.resolveCommandApproval(decision, message)
                            }
                          />
                        ) : null}
                      </AnimatePresence>
                      <div className="relative z-20">
                        <Composer
                          messageInput={app.messageInput}
                          onMessageInputChange={app.setMessageInput}
                          isSending={app.isSending}
                          canCompose={app.canCompose}
                          thinkingLevel={app.thinkingLevel}
                          onThinkingLevelChange={app.setThinkingLevel}
                          composerModel={app.composerModel}
                          onComposerModelChange={app.setComposerModel}
                          onSubmit={app.sendMessage}
                          onStop={app.cancelStream}
                          onQueue={app.queueMessage}
                          conversationId={app.selectedConversationId}
                          composerImages={app.composerImages}
                          setComposerImages={app.setComposerImages}
                        />
                        <div className="mt-3 mb-4 px-4 flex items-center justify-end text-[12px] text-loop-400">
                          <div className="flex items-center gap-1.5">
                            {gitStatus.status ? (
                              gitStatus.status.isInitialized ? (
                                <GitBranchDropdown gitStatus={gitStatus} />
                              ) : (
                                <button
                                  onClick={() => void gitStatus.initGit()}
                                  className="flex items-center gap-1.5 transition-colors group text-white/70 hover:text-white mr-1"
                                >
                                  <span className="border-b border-dotted border-white/40 group-hover:border-white/80 pb-[1px] leading-none transition-colors">
                                    Initialize Git
                                  </span>
                                  <svg
                                    className="h-3.5 w-3.5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      d="M12 4v16m8-8H4"
                                    />
                                  </svg>
                                </button>
                              )
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <Powerline
                backendUrl={app.backendUrl}
                workspaceId={app.selectedWorkspaceId}
                conversationId={app.selectedConversationId}
              />
            </>
          )}
        </main>
      </div>
    </KeyboardShortcut>
  );
}

function GitBranchDropdown({ gitStatus }: { gitStatus: any }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
      return;
    }
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    // Focus input on open
    setTimeout(() => inputRef.current?.focus(), 50);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  if (!gitStatus.status) return null;

  const currentBranch = gitStatus.status.branch || "main";
  const branches = gitStatus.status.branches || [];

  const filteredBranches = branches.filter((b: string) =>
    b.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const exactMatch = branches.some(
    (b: string) => b.toLowerCase() === searchQuery.toLowerCase(),
  );
  const showCreateOption = searchQuery.trim() !== "" && !exactMatch;

  const handleSelect = async (branch: string, create = false) => {
    if (branch === currentBranch && !create) {
      setIsOpen(false);
      return;
    }
    await gitStatus.checkoutBranch(branch, create);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 transition-colors group text-white/70 hover:text-white mr-1 text-[12px]"
      >
        <span className="font-mono border-b border-dotted border-white/40 group-hover:border-white/80 pb-[1px] leading-none transition-colors">
          {currentBranch}
        </span>
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 bottom-full mb-2 w-56 rounded-xl border border-loop-700 bg-loop-900 p-1.5 shadow-xl shadow-black/50 z-50 flex flex-col"
          >
            <div className="px-1.5 py-1">
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Find or create a branch..."
                className="w-full bg-loop-950 border border-loop-800 rounded px-2 py-1 text-[11px] text-loop-200 placeholder-loop-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
              />
            </div>

            <div className="mt-1 flex-1 overflow-y-auto max-h-48 scrollbar-thin scrollbar-thumb-loop-700 scrollbar-track-transparent">
              {showCreateOption && (
                <button
                  onClick={() => handleSelect(searchQuery.trim(), true)}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-loop-200 hover:bg-blue-500/15 hover:text-blue-200 group"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">Create branch</span>
                    <span className="truncate font-mono text-loop-400 group-hover:text-blue-300">
                      {searchQuery.trim()}
                    </span>
                  </div>
                  <svg
                    className="h-3 w-3 shrink-0 text-loop-500 group-hover:text-blue-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}

              {filteredBranches.length > 0 && showCreateOption && (
                <div className="h-px bg-loop-800 my-1 mx-1" />
              )}

              {filteredBranches.map((branch) => {
                const isActive = branch === currentBranch;
                return (
                  <button
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] hover:bg-loop-800 transition-colors ${isActive
                      ? "text-blue-300 bg-blue-500/10"
                      : "text-loop-200"
                      }`}
                  >
                    <span className="font-mono truncate">{branch}</span>
                    {isActive && (
                      <svg
                        className="h-3 w-3 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })}

              {filteredBranches.length === 0 && !showCreateOption && (
                <div className="px-2 py-3 text-center text-[11px] text-loop-500">
                  No branches found
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CommandApprovalSheet({
  approval,
  pendingCount,
  isResolving,
  onResolve,
}: {
  approval: PendingCommandApproval;
  pendingCount: number;
  isResolving: boolean;
  onResolve: (decision: CommandApprovalDecision, message?: string) => void;
}) {
  const [activeOptionIndex, setActiveOptionIndex] = useState(1);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setActiveOptionIndex(1);
  }, [approval.id]);

  useEffect(() => {
    const activeButton = optionRefs.current[activeOptionIndex];
    if (activeButton) {
      activeButton.focus({ preventScroll: true });
    }
  }, [activeOptionIndex, approval.id]);

  const moveSelection = useCallback((direction: 1 | -1) => {
    setActiveOptionIndex(
      (current) =>
        (current + direction + COMMAND_APPROVAL_OPTIONS.length) %
        COMMAND_APPROVAL_OPTIONS.length,
    );
  }, []);

  const resolveDecision = useCallback(
    (decision: CommandApprovalDecision) => {
      onResolve(decision);
    },
    [onResolve],
  );

  const onArrowDown = useCallback((): boolean => {
    moveSelection(1);
    return true;
  }, [moveSelection]);

  const onArrowUp = useCallback((): boolean => {
    moveSelection(-1);
    return true;
  }, [moveSelection]);

  const onArrowRight = useCallback((): boolean => {
    moveSelection(1);
    return true;
  }, [moveSelection]);

  const onArrowLeft = useCallback((): boolean => {
    moveSelection(-1);
    return true;
  }, [moveSelection]);

  const onDigit1 = useCallback((): boolean => {
    setActiveOptionIndex(0);
    return true;
  }, []);

  const onDigit2 = useCallback((): boolean => {
    if (COMMAND_APPROVAL_OPTIONS.length < 2) {
      return false;
    }
    setActiveOptionIndex(1);
    return true;
  }, []);

  const onDigit3 = useCallback((): boolean => {
    if (COMMAND_APPROVAL_OPTIONS.length < 3) {
      return false;
    }
    setActiveOptionIndex(2);
    return true;
  }, []);

  const onEnter = useCallback((): boolean => {
    const selected = COMMAND_APPROVAL_OPTIONS[activeOptionIndex];
    if (!selected) {
      return false;
    }
    resolveDecision(selected.decision);
    return true;
  }, [activeOptionIndex, resolveDecision]);

  return (
    <KeyboardShortcut
      priority={200}
      enabled={!isResolving}
      onArrowDown={onArrowDown}
      onArrowRight={onArrowRight}
      onArrowUp={onArrowUp}
      onArrowLeft={onArrowLeft}
      onDigit1={onDigit1}
      onDigit2={onDigit2}
      onDigit3={onDigit3}
      onEnter={onEnter}
    >
      <motion.div
        initial={{ opacity: 0, y: 26, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.985 }}
        transition={{ duration: 0.22, ease: "easeInOut" }}
        className="pointer-events-none absolute inset-x-0 bottom-[calc(100%-24px)] z-10"
      >
        <div className="pointer-events-auto px-4">
          <div className="rounded-xl border border-loop-800/50 bg-loop-800 p-2 shadow-lg shadow-black/55">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[12px] text-loop-300">
                  <span className="font-mono text-loop-200">
                    {approval.toolName}
                  </span>{" "}
                  wants to{" "}
                  {[
                    "read_file",
                    "list_dir",
                    "grep_files",
                    "apply_patch",
                  ].includes(approval.toolName)
                    ? "access a path outside of the workspace directory"
                    : "run"}
                  :
                </div>
                <div className="group relative min-w-0">
                  <pre className="m-0 overflow-x-hidden text-ellipsis whitespace-nowrap pb-0.5 font-mono text-[13px] leading-relaxed text-loop-100 scrollbar-hidden group-hover:overflow-x-auto group-hover:text-clip">
                    <span className="pr-6">{approval.command}</span>
                  </pre>
                  <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-8 bg-gradient-to-l from-loop-900 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              </div>
              {pendingCount > 1 ? (
                <span className="shrink-0 rounded border border-loop-700 bg-loop-950 px-1.5 py-0.5 text-[10px] text-loop-300">
                  {pendingCount} pending
                </span>
              ) : null}
            </div>
            {approval.workdir ? (
              <p className="mt-1 text-[10px] text-loop-500">
                in{" "}
                <span className="font-mono text-loop-400">
                  {approval.workdir}
                </span>
              </p>
            ) : null}
            <div
              className="mt-2 flex flex-col gap-1 pb-6"
              role="radiogroup"
              aria-label="Command approval options"
            >
              {COMMAND_APPROVAL_OPTIONS.map((option, index) => {
                const isActive = index === activeOptionIndex;
                return (
                  <div
                    key={option.decision}
                    className="flex items-center gap-1"
                  >
                    <button
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      tabIndex={isActive ? 0 : -1}
                      disabled={isResolving}
                      className={`flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-loop-800 disabled:cursor-not-allowed disabled:opacity-60 ${isActive ? "text-loop-100 bg-loop-700" : ""
                        }`}
                      onFocus={() => setActiveOptionIndex(index)}
                      onClick={() => resolveDecision(option.decision)}
                    >
                      <span>{option.label}</span>
                      <span className="rounded bg-loop-600 px-1 py-0.5 text-[10px] text-loop-200">
                        {option.keyHint}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </motion.div>
    </KeyboardShortcut>
  );
}
