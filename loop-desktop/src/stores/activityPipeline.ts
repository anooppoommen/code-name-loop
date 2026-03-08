import type { PendingCommandApproval } from '../hooks/useLoopDesktop.types.ts';
import type { ActivityEvent } from '../types/ui.ts';
import { historyRowsToActivities } from '../utils/activityTimeline.ts';
import { useConversationStore } from './conversationStore.ts';
import { useEventStore } from './eventStore.ts';
import { useGroupStore } from './groupStore.ts';
import {
  annotateActivitiesWithPendingApprovals,
  buildActivityGroups,
  eventAffectsConversationStructure,
  getNextActivitySequenceNo,
  materializeConversationEvents,
  normalizeConversationEvents,
} from './activityStore.helpers.ts';

export function getConversationEvents(conversationId: string): ActivityEvent[] {
  const conversation = useConversationStore.getState().getConversationState(conversationId);
  return materializeConversationEvents(conversation.orderedEventIds, useEventStore.getState().events);
}

export function replaceConversationEvents(
  conversationId: string,
  events: ActivityEvent[],
  options?: { hydratedAt?: number },
): ActivityEvent[] {
  const normalized = normalizeConversationEvents(conversationId, events);
  const previousIds = useConversationStore.getState().getConversationState(conversationId).orderedEventIds;

  useEventStore.getState().replaceConversationEvents(previousIds, normalized);
  useConversationStore.getState().setConversationIndex(
    conversationId,
    normalized.map((event) => event.id),
    getNextActivitySequenceNo(normalized),
    options,
  );
  useGroupStore.getState().setConversationGroups(conversationId, buildActivityGroups(normalized));

  return normalized;
}

export function upsertConversationEvent(event: ActivityEvent): void {
  const currentEvents = getConversationEvents(event.conversationId).filter((candidate) => candidate.id !== event.id);
  replaceConversationEvents(event.conversationId, [...currentEvents, event]);
}

export function updateConversationEvent(
  id: string,
  transform: (event: ActivityEvent) => ActivityEvent,
): ActivityEvent | null {
  const current = useEventStore.getState().events[id];
  if (!current) {
    return null;
  }

  const nextEvent = transform(current);
  if (!eventAffectsConversationStructure(current, nextEvent)) {
    useEventStore.getState().upsertEvent(nextEvent);
    return nextEvent;
  }

  if (nextEvent.conversationId !== current.conversationId) {
    replaceConversationEvents(
      current.conversationId,
      getConversationEvents(current.conversationId).filter((event) => event.id !== id),
    );
    replaceConversationEvents(
      nextEvent.conversationId,
      getConversationEvents(nextEvent.conversationId)
        .filter((event) => event.id !== id)
        .concat(nextEvent),
    );
    return nextEvent;
  }

  replaceConversationEvents(
    nextEvent.conversationId,
    getConversationEvents(nextEvent.conversationId)
      .filter((event) => event.id !== id)
      .concat(nextEvent),
  );
  return nextEvent;
}

export function syncConversationPendingApprovals(
  conversationId: string,
  pendingApprovals: PendingCommandApproval[],
): void {
  const currentEvents = getConversationEvents(conversationId);
  if (currentEvents.length === 0) {
    return;
  }

  const annotated = annotateActivitiesWithPendingApprovals(currentEvents, pendingApprovals);
  if (annotated === currentEvents) {
    return;
  }

  const changedEvents: ActivityEvent[] = [];
  for (let index = 0; index < annotated.length; index += 1) {
    if (annotated[index] !== currentEvents[index]) {
      changedEvents.push(annotated[index]);
    }
  }
  useEventStore.getState().upsertEvents(changedEvents);
}

export function hydrateConversationFromTimeline(
  conversationId: string,
  rows: unknown[],
  pendingApprovals: PendingCommandApproval[] = [],
): ActivityEvent[] {
  const annotated = annotateActivitiesWithPendingApprovals(historyRowsToActivities(rows), pendingApprovals);
  const normalized = replaceConversationEvents(conversationId, annotated, { hydratedAt: Date.now() });
  useConversationStore.getState().resetLiveState(conversationId);
  return normalized;
}

export function clearConversationPipeline(conversationId: string): void {
  const previousIds = useConversationStore.getState().getConversationState(conversationId).orderedEventIds;
  useEventStore.getState().removeEvents(previousIds);
  useConversationStore.getState().clearConversation(conversationId);
  useGroupStore.getState().clearConversation(conversationId);
}
