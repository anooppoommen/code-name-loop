import type { ActivityEvent } from '../../types/ui';
import { ActivityFrame } from './ActivityItemShared';

export function ActivityStatusItem({ event }: { event: ActivityEvent }) {
  return (
    <ActivityFrame
      className="px-2 py-0.5 text-[11px] font-normal text-loop-500 opacity-75"
      left={<span className="mt-1 h-1.5 w-1.5 rounded-full bg-loop-600" />}
      contentClassName="min-w-0"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate">{event.title}</span>
        {event.body ? <span className="truncate text-loop-600">{event.body}</span> : null}
      </div>
    </ActivityFrame>
  );
}
