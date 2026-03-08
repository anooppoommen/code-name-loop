import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { parseParallelToolPayload } from '../tool-cards';
import type { ToolReplyActions } from '../tool-cards';
import { textTargetForEvent } from './textTarget';
import { ActivityImageLightbox } from './ActivityItemShared';
import { iconFor, visualStyleFor } from './ActivityItemHelpers';
import { ActivityNonUserItem } from './ActivityNonUserItem';
import { ActivityParallelItem } from './ActivityParallelItem';
import { ActivityStatusItem } from './ActivityStatusItem';
import { ActivityThoughtItem } from './ActivityThoughtItem';
import { useThrottledText } from './ActivityMotion';
import { ActivityUserItem } from './ActivityUserItem';
import { useActivityEvent } from './useActivityEvent';

export interface ActivityItemProps extends ToolReplyActions {
  eventId: string;
  isFinalAgent?: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

export { ActivityFrame } from './ActivityItemShared';

export const ActivityItem = memo(function ActivityItem({
  eventId,
  isFinalAgent,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
  onRetryMessage,
  onEditMessage,
}: ActivityItemProps) {
  const event = useActivityEvent(eventId);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  if (!event) {
    return null;
  }

  const renderedText = useDeferredValue(useThrottledText(textTargetForEvent(event), !!event.streaming));
  const visual = useMemo(() => visualStyleFor(event), [event]);
  const parallelToolPayload = useMemo(() => parseParallelToolPayload(event), [event]);
  const leftGutterIcon = useMemo(() => {
    if (event.kind === 'tool' || event.kind === 'thought') {
      return null;
    }

    return <div className={visual.icon}>{iconFor(event.kind)}</div>;
  }, [event.kind, visual.icon]);

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
    return <ActivityStatusItem eventId={eventId} />;
  }

  const isUser = event.kind === 'user';

  if (event.kind === 'thought') {
    return (
      <ActivityThoughtItem
        eventId={eventId}
        renderedText={renderedText}
        leftGutterIcon={leftGutterIcon}
        visual={visual}
      />
    );
  }

  if (parallelToolPayload) {
    return (
      <ActivityParallelItem
        eventId={eventId}
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
          eventId={eventId}
          renderedText={renderedText}
          isSending={isSending}
          onRetryMessage={onRetryMessage}
          onEditMessage={onEditMessage}
          onSelectImage={setSelectedImage}
        />
      ) : (
        <ActivityNonUserItem
          eventId={eventId}
          renderedText={renderedText}
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
