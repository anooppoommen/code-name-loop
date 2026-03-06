import { create } from 'zustand';
import type { ActivityEvent } from '../types/ui';

export interface ActivityGroup {
  id: string;
  conversationId: string;
  headId: string;
  tailId: string;
  sequenceNo: number;
  eventIds: string[];
}

export interface GroupStoreState {
  groupsByConversation: Record<string, ActivityGroup[]>;
  rebuildConversationGroups: (conversationId: string, events: ActivityEvent[]) => void;
  clearConversation: (conversationId: string) => void;
}

export function buildActivityGroups(events: ActivityEvent[]): ActivityGroup[] {
  if (events.length === 0) {
    return [];
  }

  const sorted = [...events].sort((left, right) => {
    if (left.sequenceNo !== right.sequenceNo) {
      return left.sequenceNo - right.sequenceNo;
    }
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.id.localeCompare(right.id);
  });

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

export const useGroupStore = create<GroupStoreState>((set) => ({
  groupsByConversation: {},
  rebuildConversationGroups: (conversationId, events) =>
    set((state) => ({
      groupsByConversation: {
        ...state.groupsByConversation,
        [conversationId]: buildActivityGroups(events),
      },
    })),
  clearConversation: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.groupsByConversation)) {
        return state;
      }
      const next = { ...state.groupsByConversation };
      delete next[conversationId];
      return { groupsByConversation: next };
    }),
}));
