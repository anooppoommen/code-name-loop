import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AppHeader } from './components/AppHeader';
import { ActivityFeed } from './components/ActivityFeed';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { ToastStack } from './components/ToastStack';
import { useLoopDesktop } from './hooks/useLoopDesktop';

const MOBILE_SIDEBAR_BREAKPOINT_PX = 920;

export default function App() {
  const app = useLoopDesktop();

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth > MOBILE_SIDEBAR_BREAKPOINT_PX;
    }
    return true;
  });

  // Navigation history (jumplist)
  const [, setHistoryState] = useState<{ list: string[]; index: number }>({ list: [], index: -1 });
  const isNavigatingRef = useRef(false);

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

  // Global keybindings for navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setHistoryState((prev) => {
          if (prev.index > 0) {
            isNavigatingRef.current = true;
            app.selectConversation(prev.list[prev.index - 1]);
            return { ...prev, index: prev.index - 1 };
          }
          return prev;
        });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setHistoryState((prev) => {
          if (prev.index < prev.list.length - 1) {
            isNavigatingRef.current = true;
            app.selectConversation(prev.list[prev.index + 1]);
            return { ...prev, index: prev.index + 1 };
          }
          return prev;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [app.selectConversation]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_SIDEBAR_BREAKPOINT_PX}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsSidebarOpen(!e.matches);
    };

    // Set initial state correctly
    setIsSidebarOpen(!mediaQuery.matches);

    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-neutral-900 text-neutral-200 selection:bg-blue-500/30">
      <ToastStack toasts={app.notices} onDismiss={app.dismissNotice} />

      <AnimatePresence initial={false}>
        {isSidebarOpen && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 260, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="h-full shrink-0 overflow-hidden border-r border-neutral-700 bg-neutral-800 max-[920px]:w-full max-[920px]:h-auto pt-10"
          >
            <Sidebar
              backendUrl={app.backendUrl}
              onBackendUrlChange={app.setBackendUrl}
              onPickFolder={() => void app.pickAndCreateWorkspace()}
              onDeleteWorkspace={(workspaceId) => {
                void app.deleteWorkspace(workspaceId);
              }}
              hideLifecycle={app.hideLifecycle}
              onHideLifecycleChange={app.setHideLifecycle}
              workspaces={app.workspaces}
              selectedWorkspaceId={app.selectedWorkspaceId}
              onSelectWorkspace={app.selectWorkspace}
              conversations={app.conversations}
              selectedConversationId={app.selectedConversationId}
              onSelectConversation={app.selectConversation}
              onNewConversation={() => void app.newConversation()}
              onDeleteConversation={(conversationId) => {
                void app.deleteConversation(conversationId);
              }}
              onRenameConversation={(conversationId, title) => {
                void app.renameConversation(conversationId, title);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-[920px]:h-auto max-[920px]:overflow-visible">
        <AppHeader
          workspaceName={app.selectedWorkspace?.name ?? 'No workspace selected'}
          conversationTitle={app.selectedConversation?.title ?? ''}
          isSending={app.isSending}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        />

        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full w-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ActivityFeed
                events={app.activities}
                conversationId={app.selectedConversationId}
                containerRef={app.feedScrollRef}
                canCompose={app.canCompose}
                isSending={app.isSending}
                onUseToolReply={app.applyToolResponseSuggestion}
                onSendToolReply={app.sendToolResponseSuggestion}
              />
            </div>

            <div className="mx-auto w-full max-w-[720px] shrink-0">
              <Composer
                messageInput={app.messageInput}
                onMessageInputChange={app.setMessageInput}
                isSending={app.isSending}
                canCompose={app.canCompose}
                thinkingLevel={app.thinkingLevel}
                onThinkingLevelChange={app.setThinkingLevel}
                onSubmit={app.sendMessage}
                onStop={app.cancelStream}
                onNewConversation={() => void app.newConversation()}
                conversationId={app.selectedConversationId}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
