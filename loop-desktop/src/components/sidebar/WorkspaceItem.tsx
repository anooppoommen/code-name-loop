import { AnimatePresence, motion } from 'framer-motion';
import { Folder, FolderOpen, Trash2 } from 'lucide-react';
import type { ConversationSummary, WorkspaceSummary } from '../../types/ui';
import { ThreadItem } from './ThreadItem';

interface WorkspaceItemProps {
  workspace: WorkspaceSummary;
  isSelected: boolean;
  isExpanded: boolean;
  conversations: ConversationSummary[];
  selectedConversationId: string;
  sendingConversations: Record<string, boolean>;
  onToggle: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
}

export function WorkspaceItem({
  workspace,
  isSelected,
  isExpanded,
  conversations,
  selectedConversationId,
  sendingConversations,
  onToggle,
  onDeleteWorkspace,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
}: WorkspaceItemProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="group/ws relative">
        <button
          className={`flex min-h-[30px] w-full items-center justify-between rounded-lg px-2 py-1.5 pr-9 text-left text-[13px] transition-colors ${
            isSelected ? 'text-loop-200' : 'text-loop-300 hover:bg-loop-700'
          }`}
          onClick={() => onToggle(workspace.id)}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex h-[15px] w-[15px] shrink-0 items-center justify-center">
              {isExpanded ? <FolderOpen size={15} className="text-loop-400" /> : <Folder size={15} className="text-loop-400" />}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 pr-1">
              <span className="truncate leading-tight font-medium text-loop-200">{workspace.name}</span>
            </div>
          </div>
        </button>
        <button
          type="button"
          className="absolute right-1 top-[50%] -translate-y-[50%] rounded-md border border-transparent bg-loop-900/0 p-1.5 text-loop-500 opacity-0 transition-all hover:border-loop-700 hover:bg-loop-900/70 hover:text-red-400 focus-visible:opacity-100 group-hover/ws:opacity-100"
          onClick={() => onDeleteWorkspace(workspace.id)}
          title="Delete Workspace"
          aria-label="Delete workspace"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key={`${workspace.id}-threads`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-0.5">
              {conversations.length === 0 ? (
                <p className="py-1 pl-8 text-[12px] text-loop-500">No threads</p>
              ) : (
                conversations.map((conversation) => {
                  const isActive = conversation.id === selectedConversationId;
                  return (
                    <ThreadItem
                      key={conversation.id}
                      conversation={conversation}
                      isActive={isActive}
                      isWorking={!!sendingConversations[conversation.id]}
                      onSelect={() => onSelectConversation(conversation.id)}
                      onDelete={() => onDeleteConversation(conversation.id)}
                      onRename={(title) => onRenameConversation(conversation.id, title)}
                    />
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
