import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AppHeader } from './components/AppHeader';
import { ActivityFeed } from './components/ActivityFeed';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { ToastStack } from './components/ToastStack';
import { useLoopDesktop } from './hooks/useLoopDesktop';

export default function App() {
  const app = useLoopDesktop();

  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth > 1180;
    }
    return true;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1180px)');
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
            className="h-full shrink-0 overflow-hidden border-r border-neutral-700 bg-neutral-800 max-[1180px]:w-full max-[1180px]:h-auto pt-10"
          >
            <Sidebar
              backendUrl={app.backendUrl}
              onBackendUrlChange={app.setBackendUrl}
              onPickFolder={() => void app.pickAndCreateWorkspace()}
              onDeleteWorkspace={(workspaceId) => {
                void app.deleteWorkspace(workspaceId);
              }}
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

      <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-[1180px]:h-auto max-[1180px]:overflow-visible">
        <AppHeader
          workspaceName={app.selectedWorkspace?.name ?? 'No workspace selected'}
          conversationTitle={app.selectedConversation?.title ?? ''}
          isSending={app.isSending}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        />

        <div className="min-h-0 flex-1 overflow-hidden">
          <ActivityFeed
            events={app.activities}
            conversationId={app.selectedConversationId}
            containerRef={app.feedScrollRef}
          />
        </div>

        <div className="shrink-0">
          <Composer
            messageInput={app.messageInput}
            onMessageInputChange={app.setMessageInput}
            isSending={app.isSending}
            canCompose={app.canCompose}
            onSubmit={app.sendMessage}
            onStop={app.cancelStream}
          />
        </div>
      </main>
    </div>
  );
}
