import { ArrowDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ActivityFrame, ActivityItem } from './activity-feed/ActivityItem';
import { textTargetForEvent } from './activity-feed/textTarget';
import type { ToolReplyActions } from './tool-cards';
import type { ActivityEvent } from '../types/ui';

interface ActivityFeedProps extends ToolReplyActions {
  events: ActivityEvent[];
  conversationId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  currentStatus: string;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

const BOTTOM_THRESHOLD_PX = 24;

export const ActivityFeed = memo(function ActivityFeed({
  events,
  conversationId,
  containerRef,
  currentStatus,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
  onRetryMessage,
  onEditMessage,
}: ActivityFeedProps) {
  const [visibleChars, setVisibleChars] = useState<Record<string, number>>({});
  const [copiedToolID, setCopiedToolID] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUserScrolled, setHasUserScrolled] = useState(false);

  const programmaticScrollRef = useRef(false);
  const stickyBottomRef = useRef(true);
  const pendingInitialSnapRef = useRef(false);
  const previousConversationIdRef = useRef(conversationId);
  const previousEventIDsRef = useRef<Set<string>>(new Set());

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      const node = containerRef.current;
      if (!node) {
        return;
      }

      programmaticScrollRef.current = true;
      node.scrollTo({
        top: node.scrollHeight,
        behavior,
      });
      setIsAtBottom(true);
      stickyBottomRef.current = true;

      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    },
    [containerRef],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const getIsNearBottom = (): boolean =>
      node.scrollHeight - (node.scrollTop + node.clientHeight) <= BOTTOM_THRESHOLD_PX;

    const onScroll = (): void => {
      if (programmaticScrollRef.current) {
        return;
      }

      setHasUserScrolled(true);
      const nearBottom = getIsNearBottom();
      setIsAtBottom(nearBottom);
      stickyBottomRef.current = nearBottom;
    };

    const nearBottom = getIsNearBottom();
    setIsAtBottom(nearBottom);
    stickyBottomRef.current = nearBottom;

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [containerRef]);

  useEffect(() => {
    setHasUserScrolled(false);
    setIsAtBottom(true);
    stickyBottomRef.current = true;
    pendingInitialSnapRef.current = true;
  }, [conversationId, scrollToBottom]);

  const shouldSkipTimelineAnimation = useMemo(() => {
    const didConversationChange = previousConversationIdRef.current !== conversationId;
    if (didConversationChange) {
      return true;
    }

    const prevIDs = previousEventIDsRef.current;
    if (prevIDs.size === 0 || events.length === 0) {
      return false;
    }

    let overlap = 0;
    for (const event of events) {
      if (prevIDs.has(event.id)) {
        overlap++;
        break;
      }
    }
    return overlap === 0;
  }, [conversationId, events]);

  useEffect(() => {
    previousConversationIdRef.current = conversationId;
    previousEventIDsRef.current = new Set(events.map((event) => event.id));
  }, [conversationId, events]);

  useLayoutEffect(() => {
    if (!pendingInitialSnapRef.current) {
      return;
    }

    scrollToBottom('auto');
    if (events.length > 0) {
      pendingInitialSnapRef.current = false;
    }
  }, [events, scrollToBottom]);

  useEffect(() => {
    setVisibleChars((prev) => {
      const next: Record<string, number> = {};
      let changed = false;

      for (const event of events) {
        const fullText = textTargetForEvent(event);
        const prior = prev[event.id] ?? 0;

        if (!event.streaming || (event.kind !== 'assistant' && event.kind !== 'thought')) {
          next[event.id] = fullText.length;
        } else {
          next[event.id] = Math.min(prior, fullText.length);
        }
      }

      if (Object.keys(prev).length !== Object.keys(next).length) {
        changed = true;
      } else {
        for (const key of Object.keys(next)) {
          if (next[key] !== prev[key]) {
            changed = true;
            break;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [events]);

  useEffect(() => {
    const streaming = events.filter(
      (event) => event.streaming && (event.kind === 'assistant' || event.kind === 'thought'),
    );
    if (streaming.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setVisibleChars((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const event of streaming) {
          const fullText = textTargetForEvent(event);
          const current = next[event.id] ?? 0;
          const step = event.kind === 'assistant' ? 3 : 5;
          const target = fullText.length;
          const advanced = Math.min(target, current + step);
          if (advanced !== current) {
            next[event.id] = advanced;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, 34);

    return () => window.clearInterval(timer);
  }, [events]);

  useEffect(() => {
    if (!stickyBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [events, scrollToBottom, visibleChars]);

  const handleCopyToolCommand = useCallback((command: string, eventId: string) => {
    void copyToolCommand(command, eventId, setCopiedToolID);
  }, []);

  const renderEventItem = useCallback((event: ActivityEvent) => (
    <ActivityItem
      key={event.id}
      event={event}
      visibleChars={visibleChars[event.id]}
      isCopied={copiedToolID === event.id}
      onCopyToolCommand={handleCopyToolCommand}
      canCompose={canCompose}
      isSending={isSending}
      onUseToolReply={onUseToolReply}
      onSendToolReply={onSendToolReply}
      onRetryMessage={onRetryMessage}
      onEditMessage={onEditMessage}
    />
  ), [
    canCompose,
    copiedToolID,
    handleCopyToolCommand,
    isSending,
    onEditMessage,
    onRetryMessage,
    onSendToolReply,
    onUseToolReply,
    visibleChars,
  ]);

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div
        ref={containerRef}
        className={`flex-1 overflow-y-auto px-4 py-3 ${hasUserScrolled ? '' : 'scrollbar-hidden'}`}
      >
        <div className="mx-auto w-full max-w-[720px]">
          {events.length === 0 ? (
            <p className="m-0 px-4 py-3 text-sm text-loop-500">No run activity yet. Send a task to start streaming events.</p>
          ) : shouldSkipTimelineAnimation ? (
            events.map((event) => renderEventItem(event))
          ) : (
            <AnimatePresence initial={false} mode="popLayout">
              {events.map((event) => (
                <motion.div
                  key={event.id}
                  layout
                  initial={{ opacity: 0, y: 8, scale: 0.995 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.995 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  {renderEventItem(event)}
                </motion.div>
              ))}
            </AnimatePresence>
          )}
          {isSending ? (
            <ActivityFrame className="group px-2 py-2">
              <span className="animate-googleStatus pb-1 text-left text-[11px] font-medium bg-[linear-gradient(110deg,transparent_25%,rgba(255,255,255,0.7)_50%,transparent_75%)] bg-[length:200%_auto] bg-clip-text text-transparent drop-shadow-sm">
                {currentStatus || 'Thinking...'}
              </span>
            </ActivityFrame>
          ) : null}
        </div>
      </div>
      {!isAtBottom && events.length > 0 ? (
        <button
          type="button"
          className={`absolute left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-loop-700 bg-loop-900/95 px-3 py-1.5 text-xs font-medium text-loop-200 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:border-loop-500 hover:bg-loop-800 ${isSending ? 'bottom-8' : 'bottom-4'
            }`}
          onClick={() => scrollToBottom('smooth')}
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={14} />
          Latest
        </button>
      ) : null}
    </section>
  );
});

async function copyToolCommand(
  command: string,
  eventID: string,
  setCopiedToolID: (value: string) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    setCopiedToolID(eventID);
    window.setTimeout(() => {
      setCopiedToolID('');
    }, 1200);
  } catch {
    // Clipboard support can vary by runtime.
  }
}
