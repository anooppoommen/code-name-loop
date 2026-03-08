import type { ConversationLiveState } from '../hooks/useLoopDesktop.types.ts';
import type { PendingCommandApproval } from '../hooks/useLoopDesktop.types.ts';
import type { ActivityEvent } from '../types/ui.ts';

export interface ActivityGroup {
  id: string;
  conversationId: string;
  headId: string;
  tailId: string;
  sequenceNo: number;
  eventIds: string[];
}

export interface ActivityRenderGroup {
  type: 'single' | 'intermediate';
  id: string;
  eventIds: string[];
  defaultExpanded?: boolean;
}

export function createDefaultLiveState(): ConversationLiveState {
  return {
    draftAssistantId: null,
    draftThoughtId: null,
    lastStatus: '',
    openToolEventIDs: {},
    retryStatusEventID: null,
    skipNextHistoryReload: false,
  };
}

export function cloneLiveState(liveState: ConversationLiveState): ConversationLiveState {
  return {
    ...liveState,
    openToolEventIDs: { ...liveState.openToolEventIDs },
  };
}

function toolNameMatches(toolName: string, canonical: string): boolean {
  return (
    toolName === canonical ||
    toolName.endsWith(`:${canonical}`) ||
    toolName.endsWith(`.${canonical}`)
  );
}

function normalizeApprovalToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (toolNameMatches(normalized, 'exec_command')) {
    return 'exec_command';
  }
  if (toolNameMatches(normalized, 'shell')) {
    return 'shell';
  }
  return normalized;
}

function buildApprovalKey(toolName: string, command: string): string {
  const normalizedCommand = command.trim();
  const normalizedToolName = normalizeApprovalToolName(toolName);
  if (!normalizedCommand || !normalizedToolName) {
    return '';
  }
  return `${normalizedToolName}::${normalizedCommand}`;
}

export function annotateActivitiesWithPendingApprovals(
  events: ActivityEvent[],
  pendingApprovals: PendingCommandApproval[],
): ActivityEvent[] {
  if (events.length === 0) {
    return events;
  }

  const pendingByKey = new Map<string, number>();
  for (const approval of pendingApprovals) {
    const key = buildApprovalKey(approval.toolName, approval.command);
    if (!key) {
      continue;
    }
    pendingByKey.set(key, (pendingByKey.get(key) ?? 0) + 1);
  }

  let changed = false;
  const waitingByEventID = new Map<string, boolean>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const tool = event.tool;
    if (!tool || tool.phase !== 'start' || !tool.command) {
      waitingByEventID.set(event.id, false);
      continue;
    }
    const key = buildApprovalKey(tool.name, tool.command);
    const remaining = key ? (pendingByKey.get(key) ?? 0) : 0;
    const isWaiting = remaining > 0;
    waitingByEventID.set(event.id, isWaiting);
    if (isWaiting && key) {
      pendingByKey.set(key, remaining - 1);
    }
  }

  const next = events.map((event) => {
    const tool = event.tool;
    if (!tool) {
      return event;
    }
    const waitingApproval = waitingByEventID.get(event.id) ?? false;
    if (Boolean(tool.waitingApproval) === waitingApproval) {
      return event;
    }
    changed = true;
    return {
      ...event,
      tool: {
        ...tool,
        waitingApproval,
      },
    };
  });

  return changed ? next : events;
}

export function getNextActivitySequenceNo(events: ActivityEvent[]): number {
  let maxSequenceNo = 0;
  for (const event of events) {
    if (Number.isFinite(event.sequenceNo)) {
      maxSequenceNo = Math.max(maxSequenceNo, event.sequenceNo);
    }
  }
  return Math.floor(maxSequenceNo) + 1;
}

export function sortActivityEvents(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((left, right) => {
    if (left.sequenceNo !== right.sequenceNo) {
      return left.sequenceNo - right.sequenceNo;
    }
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.id.localeCompare(right.id);
  });
}

export function normalizeConversationEvents(
  conversationId: string,
  events: ActivityEvent[],
): ActivityEvent[] {
  return sortActivityEvents(
    events.map((event, index) => ({
      ...event,
      conversationId,
      sequenceNo: Number.isFinite(event.sequenceNo) ? event.sequenceNo : index + 1,
    })),
  );
}

export function materializeConversationEvents(
  orderedEventIds: string[],
  eventsById: Record<string, ActivityEvent>,
): ActivityEvent[] {
  return orderedEventIds
    .map((id) => eventsById[id])
    .filter((event): event is ActivityEvent => !!event);
}

export function eventAffectsConversationStructure(current: ActivityEvent, next: ActivityEvent): boolean {
  return current.id !== next.id
    || current.conversationId !== next.conversationId
    || current.sequenceNo !== next.sequenceNo
    || current.timestamp !== next.timestamp
    || current.kind !== next.kind;
}

export function buildActivityGroups(events: ActivityEvent[]): ActivityGroup[] {
  if (events.length === 0) {
    return [];
  }

  const sorted = sortActivityEvents(events);
  const groups: ActivityGroup[] = [];
  let currentGroup: ActivityGroup | null = null;

  for (const event of sorted) {
    if (!currentGroup || event.kind === 'user') {
      currentGroup = {
        id: `${event.id}:group`,
        conversationId: event.conversationId,
        headId: event.id,
        tailId: event.id,
        sequenceNo: event.sequenceNo,
        eventIds: [event.id],
      };
      groups.push(currentGroup);
      continue;
    }

    currentGroup = {
      ...currentGroup,
      tailId: event.id,
      eventIds: [...currentGroup.eventIds, event.id],
    };
    groups[groups.length - 1] = currentGroup;
  }

  return groups;
}

export function visibleEventIdsForGroup(
  group: ActivityGroup,
  eventsById: Record<string, ActivityEvent>,
  hideLifecycle: boolean,
): string[] {
  return group.eventIds.filter((eventId) => {
    const event = eventsById[eventId];
    return !!event && (!hideLifecycle || event.kind !== 'lifecycle');
  });
}

export function buildActivityRenderGroups(
  groups: ActivityGroup[],
  eventsById: Record<string, ActivityEvent>,
  hideLifecycle: boolean,
  isSending: boolean,
): ActivityRenderGroup[] {
  const next: ActivityRenderGroup[] = [];
  const visibleGroups = groups
    .map((group) => ({ group, eventIds: visibleEventIdsForGroup(group, eventsById, hideLifecycle) }))
    .filter((entry) => entry.eventIds.length > 0);

  for (let groupIndex = 0; groupIndex < visibleGroups.length; groupIndex += 1) {
    const { group, eventIds } = visibleGroups[groupIndex];
    const isActiveGroup = isSending && groupIndex === visibleGroups.length - 1;

    next.push({
      type: 'single',
      id: `${group.id}:head`,
      eventIds: [eventIds[0]],
    });

    if (eventIds.length === 1) {
      continue;
    }

    let terminalIndex = -1;
    for (let index = eventIds.length - 1; index >= 1; index -= 1) {
      const event = eventsById[eventIds[index]];
      if (event?.kind === 'assistant') {
        terminalIndex = index;
        break;
      }
    }

    if (terminalIndex === -1) {
      const intermediate = eventIds.slice(1);
      if (intermediate.length > 0) {
        next.push({
          type: 'intermediate',
          id: `${group.id}:intermediate`,
          eventIds: intermediate,
          defaultExpanded: isActiveGroup,
        });
      }
      continue;
    }

    const intermediate = eventIds.slice(1, terminalIndex);
    if (intermediate.length > 0) {
      next.push({
        type: 'intermediate',
        id: `${group.id}:intermediate`,
        eventIds: intermediate,
        defaultExpanded: isActiveGroup,
      });
    }

    next.push({
      type: 'single',
      id: `${group.id}:terminal`,
      eventIds: [eventIds[terminalIndex]],
    });

    for (let index = terminalIndex + 1; index < eventIds.length; index += 1) {
      next.push({
        type: 'single',
        id: `${group.id}:trailing:${eventIds[index]}`,
        eventIds: [eventIds[index]],
      });
    }
  }

  return next;
}
