import { Pencil, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { RefObject } from 'react';
import type { ActivityEvent } from '../../types/ui';
import { CopyDropdown } from './ActivityItemShared';
import type { ActivityEditMessageHandler } from './ActivityItemTypes';

interface ActivityUserActionsProps {
  event: ActivityEvent;
  renderedText: string;
  markdownContainerRef: RefObject<HTMLDivElement | null>;
  isHovered: boolean;
  isSending: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: ActivityEditMessageHandler;
}

export function ActivityUserActions({
  event,
  renderedText,
  markdownContainerRef,
  isHovered,
  isSending,
  onRetryMessage,
  onEditMessage,
}: ActivityUserActionsProps) {
  if (!event.messageId) {
    return null;
  }

  return (
    <AnimatePresence>
      {isHovered ? (
        <motion.div
          initial={{ opacity: 0, x: 6, scale: 0.96 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 6, scale: 0.96 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="absolute left-2 top-0 flex flex-col items-center gap-1 pt-1"
        >
          <CopyDropdown
            getMarkdown={() => renderedText}
            getText={() => markdownContainerRef.current?.innerText || renderedText}
          />
          <button
            type="button"
            aria-label="Retry from this message"
            title="Retry from this message"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isSending}
            onClick={() => {
              void onRetryMessage(event.messageId!);
            }}
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            aria-label="Edit this message"
            title="Edit this message"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isSending}
            onClick={() => {
              onEditMessage(event.messageId!, event.body || '', event.images || []);
            }}
          >
            <Pencil size={13} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
