import { memo, useMemo } from 'react';
import { PatchViewer } from '../PatchViewer';
import {
  CommandToolCard,
  FileToolCard,
  RequestUserInputCard,
  UpdatePlanCard,
  parseCommandToolPayload,
  parseFileToolPayload,
  parseRequestUserInputPayload,
  parseUpdatePlanPayload,
} from '../tool-cards';
import type { ActivityEvent } from '../../types/ui';
import { parseSystemErrorDetails } from './ActivityItemHelpers';
import type { ActivityToolReplyProps } from './ActivityItemTypes';
import { useActivityEvent } from './useActivityEvent';

type ActivityToolEventDetailsProps = ActivityToolReplyProps & ({
  eventId: string;
  event?: undefined;
} | {
  event: ActivityEvent;
  eventId?: undefined;
}) & {
  fallbackText?: string;
  patchOutputClassName: string;
  fallbackClassName: string;
  includeSystemErrorDetails?: boolean;
};

export const ActivityToolEventDetails = memo(function ActivityToolEventDetails({
  event: eventProp,
  eventId,
  fallbackText,
  patchOutputClassName,
  fallbackClassName,
  includeSystemErrorDetails = false,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
}: ActivityToolEventDetailsProps) {
  const storedEvent = useActivityEvent(eventId ?? '');
  const event = eventProp ?? storedEvent;
  if (!event) {
    return null;
  }

  const requestInputPayload = useMemo(() => parseRequestUserInputPayload(event), [event]);
  const updatePlanPayload = useMemo(() => parseUpdatePlanPayload(event), [event]);
  const commandToolPayload = useMemo(() => parseCommandToolPayload(event), [event]);
  const fileToolPayload = useMemo(() => parseFileToolPayload(event), [event]);
  const isPatchToolEvent =
    event.tool?.name === 'apply_patch' || event.tool?.name?.endsWith(':apply_patch');
  const systemErrorDetails = useMemo(
    () => (includeSystemErrorDetails ? parseSystemErrorDetails(event) : null),
    [event, includeSystemErrorDetails],
  );

  if (requestInputPayload) {
    return (
      <RequestUserInputCard
        payload={requestInputPayload}
        canCompose={canCompose}
        isSending={isSending}
        onUseToolReply={onUseToolReply}
        onSendToolReply={onSendToolReply}
      />
    );
  }

  if (commandToolPayload) {
    return <CommandToolCard payload={commandToolPayload} />;
  }

  if (updatePlanPayload) {
    return <UpdatePlanCard payload={updatePlanPayload} />;
  }

  if (fileToolPayload) {
    return <FileToolCard payload={fileToolPayload} />;
  }

  if (isPatchToolEvent && (event.tool?.command || event.body)) {
    return (
      <div className="space-y-2">
        {event.body &&
        (event.tool?.phase === 'result' || event.tool?.error) &&
        event.body !== event.tool?.command ? (
          <pre className={patchOutputClassName}>{event.body}</pre>
        ) : null}
        <PatchViewer patchText={event.tool?.command || event.body || ''} />
      </div>
    );
  }

  if (systemErrorDetails) {
    if (systemErrorDetails.mode === 'card') {
      return (
        <div className="mt-2 rounded-lg border border-loop-700/90 bg-loop-800/70 px-3.5 py-3">
          <p className="m-0 text-[13px] leading-relaxed text-loop-200">
            {systemErrorDetails.summary}
          </p>
          {systemErrorDetails.rows.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-md border border-loop-700/80 bg-loop-800/60">
              <dl className="grid text-[11px]">
                {systemErrorDetails.rows.map((row) => (
                  <div
                    key={`${row.label}:${row.value}`}
                    className="flex items-baseline justify-between gap-3 border-t border-loop-700/80 px-3 py-2 first:border-t-0"
                  >
                    <dt className="text-loop-400">{row.label}</dt>
                    <dd className="font-medium text-loop-200">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-loop-300">
        {systemErrorDetails.text}
      </p>
    );
  }

  return fallbackText ? <pre className={fallbackClassName}>{fallbackText}</pre> : null;
});
