import { memo } from 'react';
import type { ConversationSummary, WorkspaceSummary } from '../../types/ui';
import { WorkspaceItem } from './WorkspaceItem';

interface WorkspaceSectionProps {
  workspaces: WorkspaceSummary[];
  isLoadingWorkspaces: boolean;
  selectedWorkspaceId: string;
  expandedWorkspaceIds: Record<string, boolean>;
  conversationsByWorkspace: Record<string, ConversationSummary[]>;
  hasMoreConversationsByWorkspace: Record<string, boolean>;
  selectedConversationId: string;
  sendingConversations: Record<string, boolean>;
  awaitingApprovalConversations: Record<string, boolean>;
  onToggleWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onSelectConversation: (conversationId: string, workspaceId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onLoadMoreConversations: (workspaceId: string) => void;
}

export const WorkspaceSection = memo(function WorkspaceSection({
  workspaces,
  isLoadingWorkspaces,
  selectedWorkspaceId,
  expandedWorkspaceIds,
  conversationsByWorkspace,
  hasMoreConversationsByWorkspace,
  selectedConversationId,
  sendingConversations,
  awaitingApprovalConversations,
  onToggleWorkspace,
  onDeleteWorkspace,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onLoadMoreConversations,
}: WorkspaceSectionProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-1">
      <header className="flex h-7 items-center bg-loop-800 px-2 text-xs font-medium text-loop-400">
        <span>Workspaces</span>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pt-1"
        style={{ overflowAnchor: 'none', scrollbarGutter: 'stable' }}
      >
        {workspaces.length === 0 && isLoadingWorkspaces && (
          <div className="px-3 py-2 text-[12px] text-loop-500">
            Loading workspaces...
          </div>
        )}
        {workspaces.map((workspace) => (
          <WorkspaceItem
            key={workspace.id}
            workspace={workspace}
            isSelected={workspace.id === selectedWorkspaceId}
            isExpanded={!!expandedWorkspaceIds[workspace.id]}
            conversations={conversationsByWorkspace[workspace.id] ?? []}
            hasMore={!!hasMoreConversationsByWorkspace[workspace.id]}
            selectedConversationId={selectedConversationId}
            sendingConversations={sendingConversations}
            awaitingApprovalConversations={awaitingApprovalConversations}
            onToggle={onToggleWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            onSelectConversation={(conversationId) => onSelectConversation(conversationId, workspace.id)}
            onDeleteConversation={onDeleteConversation}
            onRenameConversation={onRenameConversation}
            onLoadMore={() => onLoadMoreConversations(workspace.id)}
          />
        ))}
      </div>
    </section>
  );
});
