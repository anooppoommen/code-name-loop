import { memo, useDeferredValue, useEffect, useState } from 'react';
import { parseParallelToolPayload } from '../tool-cards';
import type { ToolReplyActions } from '../tool-cards';
import type { ActivityEvent } from '../../types/ui';
import { textTargetForEvent } from './textTarget';
import { ActivityImageLightbox } from './ActivityItemShared';
import { iconFor, userThinkingToneClass, visualStyleFor } from './ActivityItemHelpers';
import { ActivityNonUserItem } from './ActivityNonUserItem';
import { ActivityParallelItem } from './ActivityParallelItem';
import { ActivityStatusItem } from './ActivityStatusItem';
import { ActivityThoughtItem } from './ActivityThoughtItem';
import { useThrottledText } from './ActivityMotion';
import { ActivityUserItem } from './ActivityUserItem';

export interface ActivityItemProps extends ToolReplyActions {
  event: ActivityEvent;
  isFinalAgent?: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

export { ActivityFrame } from './ActivityItemShared';

export const ActivityItem = memo(function ActivityItem({
  event,
  isFinalAgent,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
  onRetryMessage,
  onEditMessage,
}: ActivityItemProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const icon = iconFor(event.kind);
  const userModel = event.userTurn?.model?.trim() || '';
  const userThinkingLevel = event.userTurn?.thinkingLevel?.trim() || '';
  const thinkingToneClass = userThinkingToneClass(userThinkingLevel);
  const renderedText = useDeferredValue(useThrottledText(textTargetForEvent(event), !!event.streaming));

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedImage) {
        setSelectedImage(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedImage]);

  if (event.kind === 'status') {
    return <ActivityStatusItem event={event} />;
  }

  const visual = visualStyleFor(event);
  const isUser = event.kind === 'user';
  const isAsst = event.kind === 'assistant';
  const isSystemEvent = !isUser && !isAsst;
  const parallelToolPayload = parseParallelToolPayload(event);
  const leftGutterIcon =
    event.kind === 'tool' || event.kind === 'thought'
      ? null
      : <div className={visual.icon}>{icon}</div>;

  if (event.kind === 'thought') {
    return (
      <ActivityThoughtItem
        event={event}
        renderedText={renderedText}
        leftGutterIcon={leftGutterIcon}
        visual={visual}
      />
    );
  }

  if (parallelToolPayload) {
    return (
      <ActivityParallelItem
        event={event}
        payload={parallelToolPayload}
        leftGutterIcon={leftGutterIcon}
        visual={visual}
        canCompose={canCompose}
        isSending={isSending}
        onUseToolReply={onUseToolReply}
        onSendToolReply={onSendToolReply}
      />
    );
  }

  return (
    <>
      {isUser ? (
        <ActivityUserItem
          event={event}
          renderedText={renderedText}
          userModel={userModel}
          userThinkingLevel={userThinkingLevel}
          thinkingToneClass={thinkingToneClass}
          isSending={isSending}
          onRetryMessage={onRetryMessage}
          onEditMessage={onEditMessage}
          onSelectImage={setSelectedImage}
        />
      ) : (
        <ActivityNonUserItem
          event={event}
          renderedText={renderedText}
          isAssistant={isAsst}
          isSystemEvent={isSystemEvent}
          isFinalAgent={isFinalAgent}
          leftGutterIcon={leftGutterIcon}
          visual={visual}
          onSelectImage={setSelectedImage}
          canCompose={canCompose}
          isSending={isSending}
          onUseToolReply={onUseToolReply}
          onSendToolReply={onSendToolReply}
        />
      )}

      <ActivityImageLightbox selectedImage={selectedImage} onClose={() => setSelectedImage(null)} />
    </>
  );
});
