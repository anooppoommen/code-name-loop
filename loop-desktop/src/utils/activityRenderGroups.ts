import type { ActivityGroup } from '../stores/groupStore';
import type { ActivityEvent } from '../types/ui';

export interface RenderGroup {
  type: 'single' | 'intermediate';
  id: string;
  events: ActivityEvent[];
  defaultExpanded?: boolean;
}

export function visibleEventsForGroup(
  group: ActivityGroup,
  eventsById: Record<string, ActivityEvent>,
  hideLifecycle: boolean,
): ActivityEvent[] {
  return group.eventIds
    .map((eventId) => eventsById[eventId])
    .filter((event): event is ActivityEvent => !!event)
    .filter((event) => !hideLifecycle || event.kind !== 'lifecycle');
}

export function buildRenderGroups(
  groups: ActivityGroup[],
  eventsById: Record<string, ActivityEvent>,
  hideLifecycle: boolean,
  isSending: boolean,
): RenderGroup[] {
  const next: RenderGroup[] = [];
  const visibleGroups = groups
    .map((group) => ({ group, events: visibleEventsForGroup(group, eventsById, hideLifecycle) }))
    .filter((entry) => entry.events.length > 0);

  for (let groupIndex = 0; groupIndex < visibleGroups.length; groupIndex += 1) {
    const { group, events } = visibleGroups[groupIndex];
    const isActiveGroup = isSending && groupIndex === visibleGroups.length - 1;

    next.push({
      type: 'single',
      id: `${group.id}:head`,
      events: [events[0]],
    });

    if (events.length === 1) {
      continue;
    }

    let terminalIndex = -1;
    for (let index = events.length - 1; index >= 1; index -= 1) {
      if (events[index].kind === 'assistant') {
        terminalIndex = index;
        break;
      }
    }

    if (terminalIndex === -1) {
      const intermediate = events.slice(1);
      if (intermediate.length > 0) {
        next.push({
          type: 'intermediate',
          id: `${group.id}:intermediate`,
          events: intermediate,
          defaultExpanded: isActiveGroup,
        });
      }
      continue;
    }

    const intermediate = events.slice(1, terminalIndex);
    if (intermediate.length > 0) {
      next.push({
        type: 'intermediate',
        id: `${group.id}:intermediate`,
        events: intermediate,
        defaultExpanded: isActiveGroup,
      });
    }

    next.push({
      type: 'single',
      id: `${group.id}:terminal`,
      events: [events[terminalIndex]],
    });

    for (let index = terminalIndex + 1; index < events.length; index += 1) {
      next.push({
        type: 'single',
        id: `${group.id}:trailing:${events[index].id}`,
        events: [events[index]],
      });
    }
  }

  return next;
}
