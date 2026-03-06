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

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      const node = containerRef.current;
      if (!node) {
        return;
      }

      programmaticScrollRef.current = true;
      node.scrollTo({ top: node.scrollHeight, behavior });
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
  }, [conversationId]);

  useLayoutEffect(() => {
    if (!pendingInitialSnapRef.current) {
      return;
    }

    scrollToBottom('auto');
    if (events.length > 0) {
      pendingInitialSnapRef.current = false;
    }
  }, [events.length, scrollToBottom]);

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
          const target = fullText.length;

          let advanced = current;
          if (current < target) {
            const match = fullText.slice(current).match(/\s+/);
            if (match && match.index !== undefined) {
              advanced = current + match.index + match[0].length;
            } else {
              advanced = target;
            }
          }

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
    return (
      <div key={event.id} data-activity-event-id={event.id}>
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
      </div>
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
    visibleChars,
  ]);

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div
        ref={containerRef}
        data-activity-scroll-container="true"
        className={`flex-1 overflow-y-auto px-4 py-3 ${hasUserScrolled ? '' : 'scrollbar-hidden'}`}
      >
        <div className="mx-auto w-full max-w-[720px]">
          {events.length === 0 ? (
            <p className="m-0 px-4 py-3 text-sm text-loop-500">No run activity yet. Send a task to start streaming events.</p>
          ) : (
            groupedEvents.map((group) => {
              if (group.type === 'single') {
                return renderEventItem(group.events[0]);
              }
              return (
                <ActivityIntermediateGroup
                  key={group.id}
                  events={group.events}
                  defaultExpanded={group.defaultExpanded ?? false}
                  scrollAnchorId={group.scrollAnchorId ?? group.events[0]?.id ?? ''}
                  renderEventItem={renderEventItem}
                />
              );
            })
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
