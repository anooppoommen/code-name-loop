import { create } from 'zustand';
import { useConversationStore } from './conversationStore.ts';
import { useEventStore } from './eventStore.ts';
import {
  type ActivityGroup,
  type ActivityRenderGroup,
  buildActivityRenderGroups,
  visibleEventIdsForGroup,
} from './activityStore.helpers.ts';

export { type ActivityGroup, buildActivityGroups } from './activityStore.helpers.ts';

const renderGroupCache = new Map<string, ActivityRenderGroup[]>();
const visibleEventIdsCache = new Map<string, string[]>();
const timelineEventIdsCache = new Map<string, string[]>();

function clearConversationCaches(conversationId: string): void {
  for (const key of Array.from(renderGroupCache.keys())) {
    if (key.startsWith(`${conversationId}:`)) {
      renderGroupCache.delete(key);
    }
  }
  for (const key of Array.from(visibleEventIdsCache.keys())) {
    if (key.startsWith(`${conversationId}:`)) {
      visibleEventIdsCache.delete(key);
    }
  }
  timelineEventIdsCache.delete(conversationId);
}

function flattenTimelineEventIds(groups: ActivityGroup[]): string[] {
  const next: string[] = [];
  for (const group of groups) {
    next.push(...group.eventIds);
  }
  return next;
}

export interface GroupStoreState {
  groupsByConversation: Record<string, ActivityGroup[]>;
  getConversationGroups: (conversationId: string) => ActivityGroup[];
  setConversationGroups: (conversationId: string, groups: ActivityGroup[]) => void;
  clearConversation: (conversationId: string) => void;
  getTimelineEventIds: (conversationId: string) => string[];
  getVisibleEventIds: (conversationId: string, hideLifecycle: boolean) => string[];
  getRenderGroups: (conversationId: string, hideLifecycle: boolean, isSending: boolean) => ActivityRenderGroup[];
}

export const useGroupStore = create<GroupStoreState>((set, get) => ({
  groupsByConversation: {},
  getConversationGroups: (conversationId) => get().groupsByConversation[conversationId] ?? [],
  setConversationGroups: (conversationId, groups) =>
    set((state) => {
      clearConversationCaches(conversationId);
      return {
        groupsByConversation: {
          ...state.groupsByConversation,
          [conversationId]: groups,
        },
      };
    }),
  clearConversation: (conversationId) =>
    set((state) => {
      clearConversationCaches(conversationId);
      const nextGroups = { ...state.groupsByConversation };
      delete nextGroups[conversationId];
      return { groupsByConversation: nextGroups };
    }),
  getTimelineEventIds: (conversationId) => {
    const cached = timelineEventIdsCache.get(conversationId);
    if (cached) {
      return cached;
    }
    const groups = get().groupsByConversation[conversationId] ?? [];
    const next = flattenTimelineEventIds(groups);
    timelineEventIdsCache.set(conversationId, next);
    return next;
  },
  getVisibleEventIds: (conversationId, hideLifecycle) => {
    const structureVersion = useConversationStore.getState().getConversationState(conversationId).structureVersion;
    const cacheKey = `${conversationId}:visible:${hideLifecycle ? 1 : 0}:${structureVersion}`;
    const cached = visibleEventIdsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const groups = get().groupsByConversation[conversationId] ?? [];
    const eventsById = useEventStore.getState().events;
    const next: string[] = [];
    for (const group of groups) {
      next.push(...visibleEventIdsForGroup(group, eventsById, hideLifecycle));
    }
    visibleEventIdsCache.set(cacheKey, next);
    return next;
  },
  getRenderGroups: (conversationId, hideLifecycle, isSending) => {
    const structureVersion = useConversationStore.getState().getConversationState(conversationId).structureVersion;
    const cacheKey = `${conversationId}:render:${hideLifecycle ? 1 : 0}:${isSending ? 1 : 0}:${structureVersion}`;
    const cached = renderGroupCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const groups = get().groupsByConversation[conversationId] ?? [];
    const next = buildActivityRenderGroups(groups, useEventStore.getState().events, hideLifecycle, isSending);
    renderGroupCache.set(cacheKey, next);
    return next;
  },
}));
