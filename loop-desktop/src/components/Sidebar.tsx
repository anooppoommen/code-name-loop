import { useEffect, useState } from 'react';
import type { ConversationSummary, WorkspaceSummary } from '../types/ui';
import { SidebarActions } from './sidebar/SidebarActions';
import { SidebarSettings } from './sidebar/SidebarSettings';
import { WorkspaceSection } from './sidebar/WorkspaceSection';

interface SidebarProps {
  backendUrl: string;
  onBackendUrlChange: (value: string) => void;
  onPickFolder: () => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  hideLifecycle: boolean;
  onHideLifecycleChange: (value: boolean) => void;
  showMascot: boolean;
  onShowMascotChange: (value: boolean) => void;
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  conversationsByWorkspace: Record<string, ConversationSummary[]>;
  selectedConversationId: string;
  sendingConversations: Record<string, boolean>;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
}

export function Sidebar({
  backendUrl,
  onBackendUrlChange,
  onPickFolder,
  onDeleteWorkspace,
  hideLifecycle,
  onHideLifecycleChange,
  showMascot,
  onShowMascotChange,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  conversationsByWorkspace,
  selectedConversationId,
  sendingConversations,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
}: SidebarProps) {
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!selectedWorkspaceId) {
      return;
    }
    setExpandedWorkspaceIds((prev) => (prev[selectedWorkspaceId] ? prev : { ...prev, [selectedWorkspaceId]: true }));
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setExpandedWorkspaceIds((prev) => {
      const next: Record<string, boolean> = {};
      for (const [workspaceId, isExpanded] of Object.entries(prev)) {
        if (validWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = isExpanded;
        }
      }
      return next;
    });
  }, [workspaces]);

  const toggleWorkspace = (workspaceId: string) => {
    let nextExpanded = false;
    setExpandedWorkspaceIds((prev) => {
      nextExpanded = !prev[workspaceId];
      return { ...prev, [workspaceId]: nextExpanded };
    });

    if (nextExpanded) {
      onSelectWorkspace(workspaceId);
    }
  };

  return (
    <aside className="no-drag select-none flex h-full min-h-0 w-[260px] flex-col gap-1.5 border-r border-loop-700 bg-loop-800 px-2.5 pb-2.5 pt-3 text-sm text-loop-300">
      <SidebarActions
        selectedWorkspaceId={selectedWorkspaceId}
        onNewConversation={onNewConversation}
        onPickFolder={onPickFolder}
      />

      <WorkspaceSection
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        expandedWorkspaceIds={expandedWorkspaceIds}
        conversationsByWorkspace={conversationsByWorkspace}
        selectedConversationId={selectedConversationId}
        sendingConversations={sendingConversations}
        onToggleWorkspace={toggleWorkspace}
        onDeleteWorkspace={onDeleteWorkspace}
        onSelectConversation={onSelectConversation}
        onDeleteConversation={onDeleteConversation}
        onRenameConversation={onRenameConversation}
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
