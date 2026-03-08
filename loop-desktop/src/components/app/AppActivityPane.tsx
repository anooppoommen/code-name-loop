import { memo, type ComponentProps, Profiler } from 'react';
import { motion } from 'framer-motion';
import { ActivityFeed } from '../ActivityFeed';

export interface AppActivityPaneProps extends ComponentProps<typeof ActivityFeed> {
  onRenderCallback: (
    id: string,
    phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ) => void;
}

export const AppActivityPane = memo(function AppActivityPane({
  onRenderCallback,
  ...feedProps
}: AppActivityPaneProps) {
  return (
    <motion.div
      key="activity-feed"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.22 }}
      className="h-full"
    >
      <Profiler id="ActivityFeed" onRender={onRenderCallback}>
        <ActivityFeed {...feedProps} />
      </Profiler>
    </motion.div>
  );
});
