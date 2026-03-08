import { memo, type ComponentProps } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sidebar } from '../Sidebar';

export interface AppSidebarPaneProps extends ComponentProps<typeof Sidebar> {
  isSidebarOpen: boolean;
}

export const AppSidebarPane = memo(function AppSidebarPane({
  isSidebarOpen,
  ...sidebarProps
}: AppSidebarPaneProps) {
  return (
    <AnimatePresence initial={false}>
      {isSidebarOpen ? (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 260, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="h-full shrink-0 overflow-hidden border-r border-loop-700 bg-loop-800 pt-7 max-[920px]:h-auto max-[920px]:w-full"
        >
          <Sidebar {...sidebarProps} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
});
