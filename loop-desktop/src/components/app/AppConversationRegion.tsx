import { memo, type ComponentProps } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { NewThreadView } from '../NewThreadView';
import { AppActivityPane } from './AppActivityPane';

interface AppConversationRegionProps {
  selectedConversationId: string;
  activityPaneProps: ComponentProps<typeof AppActivityPane>;
  newThreadProps: ComponentProps<typeof NewThreadView>;
}

export const AppConversationRegion = memo(function AppConversationRegion({
  selectedConversationId,
  activityPaneProps,
  newThreadProps,
}: AppConversationRegionProps) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <AnimatePresence initial={false} mode="wait">
        {selectedConversationId ? (
          <AppActivityPane {...activityPaneProps} />
        ) : (
          <motion.div
            key="new-thread-view"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.24 }}
            className="h-full"
          >
            <NewThreadView {...newThreadProps} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
