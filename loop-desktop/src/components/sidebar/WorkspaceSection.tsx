import type { ConversationSummary, WorkspaceSummary } from '../../types/ui';
import { WorkspaceItem } from './WorkspaceItem';

interface WorkspaceSectionProps {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  expandedWorkspaceIds: Record<string, boolean>;
  conversationsByWorkspace: Record<string, ConversationSummary[]>;
  hasMoreConversationsByWorkspace: Record<string, boolean>;
  selectedConversationId: string;
  sendingConversations: Record<string, boolean>;
  awaitingApprovalConversations: Record<string, boolean>;
  onToggleWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onLoadMoreConversations: (workspaceId: string) => void;
}

export function WorkspaceSection({
  workspaces,
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
            onSelectConversation={onSelectConversation}
            onDeleteConversation={onDeleteConversation}
            onRenameConversation={onRenameConversation}
            onLoadMore={() => onLoadMoreConversations(workspace.id)}
          />
        ))}
      </div>
    </section>
  );
}
