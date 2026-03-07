import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ActivityIntermediateGroup } from './activity-feed/ActivityIntermediateGroup';
import { ActivityFrame, ActivityItem } from './activity-feed/ActivityItem';
import { textTargetForEvent } from './activity-feed/textTarget';
import type { ToolReplyActions } from './tool-cards';
import { CombinedPatchViewer } from './CombinedPatchViewer';
import type { ActivityEvent } from '../types/ui';
import { useEventStore } from '../stores/eventStore';
import { useGroupStore } from '../stores/groupStore';
import { buildRenderGroups, visibleEventsForGroup } from '../utils/activityRenderGroups';

interface ActivityFeedProps extends ToolReplyActions {
  conversationId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  currentStatus: string;
  hideLifecycle: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

const BOTTOM_THRESHOLD_PX = 24;
const EMPTY_GROUPS: ReturnType<typeof useGroupStore.getState>['groupsByConversation'][string] = [];
const FEED_ENTRY_EASE = [0.22, 1, 0.36, 1] as const;
const FEED_ENTRY_TRANSITION = { duration: 0.25, ease: FEED_ENTRY_EASE } as const;
const CHARS_PER_MS = 0.28;

export const ActivityFeed = memo(function ActivityFeed({
  conversationId,
  containerRef,
  currentStatus,
  hideLifecycle,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
  onRetryMessage,
  onEditMessage,
}: ActivityFeedProps) {
  const prefersReducedMotion = useReducedMotion();
  const groups = useGroupStore(
    useCallback((state) => state.groupsByConversation[conversationId] ?? EMPTY_GROUPS, [conversationId]),
  );
  const eventsById = useEventStore((state) => state.events);

  const events = useMemo(() => {
    const next: ActivityEvent[] = [];
    for (const group of groups) {
      for (const event of visibleEventsForGroup(group, eventsById, hideLifecycle)) {
        next.push(event);
      }
    }
    return next;
  }, [eventsById, groups, hideLifecycle]);

  const groupedEvents = useMemo(
    () => buildRenderGroups(groups, eventsById, hideLifecycle, isSending),
    [eventsById, groups, hideLifecycle, isSending],
  );

  const [visibleChars, setVisibleChars] = useState<Record<string, number>>({});
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUserScrolled, setHasUserScrolled] = useState(false);

  const programmaticScrollRef = useRef(false);
  const stickyBottomRef = useRef(true);
  const pendingInitialSnapRef = useRef(false);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const feedContentRef = useRef<HTMLDivElement>(null);

  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      const node = containerRef.current;
      if (!node) {
        return;
      }

      programmaticScrollRef.current = true;

      if (behavior === 'smooth') {
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current);
        }
        node.scrollTo({ top: node.scrollHeight, behavior });
        scrollTimeoutRef.current = setTimeout(() => {
          programmaticScrollRef.current = false;
          scrollTimeoutRef.current = null;
        }, 500); // Give smooth scrolling time to complete
      } else {
        node.scrollTop = node.scrollHeight;
        if (!scrollTimeoutRef.current) {
          window.requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
          });
        }
      }
      setIsAtBottom((current) => (current ? current : true));
      stickyBottomRef.current = true;
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
  }, [conversationId]);

  useLayoutEffect(() => {
    if (!pendingInitialSnapRef.current) {
      return;
    }

    if (isSending) {
      // If we are sending a message, don't auto-snap.
      // The smooth scroll effect will handle it.
      pendingInitialSnapRef.current = false;
      return;
    }

    scrollToBottom('auto');
    if (events.length > 0) {
      pendingInitialSnapRef.current = false;
    }
  }, [events.length, isSending, scrollToBottom]);

  const previousIsSendingRef = useRef(isSending);
  useEffect(() => {
    const prevIsSending = previousIsSendingRef.current;
    if (isSending && !prevIsSending) {
      scrollToBottom('smooth');
      pendingInitialSnapRef.current = false;
    }
    previousIsSendingRef.current = isSending;
  }, [isSending, scrollToBottom]);

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

    if (prefersReducedMotion) {
      setVisibleChars((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const event of streaming) {
          const fullText = textTargetForEvent(event);
          const current = next[event.id] ?? 0;
          const target = fullText.length;

          if (current !== target) {
            next[event.id] = target;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
      return;
    }

    let rafId: number;
    let lastTime: number | null = null;

    const tick = (timestamp: number): void => {
      if (lastTime === null) {
        lastTime = timestamp;
        rafId = window.requestAnimationFrame(tick);
        return;
      }

      const elapsed = timestamp - lastTime;
      lastTime = timestamp;
      const charsToAdvance = Math.max(1, Math.round(elapsed * CHARS_PER_MS));

      setVisibleChars((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const event of streaming) {
          const fullText = textTargetForEvent(event);
          const current = next[event.id] ?? 0;
          const target = fullText.length;
          if (current >= target) {
            continue;
          }

          next[event.id] = Math.min(target, current + charsToAdvance);
          changed = true;
        }

        return changed ? next : prev;
      });

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [events, prefersReducedMotion]);

  useEffect(() => {
    const scrollNode = containerRef.current;
    const contentNode = feedContentRef.current;
    if (!scrollNode || !contentNode) {
      return;
    }

    const ro = new ResizeObserver(() => {
      if (!stickyBottomRef.current) {
        return;
      }

      scrollToBottom('auto');
    });

    ro.observe(contentNode);
    return () => ro.disconnect();
  }, [containerRef, scrollToBottom]);

  const finalAgentEventId = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === 'assistant') {
        return events[index].id;
      }
    }
    return null;
  }, [events]);

  const assistantPatches = useMemo(() => {
    const patchesByAssistant = new Map<string, string[]>();
    let currentPatches: string[] = [];

    for (const event of events) {
      if (event.kind === 'user') {
        currentPatches = [];
        continue;
      }

      if (event.kind === 'tool') {
        const toolName = event.tool?.name || '';
        if ((toolName === 'apply_patch' || toolName.endsWith(':apply_patch')) && event.tool?.success !== false) {
          const patchText = event.tool?.command || event.body;
          if (patchText) {
            currentPatches.push(patchText);
          }
        }
        continue;
      }

      if (event.kind === 'assistant') {
        if (currentPatches.length > 0) {
          patchesByAssistant.set(event.id, [...currentPatches]);
        }
        currentPatches = [];
      }
    }

    return patchesByAssistant;
  }, [events]);

  const renderEventItem = useCallback((event: ActivityEvent) => {
    const isFinalAgent = event.id === finalAgentEventId;
    const skipAnimation = prefersReducedMotion;
    return (
      <motion.div
        key={event.id}
        data-activity-event-id={event.id}
        initial={skipAnimation ? false : { opacity: 0, y: 12 }}
        animate={skipAnimation ? undefined : { opacity: 1, y: 0 }}
        exit={skipAnimation ? undefined : { opacity: 0 }}
        transition={FEED_ENTRY_TRANSITION}
      >
        <ActivityItem
          event={event}
          visibleChars={visibleChars[event.id]}
          isFinalAgent={isFinalAgent}
          canCompose={canCompose}
          isSending={isSending}
          onUseToolReply={onUseToolReply}
          onSendToolReply={onSendToolReply}
          onRetryMessage={onRetryMessage}
          onEditMessage={onEditMessage}
        />
        {event.kind === 'assistant' && assistantPatches.has(event.id) ? (
          <ActivityFrame
            className="px-2 pb-3 pt-1"
            left={<div className="flex h-8 w-8 shrink-0 items-center justify-center" />}
            contentClassName="min-w-0"
          >
            <CombinedPatchViewer patches={assistantPatches.get(event.id) || []} />
          </ActivityFrame>
        ) : null}
      </motion.div>
    );
  }, [
    assistantPatches,
    canCompose,
    finalAgentEventId,
    isSending,
    onEditMessage,
    onRetryMessage,
    onSendToolReply,
    onUseToolReply,
    prefersReducedMotion,
    visibleChars,
  ]);

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <motion.div
        ref={containerRef}
        data-activity-scroll-container="true"
        className={`flex-1 overflow-y-auto px-4 py-3 ${hasUserScrolled ? '' : 'scrollbar-hidden'}`}
      >
        <div ref={feedContentRef} className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-end">
          <div className="flex flex-col justify-end">
            <AnimatePresence initial={false}>
              {events.length === 0 && !isSending ? (
                <motion.p
                  key="empty-state"
                  initial={prefersReducedMotion ? false : { opacity: 0 }}
                  animate={prefersReducedMotion ? undefined : { opacity: 1 }}
                  exit={prefersReducedMotion ? undefined : { opacity: 0 }}
                  className="m-0 px-4 py-3 text-sm text-loop-500"
                >
                  No run activity yet. Send a task to start streaming events.
                </motion.p>
              ) : null}
              {groupedEvents.map((group) => {
                if (group.type === 'single') {
                  return renderEventItem(group.events[0]);
                }
                return (
                  <motion.div
                    key={group.id}
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
                    animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0 }}
                    transition={FEED_ENTRY_TRANSITION}
                  >
                    <ActivityIntermediateGroup
                      events={group.events}
                      defaultExpanded={group.defaultExpanded ?? false}
                      scrollAnchorId={group.scrollAnchorId ?? group.events[0]?.id ?? ''}
                      renderEventItem={renderEventItem}
                    />
                  </motion.div>
                );
              })}
              {isSending ? (
                <motion.div
                  key="activity-status"
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
                  animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? undefined : { opacity: 0 }}
                  transition={FEED_ENTRY_TRANSITION}
                >
                  <ActivityFrame className="group px-2 py-2">
                    <span className="animate-googleStatus pb-1 text-left text-[11px] font-medium bg-[linear-gradient(110deg,transparent_25%,rgba(255,255,255,0.7)_50%,transparent_75%)] bg-[length:200%_auto] bg-clip-text text-transparent drop-shadow-sm">
                      {currentStatus || 'Thinking...'}
                    </span>
                  </ActivityFrame>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <div ref={bottomAnchorRef} aria-hidden="true" className="h-px w-full shrink-0" />
        </div>
      </motion.div>
      {!isAtBottom && events.length > 0 ? (
        <button
          type="button"
          className={`absolute left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-loop-700 bg-loop-900/95 px-3 py-1.5 text-xs font-medium text-loop-200 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:border-loop-500 hover:bg-loop-800 ${isSending ? 'bottom-8' : 'bottom-4'}`}
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
