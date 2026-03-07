import type { ConversationSummary, WorkspaceSummary } from '../types/ui';
import { SidebarActions } from './sidebar/SidebarActions';
import { SidebarSettings } from './sidebar/SidebarSettings';
import { WorkspaceSection } from './sidebar/WorkspaceSection';

interface SidebarProps {
  backendUrl: string;
  onBackendUrlChange: (value: string) => void;
  onOpenCommandPalette: () => void;
  onPickFolder: () => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  hideLifecycle: boolean;
  onHideLifecycleChange: (value: boolean) => void;
  showMascot: boolean;
  onShowMascotChange: (value: boolean) => void;
  workspaces: WorkspaceSummary[];
  isLoadingWorkspaces: boolean;
  selectedWorkspaceId: string;
  expandedWorkspaceIds: Record<string, boolean>;
  onToggleWorkspace: (workspaceId: string) => void;
  conversationsByWorkspace: Record<string, ConversationSummary[]>;
  hasMoreConversationsByWorkspace: Record<string, boolean>;
  selectedConversationId: string;
  sendingConversations: Record<string, boolean>;
  awaitingApprovalConversations: Record<string, boolean>;
  onSelectConversation: (conversationId: string, workspaceId: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onLoadMoreConversations: (workspaceId: string) => void;
}

export function Sidebar({
  backendUrl,
  onBackendUrlChange,
  onOpenCommandPalette,
  onPickFolder,
  onDeleteWorkspace,
  hideLifecycle,
  onHideLifecycleChange,
  showMascot,
  onShowMascotChange,
  workspaces,
  isLoadingWorkspaces,
  selectedWorkspaceId,
  expandedWorkspaceIds,
  onToggleWorkspace,
  conversationsByWorkspace,
  hasMoreConversationsByWorkspace,
  selectedConversationId,
  sendingConversations,
  awaitingApprovalConversations,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
  onLoadMoreConversations,
}: SidebarProps) {
  return (
    <aside className="no-drag select-none flex h-full min-h-0 w-[260px] flex-col gap-1.5 border-r border-loop-700 bg-loop-800 px-2.5 pb-2.5 pt-3 text-sm text-loop-300">
      <SidebarActions
        selectedWorkspaceId={selectedWorkspaceId}
        onOpenCommandPalette={onOpenCommandPalette}
        onNewConversation={onNewConversation}
        onPickFolder={onPickFolder}
      />

      <WorkspaceSection
        workspaces={workspaces}
        isLoadingWorkspaces={isLoadingWorkspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        expandedWorkspaceIds={expandedWorkspaceIds}
        conversationsByWorkspace={conversationsByWorkspace}
        hasMoreConversationsByWorkspace={hasMoreConversationsByWorkspace}
        selectedConversationId={selectedConversationId}
        sendingConversations={sendingConversations}
        awaitingApprovalConversations={awaitingApprovalConversations}
        onToggleWorkspace={onToggleWorkspace}
        onDeleteWorkspace={onDeleteWorkspace}
        onSelectConversation={onSelectConversation}
        onDeleteConversation={onDeleteConversation}
        onRenameConversation={onRenameConversation}
        onLoadMoreConversations={onLoadMoreConversations}
      />

      <SidebarSettings
        backendUrl={backendUrl}
        onBackendUrlChange={onBackendUrlChange}
        hideLifecycle={hideLifecycle}
        onHideLifecycleChange={onHideLifecycleChange}
        showMascot={showMascot}
        onShowMascotChange={onShowMascotChange}
      />
    </aside>
  );
}
