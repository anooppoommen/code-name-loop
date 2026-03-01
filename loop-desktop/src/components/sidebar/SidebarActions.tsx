import { FolderPlus, MessageSquarePlus } from 'lucide-react';

interface SidebarActionsProps {
  selectedWorkspaceId: string;
  onNewConversation: () => void;
  onPickFolder: () => void;
}

export function SidebarActions({ selectedWorkspaceId, onNewConversation, onPickFolder }: SidebarActionsProps) {
  return (
    <nav className="flex flex-col gap-0 border-b border-loop-700/60 pb-1.5 pt-4">
      <button
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] font-medium text-loop-200 transition-colors hover:bg-loop-700 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        onClick={onNewConversation}
        disabled={!selectedWorkspaceId}
      >
        <MessageSquarePlus size={14} className="text-loop-400 group-hover:text-loop-200" />
        <span>New chat</span>
      </button>
      <button
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] font-medium text-loop-300 transition-colors hover:bg-loop-700 hover:text-loop-200"
        type="button"
        onClick={onPickFolder}
      >
        <FolderPlus size={14} className="text-loop-400 group-hover:text-loop-200" />
        <span>Open workspace</span>
      </button>
    </nav>
  );
}
