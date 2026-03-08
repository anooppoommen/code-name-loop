import { memo } from 'react';
import { FolderPlus, MessageSquarePlus, Search } from 'lucide-react';

interface SidebarActionsProps {
  selectedWorkspaceId: string;
  onNewConversation: () => void;
  onPickFolder: () => void;
  onOpenCommandPalette: () => void;
}

export const SidebarActions = memo(function SidebarActions({
  selectedWorkspaceId,
  onNewConversation,
  onPickFolder,
  onOpenCommandPalette,
}: SidebarActionsProps) {
  const shortcutClassName = 'ml-auto rounded bg-loop-700 px-1.5 py-0.5 text-[9px] leading-none text-loop-400';

  return (
    <nav className="flex flex-col gap-0 border-b border-loop-700/60 pb-1.5 pt-4">
      <button
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] font-medium text-loop-300 transition-colors hover:bg-loop-700 hover:text-loop-200"
        type="button"
        onClick={onOpenCommandPalette}
      >
        <Search size={14} className="text-loop-400 group-hover:text-loop-200" />
        <span>Search</span>
        <span className={shortcutClassName}>⌘ K</span>
      </button>
      <button
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] font-medium text-loop-200 transition-colors hover:bg-loop-700 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        onClick={onNewConversation}
        disabled={!selectedWorkspaceId}
      >
        <MessageSquarePlus size={14} className="text-loop-400 group-hover:text-loop-200" />
        <span>New chat</span>
        <span className={shortcutClassName}>⌘ N</span>
      </button>
      <button
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] font-medium text-loop-300 transition-colors hover:bg-loop-700 hover:text-loop-200"
        type="button"
        onClick={onPickFolder}
      >
        <FolderPlus size={14} className="text-loop-400 group-hover:text-loop-200" />
        <span>Open workspace</span>
        <span className={shortcutClassName}>⌘ ⇧ O</span>
      </button>
    </nav>
  );
});
