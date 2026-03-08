import { AnimatePresence, motion } from 'framer-motion';
import { memo, useState } from 'react';
import { Folder, FolderOpen, Trash2 } from 'lucide-react';
import type { ConversationSummary, WorkspaceSummary } from '../../types/ui';
import { COLLAPSIBLE_SPRING } from '../activity-feed/ActivityMotion';
import { ThreadItem } from './ThreadItem';

interface WorkspaceItemProps {
  workspace: WorkspaceSummary;
  isSelected: boolean;
  isExpanded: boolean;
  conversations: ConversationSummary[];
  hasMore: boolean;
  selectedConversationId: string;
  sendingConversations: Record<string, boolean>;
  awaitingApprovalConversations: Record<string, boolean>;
  onToggle: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onLoadMore: () => void;
}

export const WorkspaceItem = memo(function WorkspaceItem({
  workspace,
  isSelected,
  isExpanded,
  conversations,
  hasMore,
  selectedConversationId,
  sendingConversations,
  awaitingApprovalConversations,
  onToggle,
  onDeleteWorkspace,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onLoadMore,
}: WorkspaceItemProps) {
  const [showAll, setShowAll] = useState(false);
  const CONVERSATION_LIMIT = 15;
  const hasMoreLocally = conversations.length > CONVERSATION_LIMIT;
  const visibleConversations = showAll ? conversations : conversations.slice(0, CONVERSATION_LIMIT);

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
            transition={COLLAPSIBLE_SPRING}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-0.5">
              {conversations.length === 0 ? (
                <p className="py-1 pl-8 text-[12px] text-loop-500">No threads</p>
              ) : (
                visibleConversations.map((conversation) => {
                  const isActive = conversation.id === selectedConversationId;
                  return (
                    <ThreadItem
                      key={conversation.id}
                      conversation={conversation}
                      isActive={isActive}
                      isWorking={!!sendingConversations[conversation.id]}
                      isAwaitingApproval={!!awaitingApprovalConversations[conversation.id]}
                      onSelect={() => onSelectConversation(conversation.id)}
                      onDelete={() => onDeleteConversation(conversation.id)}
                      onRename={(title) => onRenameConversation(conversation.id, title)}
                    />
                  );
                })
              )}
              {(hasMoreLocally || hasMore) && (
                !showAll ? (
                  <div className="relative mt-1 px-2">
                    <div className="absolute bottom-full left-0 right-0 h-10 bg-gradient-to-t from-loop-800 to-transparent pointer-events-none" />
                    <button
                      className="w-full text-center text-[11px] font-medium text-loop-400 hover:text-loop-200 hover:bg-loop-700 py-1.5 rounded-md transition-colors"
                      onClick={() => setShowAll(true)}
                    >
                      {hasMore ? "Show more" : `Show ${conversations.length - CONVERSATION_LIMIT} more`}
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 px-2">
                    {hasMore && (
                      <button
                        className="w-full text-center text-[11px] font-medium text-loop-400 hover:text-loop-200 hover:bg-loop-700 py-1.5 rounded-md transition-colors"
                        onClick={() => onLoadMore()}
                      >
                        Load older...
                      </button>
                    )}
                    <button
                      className="w-full text-center text-[11px] font-medium text-loop-400 hover:text-loop-200 hover:bg-loop-700 py-1.5 rounded-md transition-colors"
                      onClick={() => setShowAll(false)}
                    >
                      Show less
                    </button>
                  </div>
                )
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
