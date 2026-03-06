import type { ReactNode } from 'react';
import type { ActivityEvent } from '../../types/ui';
import type { ActivityVisualStyle } from './ActivityItemHelpers';
import { ActivityFrame, ThoughtMessage } from './ActivityItemShared';

interface ActivityThoughtItemProps {
  event: ActivityEvent;
  renderedText: string;
  leftGutterIcon: ReactNode;
  visual: ActivityVisualStyle;
}

export function ActivityThoughtItem({
  event,
  renderedText,
  leftGutterIcon,
  visual,
}: ActivityThoughtItemProps) {
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
