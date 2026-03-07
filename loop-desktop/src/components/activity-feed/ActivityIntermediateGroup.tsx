import { FoldVertical, UnfoldVertical } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ActivityFrame } from "./ActivityItem";
import type { ActivityEvent } from "../../types/ui";

interface ActivityIntermediateGroupProps {
  events: ActivityEvent[];
  defaultExpanded: boolean;
  scrollAnchorId: string;
  renderEventItem: (event: ActivityEvent) => ReactElement | null;
}

export const ActivityIntermediateGroup = memo(
  function ActivityIntermediateGroup({
    events,
    defaultExpanded,
    scrollAnchorId,
    renderEventItem,
  }: ActivityIntermediateGroupProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const groupRef = useRef<HTMLDivElement>(null);
    const pendingCollapseScrollRef = useRef(false);

    useEffect(() => {
      if (defaultExpanded) {
        setIsExpanded(true);
      }
    }, [defaultExpanded]);

    const scrollGroupToTop = useCallback(() => {
      const groupNode = groupRef.current;
      if (!groupNode) {
        return;
      }

      const anchorNode = document.querySelector<HTMLElement>(
        `[data-activity-event-id="${scrollAnchorId}"]`,
      );
      if (!anchorNode) {
        groupNode.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }

      const scrollContainer = groupNode.closest<HTMLElement>(
        '[data-activity-scroll-container="true"]',
      );
      if (!scrollContainer) {
        anchorNode.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }

      const containerRect = scrollContainer.getBoundingClientRect();
      const anchorRect = anchorNode.getBoundingClientRect();
      const targetTop =
        scrollContainer.scrollTop + (anchorRect.top - containerRect.top);
      scrollContainer.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth",
      });
    }, [scrollAnchorId]);

    const handleToggle = useCallback(() => {
      setIsExpanded((current) => {
        const nextExpanded = !current;
        if (!nextExpanded) {
          pendingCollapseScrollRef.current = true;
        }
        return nextExpanded;
      });
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
      <motion.div
        ref={groupRef}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="group/intermediate relative my-1"
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-20 px-2">
          <div className="grid h-full grid-cols-[48px_minmax(0,1fr)_48px] gap-0">
            <div className="flex justify-end pr-3">
              <div className="pointer-events-auto sticky top-3 flex h-fit pt-1">
                <button
                  type="button"
                  onClick={handleToggle}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-loop-700/60 bg-loop-800 text-loop-300 shadow-lg shadow-black/25 backdrop-blur transition-all hover:border-loop-500 hover:bg-loop-800 hover:text-loop-100"
                  title={buttonLabel}
                  aria-label={buttonLabel}
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

        <AnimatePresence
          initial={false}
          onExitComplete={() => {
            if (pendingCollapseScrollRef.current) {
              pendingCollapseScrollRef.current = false;
              scrollGroupToTop();
            }
          }}
        >
          {!isExpanded ? (
            <motion.div
              key="summary"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              <ActivityFrame className="px-2 py-1" contentClassName="min-w-0">
                <div className="rounded-xl border border-loop-800 bg-loop-900/45 px-3 py-2 text-[11px] font-medium text-loop-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                  {summaryText}
                </div>
              </ActivityFrame>
            </motion.div>
          ) : (
            <motion.div
              key="content"
              initial={{ opacity: 0, y: 8, gridTemplateRows: "0fr" }}
              animate={{ opacity: 1, y: 0, gridTemplateRows: "1fr" }}
              exit={{ opacity: 0, y: -6, gridTemplateRows: "0fr" }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="grid overflow-hidden"
            >
              <div className="min-h-0">
                <div className="flex flex-col gap-0 pb-1">
                  {events.map((event) => renderEventItem(event))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  },
);
