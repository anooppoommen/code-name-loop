import { memo, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
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
import { ActivityUserItem } from './ActivityUserItem';

export interface ActivityItemProps extends ToolReplyActions {
  event: ActivityEvent;
  isFinalAgent?: boolean;
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

export { ActivityFrame } from './ActivityItemShared';

const CHARS_PER_MS = 0.28;

function useRenderedText(event: ActivityEvent): string {
  const prefersReducedMotion = useReducedMotion();
  const fullText = textTargetForEvent(event);
  const shouldAnimate = event.streaming && (event.kind === 'assistant' || event.kind === 'thought') && !prefersReducedMotion;
  const [visibleChars, setVisibleChars] = useState(() => (shouldAnimate ? 0 : fullText.length));
  const previousEventIdRef = useRef(event.id);

  useEffect(() => {
    if (previousEventIdRef.current !== event.id) {
      previousEventIdRef.current = event.id;
      setVisibleChars(shouldAnimate ? 0 : fullText.length);
      return;
    }

    if (!shouldAnimate) {
      setVisibleChars((current) => (current === fullText.length ? current : fullText.length));
      return;
    }

    setVisibleChars((current) => Math.min(current, fullText.length));
  }, [event.id, fullText.length, shouldAnimate]);

  useEffect(() => {
    if (!shouldAnimate || visibleChars >= fullText.length) {
      return;
    }

    let rafId = 0;
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

      setVisibleChars((current) => {
        if (current >= fullText.length) {
          return current;
        }
        return Math.min(fullText.length, current + charsToAdvance);
      });

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [fullText.length, shouldAnimate, visibleChars]);

  return fullText.slice(0, visibleChars);
}

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
  const renderedText = useRenderedText(event);

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
