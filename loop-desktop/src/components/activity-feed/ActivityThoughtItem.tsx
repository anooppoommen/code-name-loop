import type { ReactNode } from 'react';
import type { ActivityVisualStyle } from './ActivityItemHelpers';
import { ActivityFrame, ThoughtMessage } from './ActivityItemShared';
import { useActivityEvent } from './useActivityEvent';

interface ActivityThoughtItemProps {
  eventId: string;
  renderedText: string;
  leftGutterIcon: ReactNode;
  visual: ActivityVisualStyle;
}

export function ActivityThoughtItem({
  eventId,
  renderedText,
  leftGutterIcon,
  visual,
}: ActivityThoughtItemProps) {
  const event = useActivityEvent(eventId);
  if (!event) {
    return null;
  }

  return (
    <ActivityFrame
      className={`group px-2 py-1.5 ${visual.row}`}
      left={leftGutterIcon}
      contentClassName="min-w-0"
    >
      <ThoughtMessage renderedText={renderedText} isStreaming={!!event.streaming} />
    </ActivityFrame>
  );
}
