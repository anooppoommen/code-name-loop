import { Pencil, RotateCcw } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import type { RefObject } from 'react';
import { ACTIVITY_EASE_CSS, ActivityPresence, hoverMotion } from './ActivityMotion';
import { CopyDropdown } from './ActivityItemShared';
import type { ActivityEditMessageHandler } from './ActivityItemTypes';
import { useActivityEvent } from './useActivityEvent';

interface ActivityUserActionsProps {
  eventId: string;
  renderedText: string;
  markdownContainerRef: RefObject<HTMLDivElement | null>;
  isHovered: boolean;
  isSending: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: ActivityEditMessageHandler;
}

export function ActivityUserActions({
  eventId,
  renderedText,
  markdownContainerRef,
  isHovered,
  isSending,
  onRetryMessage,
  onEditMessage,
}: ActivityUserActionsProps) {
  const reduced = Boolean(useReducedMotion());
  const event = useActivityEvent(eventId);

  if (!event?.messageId) {
    return null;
  }

  return (
    <ActivityPresence>
      {isHovered ? (
        <motion.div
          {...hoverMotion(!reduced)}
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
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition-[background-color,color,transform] duration-200 hover:-translate-y-0.5 hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isSending}
            onClick={() => {
              void onRetryMessage(event.messageId!);
            }}
            style={{ transitionTimingFunction: ACTIVITY_EASE_CSS }}
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            aria-label="Edit this message"
            title="Edit this message"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition-[background-color,color,transform] duration-200 hover:-translate-y-0.5 hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isSending}
            onClick={() => {
              onEditMessage(event.messageId!, event.body || '', event.images || []);
            }}
            style={{ transitionTimingFunction: ACTIVITY_EASE_CSS }}
          >
            <Pencil size={13} />
          </button>
        </motion.div>
      ) : null}
    </ActivityPresence>
  );
}
