import { useReducedMotion } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { ActivityIntermediateGroup } from './activity-feed/ActivityIntermediateGroup';
import { ActivityFrame, ActivityItem } from './activity-feed/ActivityItem';
import {
  ACTIVITY_EASE_CSS,
  ActivityAppendGrow,
  ActivityPresence,
  ActivityReveal,
} from './activity-feed/ActivityMotion';
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
import { useShallow } from 'zustand/react/shallow';

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
const BOTTOM_SETTLE_MS = 1200;
const EMPTY_GROUPS: ReturnType<typeof useGroupStore.getState>['groupsByConversation'][string] = [];
const EMPTY_EVENTS: ActivityEvent[] = [];
const EMPTY_EVENT_ID_SET = new Set<string>();

interface ActivityFeedEventsProps {
  allowInteractiveMotion: boolean;
  eventsLength: number;
  groupedEvents: ReturnType<typeof buildRenderGroups>;
  isSending: boolean;
  renderEventItem: (event: ActivityEvent) => ReactElement | null;
}

const ActivityFeedEvents = memo(function ActivityFeedEvents({
  allowInteractiveMotion,
  eventsLength,
  groupedEvents,
  isSending,
  renderEventItem,
}: ActivityFeedEventsProps) {
  return (
    <>
      {eventsLength === 0 && !isSending ? (
        <p className="m-0 px-4 py-3 text-sm text-loop-500">
          No run activity yet. Send a task to start streaming events.
        </p>
      ) : null}
      {groupedEvents.map((group) => {
        if (group.type === 'single') {
          return renderEventItem(group.events[0]);
        }

        return (
          <ActivityIntermediateGroup
            key={group.id}
            events={group.events}
            defaultExpanded={group.defaultExpanded ?? false}
            disableInitialMotion
            animate={allowInteractiveMotion}
            renderEventItem={renderEventItem}
          />
        );
      })}
    </>
  );
});

const ActivitySendingStatus = memo(function ActivitySendingStatus({ currentStatus }: { currentStatus: string }) {
  return (
    <ActivityFrame
      className="group px-2 py-2"
    >
      <span className="animate-googleStatus pb-1 text-left text-[11px] font-medium bg-[linear-gradient(110deg,transparent_25%,rgba(255,255,255,0.7)_50%,transparent_75%)] bg-[length:200%_auto] bg-clip-text text-transparent drop-shadow-sm">
        {currentStatus || 'Thinking...'}
      </span>
    </ActivityFrame>
  );
});

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
  const prefersReducedMotion = Boolean(useReducedMotion());
  const groups = useGroupStore(
    useCallback((state) => state.groupsByConversation[conversationId] ?? EMPTY_GROUPS, [conversationId]),
  );
  const conversationEvents = useEventStore(
    useShallow(useCallback((state) => {
      const orderedEventIds = state.conversations[conversationId]?.orderedEventIds ?? [];
      if (orderedEventIds.length === 0) {
        return EMPTY_EVENTS;
      }
      return orderedEventIds
        .map((eventId) => state.events[eventId])
        .filter((event): event is ActivityEvent => !!event);
    }, [conversationId])),
  );
  const eventsById = useMemo(() => {
    if (conversationEvents.length === 0) {
      return {} as Record<string, ActivityEvent>;
    }

    const next: Record<string, ActivityEvent> = {};
    for (const event of conversationEvents) {
      next[event.id] = event;
    }
    return next;
  }, [conversationEvents]);

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
  const renderedEventIds = useMemo(() => events.map((event) => event.id), [events]);
  const showHistoryLoadingState = isLoadingHistory && !isSending && events.length === 0;

  const [isAtBottom, setIsAtBottom] = useState(true);
  const allowInteractiveMotion = !prefersReducedMotion;

  const programmaticUntilRef = useRef(0);
  const stickyBottomRef = useRef(true);
  const pendingInitialSnapRef = useRef(false);
  const feedContentRef = useRef<HTMLDivElement>(null);

  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleScrollFrameRef = useRef<number | null>(null);
  const settleScrollPassesRef = useRef(0);
  const resizeScrollFrameRef = useRef<number | null>(null);
  const previousRenderedEventIdsRef = useRef<string[]>([]);
  const animatedEventIdsRef = useRef<Set<string>>(new Set());
  const bottomLockUntilRef = useRef(0);
  const settleTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [settlingEventIds, setSettlingEventIds] = useState<Set<string>>(() => new Set());

  // Marks a scroll as programmatic for a grace period so the onScroll handler
  // ignores it. Using a timestamp prevents the boolean from being cleared too
  // early (the previous 2-frame approach raced with ResizeObserver events).
  const markProgrammatic = useCallback(() => {
    programmaticUntilRef.current = Date.now() + 150;
  }, []);

  const settleEvent = useCallback((eventId: string, durationMs = BOTTOM_SETTLE_MS) => {
    if (!eventId) {
      return;
    }

    setSettlingEventIds((current) => {
      if (current.has(eventId)) {
        return current;
      }
      const next = new Set(current);
      next.add(eventId);
      return next;
    });

    const existingTimeout = settleTimeoutsRef.current[eventId];
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    settleTimeoutsRef.current[eventId] = setTimeout(() => {
      delete settleTimeoutsRef.current[eventId];
      setSettlingEventIds((current) => {
        if (!current.has(eventId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(eventId);
        return next;
      });
    }, durationMs);
  }, []);
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
        // Epsilon check: skip if we're already at the bottom to avoid triggering
        // unnecessary scroll events that can flip stickyBottomRef to false.
        if (Math.abs(node.scrollTop) <= 0.5 && nextBehavior === 'auto') {
          return;
        }
        node.scrollTo({
          top: 0,
          behavior: nextBehavior,
        });
      };

      markProgrammatic();
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
          scrollTimeoutRef.current = null;
        }, 700);
      } else {
        performScroll('auto');
      }
    },
    [containerRef, markProgrammatic],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const getIsNearBottom = (): boolean =>
      Math.abs(node.scrollTop) <= BOTTOM_THRESHOLD_PX;

    const onScroll = (): void => {
      // Ignore scroll events that we triggered programmatically.
      if (Date.now() < programmaticUntilRef.current) {
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
    stickyBottomRef.current = true;
    pendingInitialSnapRef.current = true;
    previousRenderedEventIdsRef.current = [];
    animatedEventIdsRef.current = new Set();
    bottomLockUntilRef.current = 0;
    programmaticUntilRef.current = 0;
    for (const timeout of Object.values(settleTimeoutsRef.current)) {
      clearTimeout(timeout);
    }
    settleTimeoutsRef.current = {};
    setSettlingEventIds(new Set());
  }, [conversationId]);

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

  const finalAgentEventId = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === 'assistant') {
        return events[index].id;
      }
    }
    return null;
  }, [events]);

  const previousIsSendingRef = useRef(isSending);
  useEffect(() => {
    const prevIsSending = previousIsSendingRef.current;
    let frameId: number | null = null;
    let settleFrameId: number | null = null;

    if (isSending && !prevIsSending) {
      bottomLockUntilRef.current = Date.now() + BOTTOM_SETTLE_MS;
      scrollToBottom('auto');
      pendingInitialSnapRef.current = false;
    }
    if (!isSending && prevIsSending) {
      bottomLockUntilRef.current = Date.now() + BOTTOM_SETTLE_MS;
      if (finalAgentEventId) {
        settleEvent(finalAgentEventId);
      }
      frameId = window.requestAnimationFrame(() => {
        scrollToBottom('auto');
        settleFrameId = window.requestAnimationFrame(() => {
          scrollToBottom('auto');
        });
      });
    }
    previousIsSendingRef.current = isSending;
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      if (settleFrameId !== null) {
        window.cancelAnimationFrame(settleFrameId);
      }
    };
  }, [finalAgentEventId, isSending, scrollToBottom, settleEvent]);

  useEffect(() => {
    const scrollNode = containerRef.current;
    const contentNode = feedContentRef.current;
    if (!scrollNode || !contentNode) {
      return;
    }

    const ro = new ResizeObserver(() => {
      if (resizeScrollFrameRef.current !== null) {
        return;
      }

      resizeScrollFrameRef.current = window.requestAnimationFrame(() => {
        resizeScrollFrameRef.current = null;
        const manualAnchorHoldUntil = Number(scrollNode.dataset.activityManualAnchorUntil ?? '0');
        if (manualAnchorHoldUntil > Date.now()) {
          return;
        }

        const bottomLocked = stickyBottomRef.current || Date.now() < bottomLockUntilRef.current;
        if (!bottomLocked) {
          return;
        }

        // Epsilon check: don't fire a scroll if we're already at the bottom.
        // Without this check, a no-op scroll still fires the "scroll" event
        // which can flip stickyBottomRef to false via the onScroll handler.
        if (Math.abs(scrollNode.scrollTop) <= 0.5) {
          return;
        }

        markProgrammatic();
        scrollNode.scrollTop = 0;
      });
    });

    ro.observe(contentNode);
    return () => {
      ro.disconnect();
      if (resizeScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeScrollFrameRef.current);
        resizeScrollFrameRef.current = null;
      }
    };
  }, [containerRef, markProgrammatic]);

  const appendedEventIds = useMemo(() => {
    if (!allowInteractiveMotion || showHistoryLoadingState) {
      animatedEventIdsRef.current = new Set();
      return EMPTY_EVENT_ID_SET;
    }

    const previousIds = previousRenderedEventIdsRef.current;
    if (
      previousIds.length === 0
      || renderedEventIds.length <= previousIds.length
      || !previousIds.every((id, index) => renderedEventIds[index] === id)
    ) {
      return animatedEventIdsRef.current.size > 0 ? animatedEventIdsRef.current : EMPTY_EVENT_ID_SET;
    }

    const newIds = renderedEventIds.slice(previousIds.length);
    for (const id of newIds) {
      animatedEventIdsRef.current.add(id);
    }
    return animatedEventIdsRef.current;
  }, [allowInteractiveMotion, renderedEventIds, showHistoryLoadingState]);

  useLayoutEffect(() => {
    const bottomLocked = stickyBottomRef.current || Date.now() < bottomLockUntilRef.current;
    if (!bottomLocked || events.length === 0 || appendedEventIds.size > 0) {
      return;
    }

    scrollToBottom('auto');
  }, [appendedEventIds, events.length, scrollToBottom]);

  useLayoutEffect(() => {
    if (showHistoryLoadingState) {
      return;
    }
    previousRenderedEventIdsRef.current = renderedEventIds;
  }, [renderedEventIds, showHistoryLoadingState]);

  useEffect(() => {
    return () => {
      for (const timeout of Object.values(settleTimeoutsRef.current)) {
        clearTimeout(timeout);
      }
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (settleScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(settleScrollFrameRef.current);
      }
      if (resizeScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeScrollFrameRef.current);
      }
    };
  }, []);

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
    // shouldTrackLiveHeight: true when the item's content can change dynamically.
    // - event.streaming: assistant text events updating live
    // - settlingEventIds: recently-completed events still in settling window
    // - appendedEventIds + isSending: newly-added tool/thought events this turn
    //   (their content may update even though event.streaming is false for tool events)
    const isRecentlyAppended = isSending && appendedEventIds.has(event.id);
    const shouldTrackLiveHeight = Boolean(event.streaming) || settlingEventIds.has(event.id) || isRecentlyAppended;
    return (
      <ActivityAppendGrow
        key={event.id}
        animate={allowInteractiveMotion && (appendedEventIds.has(event.id) || shouldTrackLiveHeight)}
        watch={shouldTrackLiveHeight}
        fade={event.kind === 'assistant' && !event.streaming}
        data-activity-event-id={event.id}
      >
        <ActivityItem
          event={event}
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
      </ActivityAppendGrow>
    );
  }, [
    allowInteractiveMotion,
    assistantPatchContext,
    appendedEventIds,
    applyPatchToWorkspace,
    canCompose,
    conversationId,
    finalAgentEventId,
    isSending,
    onEditMessage,
    onRetryMessage,
    onSendToolReply,
    onUseToolReply,
    settlingEventIds,
  ]);

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div
        ref={containerRef}
        data-activity-scroll-container="true"
        className="flex flex-1 flex-col-reverse overflow-y-auto px-4 py-3"
        style={{ scrollbarGutter: 'stable both-edges', overflowAnchor: isAtBottom ? 'none' : 'auto' }}
      >
        <ActivityPresence mode="wait">
          {showHistoryLoadingState ? (
            <ActivityReveal
              key="history-loading"
              className="mx-auto flex h-full w-full max-w-[720px] items-start px-4 py-3"
            >
              <p className="m-0 text-sm text-loop-500">Loading activity…</p>
            </ActivityReveal>
          ) : (
            <ActivityReveal
              key={`history-content:${conversationId}`}
            >
              <div ref={feedContentRef} className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-end">
                <div className="flex flex-col justify-end">
                  <ActivityFeedEvents
                    allowInteractiveMotion={allowInteractiveMotion}
                    eventsLength={events.length}
                    groupedEvents={groupedEvents}
                    isSending={isSending}
                    renderEventItem={renderEventItem}
                  />
                  {isSending ? <ActivitySendingStatus currentStatus={currentStatus} /> : null}
                </div>
              </div>
            </ActivityReveal>
          )}
        </ActivityPresence>
      </div>
      {!isAtBottom && events.length > 0 ? (
        <button
          type="button"
          className={`absolute left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-loop-700 bg-loop-900/95 px-3 py-1.5 text-xs font-medium text-loop-200 shadow-lg shadow-black/30 backdrop-blur transition-[background-color,border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-loop-400 hover:bg-loop-800 hover:shadow-black/45 ${isSending ? 'bottom-8' : 'bottom-4'}`}
          onClick={() => scrollToBottom('smooth')}
          aria-label="Scroll to bottom"
          style={{ transitionTimingFunction: ACTIVITY_EASE_CSS }}
        >
          <ArrowDown size={14} />
          Latest
        </button>
      ) : null}
    </section>
  );
});
