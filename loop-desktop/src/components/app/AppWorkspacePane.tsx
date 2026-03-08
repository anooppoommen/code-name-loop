import { memo, type ComponentProps } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AppHeader } from '../AppHeader';
import { ComposerEnvironmentBar } from '../ComposerEnvironmentBar';
import { Powerline } from '../Powerline';
import { WorkingRobotFlare } from '../activity-feed/WorkingRobotFlare';
import { AppConversationRegion } from './AppConversationRegion';
import { AppActivityPane } from './AppActivityPane';
import { NewThreadView } from '../NewThreadView';
import { AppComposerDock } from './AppComposerDock';

interface AppWorkspacePaneProps {
  workspaceName: string;
  conversationTitle: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  sshTunnelStatus: ComponentProps<typeof AppHeader>['sshTunnelStatus'];
  onOpenConnectionSettings: () => void;
  isProfiling: boolean;
  onToggleProfiling: () => void;
  isLoadingWorkspaces: boolean;
  workspaceCount: number;
  isSending: boolean;
  showMascot: boolean;
  selectedConversationId: string;
  activityPaneProps: ComponentProps<typeof AppActivityPane>;
  newThreadProps: ComponentProps<typeof NewThreadView>;
  composerDockProps: Omit<ComponentProps<typeof AppComposerDock>, 'conversationId' | 'environmentBarProps'>;
  environmentBarProps: ComponentProps<typeof ComposerEnvironmentBar>;
  powerlineProps: ComponentProps<typeof Powerline>;
}

export const AppWorkspacePane = memo(function AppWorkspacePane({
  workspaceName,
  conversationTitle,
  isSidebarOpen,
  onToggleSidebar,
  sshTunnelStatus,
  onOpenConnectionSettings,
  isProfiling,
  onToggleProfiling,
  isLoadingWorkspaces,
  workspaceCount,
  isSending,
  showMascot,
  selectedConversationId,
  activityPaneProps,
  newThreadProps,
  composerDockProps,
  environmentBarProps,
  powerlineProps,
}: AppWorkspacePaneProps) {
  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-[920px]:h-auto max-[920px]:overflow-visible">
      <AppHeader
        workspaceName={workspaceName}
        conversationTitle={conversationTitle}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={onToggleSidebar}
        sshTunnelStatus={sshTunnelStatus}
        onOpenConnectionSettings={onOpenConnectionSettings}
        isProfiling={isProfiling}
        onToggleProfiling={onToggleProfiling}
      />
      {isLoadingWorkspaces && workspaceCount === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-loop-500">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-loop-500/20 border-t-loop-500" />
            <p className="text-sm font-medium">Loading workspaces...</p>
          </div>
        </div>
      ) : (
        <>
          <AnimatePresence initial={false}>
            {isSending && showMascot ? (
              <motion.div
                key="working-robot-flare"
                initial={{ opacity: 0, y: 10, scale: 0.88 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.9 }}
                transition={{ duration: 0.34, ease: [0.645, 0.045, 0.355, 1] }}
                className="pointer-events-none absolute right-4 top-12 z-30"
              >
                <WorkingRobotFlare />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full w-full min-h-0 flex-col">
              <AppConversationRegion
                selectedConversationId={selectedConversationId}
                activityPaneProps={activityPaneProps}
                newThreadProps={newThreadProps}
              />

              <AppComposerDock
                {...composerDockProps}
                conversationId={selectedConversationId}
                environmentBarProps={environmentBarProps}
              />
            </div>
          </div>

          <Powerline {...powerlineProps} />
        </>
      )}
    </main>
  );
});
