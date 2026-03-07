import { memo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ActivityEvent } from '../../types/ui';
import { shortID } from '../../utils/parsers';
import type { ActivityVisualStyle } from './ActivityItemHelpers';
import { formatActivityTime, labelFor, toolPhaseLabel } from './ActivityItemHelpers';
import { ActivityFrame, ActivityImageStrip, CopyDropdown, MarkdownBlock, PlainTextBlock } from './ActivityItemShared';
import { parseFileToolPayload } from '../tool-cards';
import { ActivityToolEventDetails } from './ActivityToolEventDetails';
import type { ActivityImageSelectHandler, ActivityToolReplyProps } from './ActivityItemTypes';

interface ActivityNonUserItemProps extends ActivityToolReplyProps {
  event: ActivityEvent;
  renderedText: string;
  isAssistant: boolean;
  isSystemEvent: boolean;
  isFinalAgent?: boolean;
  leftGutterIcon: ReactNode;
  visual: ActivityVisualStyle;
  onSelectImage: ActivityImageSelectHandler;
}

export const ActivityNonUserItem = memo(function ActivityNonUserItem({
  event,
  renderedText,
  isAssistant,
  isSystemEvent,
  isFinalAgent,
  leftGutterIcon,
  visual,
  onSelectImage,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
}: ActivityNonUserItemProps) {
  const markdownContainerRef = useRef<HTMLDivElement>(null);
  const isFileTool = !!parseFileToolPayload(event);

  return (
    <ActivityFrame
      className={`group relative px-2 py-2 ${visual.row}`}
      left={leftGutterIcon}
      contentClassName="min-w-0"
    >
      {isAssistant && isFinalAgent ? (
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyDropdown
            getMarkdown={() => renderedText}
            getText={() => markdownContainerRef.current?.innerText || renderedText}
          />
        </div>
      ) : null}

      <div className="flex min-w-0 w-full flex-col gap-0.5">
        {isSystemEvent ? (
          <div className="mb-0.5 flex items-baseline justify-between gap-3">
            <p className={`m-0 min-w-0 leading-relaxed ${isFileTool ? 'text-[13px] text-loop-400' : `text-[15px] ${visual.copy}`}`}>
              {renderedText}
            </p>
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-loop-500">
              <time className="font-medium text-loop-500">{formatActivityTime(event.timestamp)}</time>
              <span>{labelFor(event.kind)}</span>
              {event.tool?.callId ? (
                <span className="font-mono text-[10px] text-loop-500">
                  {shortID(event.tool.callId)}
                </span>
              ) : null}
              {event.tool ? (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    event.tool.success === false
                      ? 'bg-red-500/10 text-red-300'
                      : 'bg-blue-500/10 text-blue-300'
                  }`}
                >
                  {toolPhaseLabel(event)}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
            <span className="font-semibold text-loop-200">Gemini</span>
            <time className="text-[11px] font-medium text-loop-500">
              {formatActivityTime(event.timestamp)}
            </time>
          </div>
        )}

        <div ref={markdownContainerRef} className={`text-[15px] leading-relaxed ${visual.copy}`}>
          <ActivityImageStrip images={event.images || []} onSelect={onSelectImage} />
          {!isSystemEvent ? (event.streaming ? <PlainTextBlock text={renderedText} /> : <MarkdownBlock text={renderedText} />) : null}
          <ActivityToolEventDetails
            event={event}
            fallbackText={isSystemEvent ? event.body : undefined}
            patchOutputClassName="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-loop-800/90 bg-loop-900/35 px-3 py-2 text-xs leading-relaxed text-loop-300 scrollbar-thin"
            fallbackClassName={`mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-loop-800/90 px-3 py-2 text-xs leading-relaxed scrollbar-thin ${visual.detail}`}
            canCompose={canCompose}
            isSending={isSending}
            onUseToolReply={onUseToolReply}
            onSendToolReply={onSendToolReply}
            includeSystemErrorDetails
          />
          {event.streaming ? <span className="animate-pulse text-loop-500">▍</span> : null}
        </div>
      </div>
    </ActivityFrame>
  );
});
