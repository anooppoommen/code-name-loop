import { FoldVertical, UnfoldVertical } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ActivityFrame } from './ActivityItem';
import {
  ActivityCollapsible,
  ACTIVITY_EASE_CSS,
  ACTIVITY_TRANSITIONS,
  ActivityEntry,
  ActivityPresence,
} from './ActivityMotion';
import type { ActivityEvent } from '../../types/ui';

interface ActivityIntermediateGroupProps {
  events: ActivityEvent[];
  defaultExpanded: boolean;
  disableInitialMotion: boolean;
  animate: boolean;
  renderEventItem: (event: ActivityEvent) => ReactElement | null;
}

export const ActivityIntermediateGroup = memo(
  function ActivityIntermediateGroup({
    events,
    defaultExpanded,
    disableInitialMotion,
    animate,
    renderEventItem,
  }: ActivityIntermediateGroupProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const groupRef = useRef<HTMLDivElement>(null);
    const toggleButtonRef = useRef<HTMLButtonElement>(null);
    const expandAnchorTopRef = useRef<number | null>(null);
    const preserveAnchorFrameRef = useRef<number | null>(null);
    const clearManualHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const canAnimate = animate;

    useEffect(() => {
      if (defaultExpanded) {
        setIsExpanded(true);
      }
    }, [defaultExpanded]);

    const getScrollContainer = useCallback(() => {
      return groupRef.current?.closest<HTMLElement>(
        '[data-activity-scroll-container="true"]',
      ) ?? null;
    }, []);

    const holdManualAnchor = useCallback((durationMs: number) => {
      const scrollContainer = getScrollContainer();
      if (!scrollContainer) {
        return;
      }

      scrollContainer.dataset.activityManualAnchorUntil = String(Date.now() + durationMs);
      if (clearManualHoldTimeoutRef.current) {
        clearTimeout(clearManualHoldTimeoutRef.current);
      }
      clearManualHoldTimeoutRef.current = setTimeout(() => {
        const holdUntil = Number(scrollContainer.dataset.activityManualAnchorUntil ?? "0");
        if (holdUntil <= Date.now()) {
          delete scrollContainer.dataset.activityManualAnchorUntil;
        }
        clearManualHoldTimeoutRef.current = null;
      }, durationMs + 32);
    }, [getScrollContainer]);

    const handleToggle = useCallback(() => {
      setIsExpanded((current) => {
        const nextExpanded = !current;
        // Record the button position BEFORE the state change so we can
        // preserve it during both expansion AND collapse animations.
        expandAnchorTopRef.current =
          toggleButtonRef.current?.getBoundingClientRect().top ?? null;
        return nextExpanded;
      });
    }, []);

    useLayoutEffect(() => {
      // Cancel any in-flight anchor frame first.
      if (preserveAnchorFrameRef.current !== null) {
        window.cancelAnimationFrame(preserveAnchorFrameRef.current);
        preserveAnchorFrameRef.current = null;
      }

      // Anchor is set for both expand and collapse in handleToggle.
      const anchorTop = expandAnchorTopRef.current;
      const toggleButton = toggleButtonRef.current;
      const scrollContainer = getScrollContainer();
      if (anchorTop === null || !toggleButton || !scrollContainer) {
        return;
      }

      // Hold off the feed's ResizeObserver auto-scroll while we
      // manually keep the toggle button in the same visual position.
      const preserveUntil = Date.now() + 340;
      holdManualAnchor(340);

      const preserveAnchor = () => {
        const delta = toggleButton.getBoundingClientRect().top - anchorTop;
        if (Math.abs(delta) > 0.5) {
          scrollContainer.scrollBy({ top: delta, behavior: 'auto' });
        }

        if (Date.now() < preserveUntil) {
          preserveAnchorFrameRef.current = window.requestAnimationFrame(preserveAnchor);
          return;
        }

        expandAnchorTopRef.current = null;
        preserveAnchorFrameRef.current = null;
      };

      preserveAnchorFrameRef.current = window.requestAnimationFrame(preserveAnchor);

      return () => {
        if (preserveAnchorFrameRef.current !== null) {
          window.cancelAnimationFrame(preserveAnchorFrameRef.current);
          preserveAnchorFrameRef.current = null;
        }
      };
    }, [getScrollContainer, holdManualAnchor, isExpanded]);

    useEffect(() => {
      return () => {
        if (preserveAnchorFrameRef.current !== null) {
          window.cancelAnimationFrame(preserveAnchorFrameRef.current);
        }
        if (clearManualHoldTimeoutRef.current) {
          clearTimeout(clearManualHoldTimeoutRef.current);
        }
      };
    }, []);

    const toolCount = events.filter((e) => e.kind === "tool").length;
    const thoughtCount = events.filter((e) => e.kind === "thought").length;
    const summaryParts: string[] = [];
    if (thoughtCount > 0)
      summaryParts.push(
        `${thoughtCount} thought${thoughtCount > 1 ? "s" : ""}`,
      );
    if (toolCount > 0)
      summaryParts.push(`${toolCount} tool call${toolCount > 1 ? "s" : ""}`);
    const nonToolThoughtCount = events.length - toolCount - thoughtCount;
    if (nonToolThoughtCount > 0) {
      summaryParts.push(
        `${nonToolThoughtCount} other event${nonToolThoughtCount > 1 ? "s" : ""}`,
      );
    }

    const summaryText =
      summaryParts.join(", ") ||
      `${events.length} item${events.length > 1 ? "s" : ""}`;
    const buttonLabel = isExpanded
      ? "Fold intermediate steps"
      : `Show ${summaryText}`;

    return (
      <div ref={groupRef} className="group/intermediate relative my-1">
        <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-20 px-2">
          <div className="grid h-full grid-cols-[48px_minmax(0,1fr)_48px] gap-0">
            <div className="flex justify-end pr-3">
              <div className="pointer-events-auto sticky top-3 flex h-fit pt-1">
                <button
                  ref={toggleButtonRef}
                  type="button"
                  onClick={handleToggle}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-loop-700/60 bg-loop-800 text-loop-300 shadow-lg shadow-black/25 backdrop-blur transition-all hover:border-loop-500 hover:bg-loop-800 hover:text-loop-100"
                  title={buttonLabel}
                  aria-label={buttonLabel}
                  style={{ transitionTimingFunction: ACTIVITY_EASE_CSS }}
                >
                  {isExpanded ? (
                    <FoldVertical size={14} />
                  ) : (
                    <UnfoldVertical size={14} />
                  )}
                </button>
              </div>
            </div>
            <div />
            <div />
          </div>
        </div>

        {!animate ? (
          !isExpanded ? (
            <div>
              <ActivityFrame className="px-2 py-1" contentClassName="min-w-0">
                <div className="rounded-xl border border-loop-800 bg-loop-900/45 px-3 py-2 text-[11px] font-medium text-loop-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                  {summaryText}
                </div>
              </ActivityFrame>
            </div>
          ) : (
            <div className="grid overflow-hidden">
              <div className="min-h-0">
                <div className="flex flex-col gap-0 pb-1">
                  {events.map((event) => renderEventItem(event))}
                </div>
              </div>
            </div>
          )
        ) : (
          <>
            <ActivityPresence mode="sync">
              {!isExpanded ? (
                <ActivityEntry
                  key="summary"
                  animate={canAnimate}
                  disableInitialAnimation={disableInitialMotion}
                  distance={4}
                  exitDistance={-3}
                  transition={ACTIVITY_TRANSITIONS.panel}
                >
                  <ActivityFrame className="px-2 py-1" contentClassName="min-w-0">
                    <div className="rounded-xl border border-loop-800 bg-loop-900/45 px-3 py-2 text-[11px] font-medium text-loop-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                      {summaryText}
                    </div>
                  </ActivityFrame>
                </ActivityEntry>
              ) : null}
            </ActivityPresence>

            <ActivityCollapsible
              open={isExpanded}
              animate={canAnimate}
              fade={false}
              watch={isExpanded}
              disableInitialAnimation={disableInitialMotion}
            >
              <div className="flex min-h-0 flex-col gap-0 pb-1">
                {events.map((event) => renderEventItem(event))}
              </div>
            </ActivityCollapsible>
          </>
        )}
      </div>
    );
  },
);
