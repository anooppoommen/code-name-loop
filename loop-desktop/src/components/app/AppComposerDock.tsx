import { memo, useCallback, type ComponentProps, type ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Composer } from '../Composer';
import { ComposerEnvironmentBar } from '../ComposerEnvironmentBar';
import { QueuedMessages } from '../QueuedMessages';
import { useComposerDraftStore } from '../../stores/composerDraftStore';

const EMPTY_MESSAGES: ComponentProps<typeof QueuedMessages>['messages'] = [];

interface AppComposerDockProps {
  conversationId: string;
  approvalSheet: ReactNode;
  onSteerQueuedMessage: (id: string) => Promise<void>;
  composerProps: Omit<
    ComponentProps<typeof Composer>,
    'conversationId' | 'onQueue'
  >;
  environmentBarProps: ComponentProps<typeof ComposerEnvironmentBar>;
}

export const AppComposerDock = memo(function AppComposerDock({
  conversationId,
  approvalSheet,
  onSteerQueuedMessage,
  composerProps,
  environmentBarProps,
}: AppComposerDockProps) {
  const queuedMessages = useComposerDraftStore((state) => state.queuedMessagesMap[conversationId] ?? EMPTY_MESSAGES);
  const queueDraftMessage = useComposerDraftStore((state) => state.queueDraftMessage);
  const removeQueuedMessage = useComposerDraftStore((state) => state.removeQueuedMessage);
  const reorderQueuedMessage = useComposerDraftStore((state) => state.reorderQueuedMessage);

  const handleQueue = useCallback(() => {
    queueDraftMessage(conversationId);
  }, [conversationId, queueDraftMessage]);

  const handleRemoveQueuedMessage = useCallback((id: string) => {
    removeQueuedMessage(conversationId, id);
  }, [conversationId, removeQueuedMessage]);

  const handleReorderQueuedMessage = useCallback((id: string, direction: 'up' | 'down') => {
    reorderQueuedMessage(conversationId, id, direction);
  }, [conversationId, reorderQueuedMessage]);

  return (
    <div className="relative mx-auto w-full max-w-[720px] shrink-0">
      <QueuedMessages
        messages={queuedMessages}
        onReorder={handleReorderQueuedMessage}
        onRemove={handleRemoveQueuedMessage}
        onSteer={onSteerQueuedMessage}
      />
      <div className="relative z-10">
        <AnimatePresence initial={false} mode="wait">
          {approvalSheet}
        </AnimatePresence>
        <div className="relative z-20">
          <Composer
            {...composerProps}
            conversationId={conversationId}
            onQueue={handleQueue}
          />
          <ComposerEnvironmentBar {...environmentBarProps} />
        </div>
      </div>
    </div>
  );
});
