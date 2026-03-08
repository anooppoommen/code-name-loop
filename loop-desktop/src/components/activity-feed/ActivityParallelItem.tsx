import type { ReactNode } from 'react';
import type { ParallelToolPayload } from '../tool-cards/types';
import type { ActivityEvent } from '../../types/ui';
import { parseToolCommand } from '../../utils/activityTimeline';
import type { ActivityVisualStyle } from './ActivityItemHelpers';
import { ActivityFrame } from './ActivityItemShared';
import { ActivityToolEventDetails } from './ActivityToolEventDetails';
import type { ActivityToolReplyProps } from './ActivityItemTypes';
import { textTargetForEvent } from './textTarget';
import { useActivityEvent } from './useActivityEvent';

interface ActivityParallelItemProps extends ActivityToolReplyProps {
  eventId: string;
  payload: ParallelToolPayload;
  leftGutterIcon: ReactNode;
  visual: ActivityVisualStyle;
}

export function ActivityParallelItem({
  eventId,
  payload,
  leftGutterIcon,
  visual,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
}: ActivityParallelItemProps) {
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
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-2 text-[12px] font-medium text-loop-500">
          Executing {payload.results.length} tool{payload.results.length === 1 ? '' : 's'}
        </div>
        <div className="relative flex flex-col gap-1.5 before:absolute before:inset-y-2 before:left-2 before:w-px before:bg-loop-800/80">
          {payload.results.map((result, idx) => {
            const nestedEvent = buildParallelNestedEvent(event, idx, result);

            return (
              <div key={nestedEvent.id} className="py-1 pl-6">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-loop-500">
                  <span>{nestedEvent.tool?.name || 'tool'}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      nestedEvent.tool?.success === false
                        ? 'bg-red-500/10 text-red-300'
                        : 'bg-blue-500/10 text-blue-300'
                    }`}
                  >
                    {nestedEvent.tool?.success === false ? 'failed' : 'completed'}
                  </span>
                </div>

                <ActivityToolEventDetails
                  event={nestedEvent}
                  fallbackText={textTargetForEvent(nestedEvent)}
                  patchOutputClassName="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-loop-900/35 px-3 py-2 text-xs leading-relaxed text-loop-300 scrollbar-thin"
                  fallbackClassName="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-loop-900/35 px-3 py-2 text-xs leading-relaxed text-loop-300 scrollbar-thin"
                  canCompose={canCompose}
                  isSending={isSending}
                  onUseToolReply={onUseToolReply}
                  onSendToolReply={onSendToolReply}
                />
              </div>
            );
          })}
        </div>
      </div>
    </ActivityFrame>
  );
}

function buildParallelNestedEvent(
  event: ActivityEvent,
  idx: number,
  result: ParallelToolPayload['results'][number],
): ActivityEvent {
  const argsStr = result.arguments ? JSON.stringify(result.arguments) : '';
  const command = parseToolCommand(result.name, argsStr);

  let bodyText = '';
  if (result.response) {
    if ('output' in result.response && result.response.output !== undefined) {
      bodyText = String(result.response.output);
    } else {
      bodyText = JSON.stringify(result.response, null, 2);
    }
  } else if (result.error) {
    bodyText = result.error;
  }

  return {
    id: `${event.id}-inner-${idx}`,
    conversationId: event.conversationId,
    sequenceNo: event.sequenceNo + (idx + 1) / 1000,
    timelineSeq: event.timelineSeq,
    kind: 'tool',
    timestamp: event.timestamp + idx,
    title: `${result.name} ${result.success ? 'completed' : 'failed'}`,
    body: bodyText,
    tool: {
      name: result.name,
      phase: 'result',
      success: result.success,
      error: result.error || undefined,
      command: command || undefined,
      args: result.arguments || undefined,
      payload: result.response || undefined,
    },
  };
}
