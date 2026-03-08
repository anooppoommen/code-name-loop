import type { ActivityGroup } from '../stores/groupStore.ts';
import type { ActivityEvent } from '../types/ui';
import {
  buildActivityRenderGroups,
  visibleEventIdsForGroup,
} from '../stores/activityStore.helpers.ts';

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
  return visibleEventIdsForGroup(group, eventsById, hideLifecycle)
    .map((eventId) => eventsById[eventId])
    .filter((event): event is ActivityEvent => !!event);
}

export function buildRenderGroups(
  groups: ActivityGroup[],
  eventsById: Record<string, ActivityEvent>,
  hideLifecycle: boolean,
  isSending: boolean,
): RenderGroup[] {
  return buildActivityRenderGroups(groups, eventsById, hideLifecycle, isSending).map((group) => ({
    ...group,
    events: group.eventIds
      .map((eventId) => eventsById[eventId])
      .filter((event): event is ActivityEvent => !!event),
  }));
}
