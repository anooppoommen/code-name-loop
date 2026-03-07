import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ActivityIntermediateGroup } from './activity-feed/ActivityIntermediateGroup';
import { ActivityFrame, ActivityItem } from './activity-feed/ActivityItem';
import { textTargetForEvent } from './activity-feed/textTarget';
import type { ToolReplyActions } from './tool-cards';
import { CombinedPatchViewer } from './CombinedPatchViewer';
import type { ApplyPatchResult } from '../hooks/useConversations';
import type { ActivityEvent } from '../types/ui';
import type { PatchFile } from '../utils/patches';
import { useEventStore } from '../stores/eventStore';
import { useGroupStore } from '../stores/groupStore';
import { usePatchRevertStore } from '../stores/patchRevertStore';
import { buildRenderGroups, visibleEventsForGroup } from '../utils/activityRenderGroups';
import { buildAssistantPatchContext } from '../utils/patchActivityState';
import { buildPatchRevertKey } from '../utils/patchRevertKey';

interface ActivityFeedProps extends ToolReplyActions {
  conversationId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  currentStatus: string;
  hideLifecycle: boolean;
  isLoadingHistory: boolean;
  applyPatchToWorkspace: (
    conversationId: string,
    files: PatchFile[],
    message: string,
    baseCheckpointId?: string,
    patchId?: string,
  ) => Promise<ApplyPatchResult | null>;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

const BOTTOM_THRESHOLD_PX = 24;
const EMPTY_GROUPS: ReturnType<typeof useGroupStore.getState>['groupsByConversation'][string] = [];
const FEED_ENTRY_EASE = [0.22, 1, 0.36, 1] as const;
const FEED_ENTRY_TRANSITION = { duration: 0.25, ease: FEED_ENTRY_EASE } as const;
const FEED_REVEAL_TRANSITION = { duration: 0.2, ease: 'easeInOut' } as const;
const CHARS_PER_MS = 0.28;

export const ActivityFeed = memo(function ActivityFeed({
  conversationId,
  containerRef,
  currentStatus,
  hideLifecycle,
  isLoadingHistory,
  applyPatchToWorkspace,
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

  const timelineEvents = useMemo(() => {
    const next: ActivityEvent[] = [];
    for (const group of groups) {
      for (const event of visibleEventsForGroup(group, eventsById, false)) {
        next.push(event);
      }
    }
    return next;
  }, [eventsById, groups]);

  const events = useMemo(() => {
    if (!hideLifecycle) {
      return timelineEvents;
    }
    return timelineEvents.filter((event) => event.kind !== 'lifecycle');
  }, [hideLifecycle, timelineEvents]);

  const groupedEvents = useMemo(
    () => buildRenderGroups(groups, eventsById, hideLifecycle, isSending),
    [eventsById, groups, hideLifecycle, isSending],
  );
  const showHistoryLoadingState = isLoadingHistory && !isSending && events.length === 0;

  const [visibleChars, setVisibleChars] = useState<Record<string, number>>({});
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [entryAnimationsEnabled, setEntryAnimationsEnabled] = useState(false);

  const programmaticScrollRef = useRef(false);
  const stickyBottomRef = useRef(true);
  const pendingInitialSnapRef = useRef(false);
  const feedContentRef = useRef<HTMLDivElement>(null);

  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleScrollFrameRef = useRef<number | null>(null);
  const settleScrollPassesRef = useRef(0);
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      const node = containerRef.current;
      if (!node) {
        return;
      }

      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }
      if (settleScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(settleScrollFrameRef.current);
        settleScrollFrameRef.current = null;
      }

      const performScroll = (nextBehavior: ScrollBehavior): void => {
        node.scrollTo({
          top: Math.max(0, node.scrollHeight - node.clientHeight),
          behavior: nextBehavior,
        });
      };

      programmaticScrollRef.current = true;
      stickyBottomRef.current = true;
      setIsAtBottom((current) => (current ? current : true));

      if (behavior === 'smooth') {
        performScroll('smooth');

        settleScrollPassesRef.current = 2;
        const settleAfterAnimation = (): void => {
          performScroll('auto');
          settleScrollPassesRef.current -= 1;
          if (settleScrollPassesRef.current > 0) {
            settleScrollFrameRef.current = window.requestAnimationFrame(settleAfterAnimation);
            return;
          }
          settleScrollFrameRef.current = null;
        };
        settleScrollFrameRef.current = window.requestAnimationFrame(settleAfterAnimation);

        scrollTimeoutRef.current = setTimeout(() => {
          programmaticScrollRef.current = false;
          scrollTimeoutRef.current = null;
        }, 700); // Let the smooth follow finish before user scroll events take over again.
      } else {
        performScroll('auto');
        window.requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }
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
    setIsAtBottom(true);
    setEntryAnimationsEnabled(false);
    stickyBottomRef.current = true;
    pendingInitialSnapRef.current = true;
  }, [conversationId]);

  useEffect(() => {
    if (entryAnimationsEnabled || events.length > 0 || isSending) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setEntryAnimationsEnabled(true);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [conversationId, entryAnimationsEnabled, events.length, isSending]);

  useLayoutEffect(() => {
    if (!pendingInitialSnapRef.current) {
      return;
    }

    if (showHistoryLoadingState) {
      return;
    }

    if (isSending) {
      // If we are sending a message, don't auto-snap.
      // The smooth scroll effect will handle it.
      pendingInitialSnapRef.current = false;
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
      pendingInitialSnapRef.current = false;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [events.length, isSending, scrollToBottom, showHistoryLoadingState]);

  useLayoutEffect(() => {
    if (entryAnimationsEnabled || events.length === 0) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setEntryAnimationsEnabled(true);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [entryAnimationsEnabled, events.length]);

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
  }, [timelineEvents]);

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

  useLayoutEffect(() => {
    if (!stickyBottomRef.current || events.length === 0) {
      return;
    }

    scrollToBottom('auto');
  }, [events.length, groupedEvents, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (settleScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(settleScrollFrameRef.current);
      }
    };
  }, []);

  const finalAgentEventId = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === 'assistant') {
        return events[index].id;
      }
    }
    return null;
  }, [events]);

  const assistantPatchContext = useMemo(() => buildAssistantPatchContext(timelineEvents), [timelineEvents]);
  const syncPatchRevertAuthoritative = usePatchRevertStore((state) => state.syncAuthoritative);

  useEffect(() => {
    for (const context of assistantPatchContext.values()) {
      const patchKey = buildPatchRevertKey(conversationId, context.patchId, context.patches);
      syncPatchRevertAuthoritative(patchKey, context.revertedPaths);
    }
  }, [assistantPatchContext, conversationId, syncPatchRevertAuthoritative]);

  const renderEventItem = useCallback((event: ActivityEvent) => {
    const isFinalAgent = event.id === finalAgentEventId;
    const skipAnimation = prefersReducedMotion || !entryAnimationsEnabled;
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
        {event.kind === 'assistant' && assistantPatchContext.has(event.id) ? (
          <ActivityFrame
            className="px-2 pb-3 pt-1"
            left={<div className="flex h-8 w-8 shrink-0 items-center justify-center" />}
            contentClassName="min-w-0"
          >
            <CombinedPatchViewer
              patchKey={buildPatchRevertKey(
                conversationId,
                assistantPatchContext.get(event.id)?.patchId,
                assistantPatchContext.get(event.id)?.patches || [],
              )}
              patchId={assistantPatchContext.get(event.id)?.patchId}
              patches={assistantPatchContext.get(event.id)?.patches || []}
              checkpointId={assistantPatchContext.get(event.id)?.checkpointId}
              revertedPaths={assistantPatchContext.get(event.id)?.revertedPaths}
              conversationId={conversationId}
              applyPatchToWorkspace={applyPatchToWorkspace}
            />
          </ActivityFrame>
        ) : null}
      </motion.div>
    );
  }, [
    assistantPatchContext,
    applyPatchToWorkspace,
    canCompose,
    conversationId,
    finalAgentEventId,
    isSending,
    onEditMessage,
    onRetryMessage,
    onSendToolReply,
    onUseToolReply,
    entryAnimationsEnabled,
    prefersReducedMotion,
    visibleChars,
  ]);

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <motion.div
        ref={containerRef}
        data-activity-scroll-container="true"
        className="flex-1 overflow-y-auto px-4 py-3"
        style={{ scrollbarGutter: 'stable both-edges' }}
      >
        <AnimatePresence initial={false}>
          {showHistoryLoadingState ? (
            <motion.div
              key="history-loading"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={prefersReducedMotion ? undefined : { opacity: 1 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0 }}
              transition={FEED_REVEAL_TRANSITION}
              className="mx-auto flex h-full w-full max-w-[720px] items-start px-4 py-3"
            >
              <p className="m-0 text-sm text-loop-500">Loading activity…</p>
            </motion.div>
          ) : (
            <motion.div
              key={`history-content:${conversationId}`}
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={prefersReducedMotion ? undefined : { opacity: 1 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0 }}
              transition={FEED_REVEAL_TRANSITION}
            >
              <div ref={feedContentRef} className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-end">
                <div className="flex flex-col justify-end">
                  <AnimatePresence initial={false}>
                    {events.length === 0 && !isSending ? (
                      <motion.p
                        key="empty-state"
                        initial={prefersReducedMotion || !entryAnimationsEnabled ? false : { opacity: 0 }}
                        animate={prefersReducedMotion || !entryAnimationsEnabled ? undefined : { opacity: 1 }}
                        exit={prefersReducedMotion || !entryAnimationsEnabled ? undefined : { opacity: 0 }}
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
                          initial={prefersReducedMotion || !entryAnimationsEnabled ? false : { opacity: 0, y: 12 }}
                          animate={prefersReducedMotion || !entryAnimationsEnabled ? undefined : { opacity: 1, y: 0 }}
                          exit={prefersReducedMotion || !entryAnimationsEnabled ? undefined : { opacity: 0 }}
                          transition={FEED_ENTRY_TRANSITION}
                        >
                          <ActivityIntermediateGroup
                            events={group.events}
                            defaultExpanded={group.defaultExpanded ?? false}
                            disableInitialMotion={prefersReducedMotion || !entryAnimationsEnabled}
                            scrollAnchorId={group.scrollAnchorId ?? group.events[0]?.id ?? ''}
                            renderEventItem={renderEventItem}
                          />
                        </motion.div>
                      );
                    })}
                    {isSending ? (
                      <motion.div
                        key="activity-status"
                        initial={prefersReducedMotion || !entryAnimationsEnabled ? false : { opacity: 0, y: 12 }}
                        animate={prefersReducedMotion || !entryAnimationsEnabled ? undefined : { opacity: 1, y: 0 }}
                        exit={prefersReducedMotion || !entryAnimationsEnabled ? undefined : { opacity: 0 }}
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
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
