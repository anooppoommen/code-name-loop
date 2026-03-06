import { Brain, Cog } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import type { ActivityEvent } from '../../types/ui';
import { formatActivityTime } from './ActivityItemHelpers';
import { ActivityFrame, ActivityImageStrip, MarkdownBlock } from './ActivityItemShared';
import type {
  ActivityEditMessageHandler,
  ActivityImageSelectHandler,
} from './ActivityItemTypes';
import { ActivityUserActions } from './ActivityUserActions';

interface ActivityUserItemProps {
  event: ActivityEvent;
  renderedText: string;
  userModel: string;
  userThinkingLevel: string;
  thinkingToneClass: string;
  isSending: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: ActivityEditMessageHandler;
  onSelectImage: ActivityImageSelectHandler;
}

export const ActivityUserItem = memo(function ActivityUserItem({
  event,
  renderedText,
  userModel,
  userThinkingLevel,
  thinkingToneClass,
  isSending,
  onRetryMessage,
  onEditMessage,
  onSelectImage,
}: ActivityUserItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const markdownContainerRef = useRef<HTMLDivElement>(null);

  return (
    <ActivityFrame
      className="px-2 py-3"
      right={
        <ActivityUserActions
          event={event}
          renderedText={renderedText}
          markdownContainerRef={markdownContainerRef}
          isHovered={isHovered}
          isSending={isSending}
          onRetryMessage={onRetryMessage}
          onEditMessage={onEditMessage}
        />
      }
      contentClassName="min-w-0"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="ml-auto flex max-w-[85%] flex-col rounded-2xl rounded-tr-sm bg-loop-800/80 px-5 pt-2.5 pb-3 shadow-sm">
        <ActivityImageStrip images={event.images || []} onSelect={onSelectImage} />
        <div ref={markdownContainerRef} className="text-loop-200">
          <MarkdownBlock text={renderedText} dense />
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          {userModel || userThinkingLevel ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              {userModel ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-loop-700/80 px-2 py-0.5 text-loop-300"
                  title={`Model: ${userModel}`}
                  aria-label={`Model ${userModel}`}
                >
                  <Cog size={11} />
                  <span className="max-w-[180px] truncate text-[10px] font-medium text-loop-300">
                    {userModel}
                  </span>
                </span>
              ) : null}
              {userThinkingLevel ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-loop-700/80 px-2 py-0.5"
                  title={`Thinking level: ${userThinkingLevel}`}
                  aria-label={`Thinking level ${userThinkingLevel}`}
                >
                  <Brain size={11} className={thinkingToneClass} />
                  <span className={`text-[10px] font-medium ${thinkingToneClass}`}>
                    {userThinkingLevel}
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}
          <time className="text-[10px] font-medium text-loop-500">
            {formatActivityTime(event.timestamp)}
          </time>
        </div>
      </div>
    </ActivityFrame>
  );
});
