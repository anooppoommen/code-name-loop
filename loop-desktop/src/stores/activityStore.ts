import { create } from 'zustand';
import type { ConversationLiveState } from '../hooks/useLoopDesktop.types';
import type { ActivityEvent } from '../types/ui';

export interface ActivityGroup {
  id: string;
  conversationId: string;
  headId: string;
  tailId: string;
  sequenceNo: number;
  eventIds: string[];
}

export interface ConversationActivityState {
  liveState: ConversationLiveState;
  orderedEventIds: string[];
  nextSequenceNo: number;
}

export interface ActivityStoreState {
  events: Record<string, ActivityEvent>;
  conversations: Record<string, ConversationActivityState>;
  groupsByConversation: Record<string, ActivityGroup[]>;
  getConversationState: (conversationId: string) => ConversationActivityState;
  getConversationEvents: (conversationId: string) => ActivityEvent[];
  replaceConversationEvents: (conversationId: string, events: ActivityEvent[]) => void;
  setOrderedEventIds: (conversationId: string, orderedEventIds: string[]) => void;
  removeEventIds: (conversationId: string, ids: string[]) => void;
  clearConversation: (conversationId: string) => void;
  reserveSequenceNo: (conversationId: string, requested?: number) => number;
  updateLiveState: (
    conversationId: string,
    stateOrUpdater:
      | Partial<ConversationLiveState>
      | ((prev: ConversationLiveState) => Partial<ConversationLiveState>)
  ) => void;
  resetLiveState: (conversationId: string) => void;
  getLiveState: (conversationId: string) => ConversationLiveState;
  rebuildConversationGroups: (conversationId: string, events?: ActivityEvent[]) => void;
  upsertEvent: (event: ActivityEvent) => void;
  upsertEvents: (events: ActivityEvent[]) => void;
  upsertConversationEvent: (event: ActivityEvent) => void;
  updateEvent: (id: string, transform: (event: ActivityEvent) => ActivityEvent) => ActivityEvent | null;
  replaceEvents: (previousIds: string[], events: ActivityEvent[]) => void;
  removeEvents: (ids: string[]) => void;
  clearEvents: () => void;
}

const EMPTY_GROUPS: ActivityGroup[] = [];

const defaultLiveState = (): ConversationLiveState => ({
  draftAssistantId: null,
  draftThoughtId: null,
  lastStatus: '',
  openToolEventIDs: {},
  retryStatusEventID: null,
  skipNextHistoryReload: false,
});

const defaultConversationState = (): ConversationActivityState => ({
  liveState: defaultLiveState(),
  orderedEventIds: [],
  nextSequenceNo: 1,
});

function getNextSequenceNo(events: ActivityEvent[]): number {
  let maxSequenceNo = 0;
  for (const event of events) {
    if (Number.isFinite(event.sequenceNo)) {
      maxSequenceNo = Math.max(maxSequenceNo, event.sequenceNo);
    }
  }
  return Math.floor(maxSequenceNo) + 1;
}

function sortEvents(events: ActivityEvent[]): ActivityEvent[] {
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

export function buildActivityGroups(events: ActivityEvent[]): ActivityGroup[] {
  if (events.length === 0) {
    return EMPTY_GROUPS;
  }

  const sorted = sortEvents(events);
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

function getConversationEventsFromState(
  state: Pick<ActivityStoreState, 'events' | 'conversations'>,
  conversationId: string,
): ActivityEvent[] {
  const orderedEventIds = state.conversations[conversationId]?.orderedEventIds ?? [];
  return orderedEventIds
    .map((id) => state.events[id])
    .filter((event): event is ActivityEvent => !!event);
}

function withConversationEvents(
  state: ActivityStoreState,
  conversationId: string,
  events: ActivityEvent[],
): Pick<ActivityStoreState, 'conversations' | 'groupsByConversation'> {
  const current = state.conversations[conversationId] || defaultConversationState();
  const normalized = sortEvents(events);
  const nextOrderedEventIds = normalized.map((event) => event.id);

  return {
    conversations: {
      ...state.conversations,
      [conversationId]: {
        ...current,
        orderedEventIds: nextOrderedEventIds,
        nextSequenceNo: getNextSequenceNo(normalized),
      },
    },
    groupsByConversation: {
      ...state.groupsByConversation,
      [conversationId]: buildActivityGroups(normalized),
    },
  };
}

function cloneLiveState(liveState: ConversationLiveState): ConversationLiveState {
  return {
    ...liveState,
    openToolEventIDs: { ...liveState.openToolEventIDs },
  };
}

export const useActivityStore = create<ActivityStoreState>((set, get) => ({
  events: {},
  conversations: {},
  groupsByConversation: {},
  getConversationState: (conversationId) => get().conversations[conversationId] || defaultConversationState(),
  getConversationEvents: (conversationId) => getConversationEventsFromState(get(), conversationId),
  replaceConversationEvents: (conversationId, events) =>
    set((state) => {
      const previousIds = state.conversations[conversationId]?.orderedEventIds ?? [];
      const nextEvents = { ...state.events };
      for (const id of previousIds) {
        delete nextEvents[id];
      }
      for (const event of events) {
        nextEvents[event.id] = event;
      }
      return {
        events: nextEvents,
        ...withConversationEvents(
          {
            ...state,
            events: nextEvents,
          },
          conversationId,
          events,
        ),
      };
    }),
  setOrderedEventIds: (conversationId, orderedEventIds) =>
    set((state) => {
      const current = state.conversations[conversationId] || defaultConversationState();
      const orderedEvents = orderedEventIds
        .map((id) => state.events[id])
        .filter((event): event is ActivityEvent => !!event);
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            orderedEventIds: orderedEvents.map((event) => event.id),
          },
        },
        groupsByConversation: {
          ...state.groupsByConversation,
          [conversationId]: buildActivityGroups(orderedEvents),
        },
      };
    }),
  removeEventIds: (conversationId, ids) =>
    set((state) => {
      if (ids.length === 0) {
        return state;
      }
      const current = state.conversations[conversationId];
      if (!current) {
        return state;
      }

      const removals = new Set(ids);
      const orderedEvents = current.orderedEventIds
        .filter((id) => !removals.has(id))
        .map((id) => state.events[id])
        .filter((event): event is ActivityEvent => !!event);

      return withConversationEvents(state, conversationId, orderedEvents);
    }),
  clearConversation: (conversationId) =>
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current) {
        return state;
      }

      const nextEvents = { ...state.events };
      for (const id of current.orderedEventIds) {
        delete nextEvents[id];
      }

      const nextGroups = { ...state.groupsByConversation };
      delete nextGroups[conversationId];

      return {
        events: nextEvents,
        conversations: {
          ...state.conversations,
          [conversationId]: defaultConversationState(),
        },
        groupsByConversation: nextGroups,
      };
    }),
  reserveSequenceNo: (conversationId, requested) => {
    const current = get().conversations[conversationId] || defaultConversationState();
    if (Number.isFinite(requested)) {
      const explicit = requested!;
      const nextSequenceNo = Math.max(current.nextSequenceNo, Math.floor(explicit) + 1);
      set((state) => ({
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...(state.conversations[conversationId] || defaultConversationState()),
            nextSequenceNo,
          },
        },
      }));
      return explicit;
    }

    const reserved = current.nextSequenceNo;
    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...(state.conversations[conversationId] || defaultConversationState()),
          nextSequenceNo: reserved + 1,
        },
      },
    }));
    return reserved;
  },
  updateLiveState: (conversationId, stateOrUpdater) =>
    set((state) => {
      const current = state.conversations[conversationId] || defaultConversationState();
      const updates =
        typeof stateOrUpdater === 'function'
          ? stateOrUpdater(current.liveState)
          : stateOrUpdater;
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            liveState: {
              ...current.liveState,
              ...updates,
              openToolEventIDs: updates.openToolEventIDs
                ? { ...updates.openToolEventIDs }
                : current.liveState.openToolEventIDs,
            },
          },
        },
      };
    }),
  resetLiveState: (conversationId) =>
    set((state) => {
      const current = state.conversations[conversationId] || defaultConversationState();
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            liveState: defaultLiveState(),
          },
        },
      };
    }),
  getLiveState: (conversationId) =>
    cloneLiveState((get().conversations[conversationId] || defaultConversationState()).liveState),
  rebuildConversationGroups: (conversationId, events) =>
    set((state) => {
      const orderedEvents = events ?? getConversationEventsFromState(state, conversationId);
      return {
        groupsByConversation: {
          ...state.groupsByConversation,
          [conversationId]: buildActivityGroups(orderedEvents),
        },
      };
    }),
  upsertEvent: (event) =>
    set((state) => ({
      events: {
        ...state.events,
        [event.id]: event,
      },
    })),
  upsertEvents: (events) =>
    set((state) => {
      const next = { ...state.events };
      for (const event of events) {
        next[event.id] = event;
      }
      return { events: next };
    }),
  upsertConversationEvent: (event) =>
    set((state) => {
      const nextEvents = {
        ...state.events,
        [event.id]: event,
      };
      const currentEvents = getConversationEventsFromState(
        {
          ...state,
          events: nextEvents,
        },
        event.conversationId,
      ).filter((candidate) => candidate.id !== event.id);
      const nextConversationEvents = [...currentEvents, event];
      return {
        events: nextEvents,
        ...withConversationEvents(
          {
            ...state,
            events: nextEvents,
          },
          event.conversationId,
          nextConversationEvents,
        ),
      };
    }),
  updateEvent: (id, transform) => {
    const current = get().events[id];
    if (!current) {
      return null;
    }

    const nextEvent = transform(current);
    set((state) => {
      const nextEvents = {
        ...state.events,
        [id]: nextEvent,
      };

      if (nextEvent.conversationId !== current.conversationId) {
        const oldConversationEvents = getConversationEventsFromState(
          {
            ...state,
            events: nextEvents,
          },
          current.conversationId,
        ).filter((event) => event.id !== id);
        const newConversationEvents = [
          ...getConversationEventsFromState(
            {
              ...state,
              events: nextEvents,
            },
            nextEvent.conversationId,
          ).filter((event) => event.id !== id),
          nextEvent,
        ];

        const oldConversationState = withConversationEvents(
          {
            ...state,
            events: nextEvents,
          },
          current.conversationId,
          oldConversationEvents,
        );
        const newConversationState = withConversationEvents(
          {
            ...state,
            events: nextEvents,
            conversations: oldConversationState.conversations,
            groupsByConversation: oldConversationState.groupsByConversation,
          } as ActivityStoreState,
          nextEvent.conversationId,
          newConversationEvents,
        );

        return {
          events: nextEvents,
          conversations: newConversationState.conversations,
          groupsByConversation: newConversationState.groupsByConversation,
        };
      }

      const conversationEvents = getConversationEventsFromState(
        {
          ...state,
          events: nextEvents,
        },
        nextEvent.conversationId,
      )
        .filter((event) => event.id !== id)
        .concat(nextEvent);

      return {
        events: nextEvents,
        ...withConversationEvents(
          {
            ...state,
            events: nextEvents,
          },
          nextEvent.conversationId,
          conversationEvents,
        ),
      };
    });

    return nextEvent;
  },
  replaceEvents: (previousIds, events) =>
    set((state) => {
      const next = { ...state.events };
      for (const id of previousIds) {
        delete next[id];
      }
      for (const event of events) {
        next[event.id] = event;
      }
      return { events: next };
    }),
  removeEvents: (ids) =>
    set((state) => {
      if (ids.length === 0) {
        return state;
      }

      const removals = new Set(ids);
      const nextEvents = { ...state.events };
      for (const id of ids) {
        delete nextEvents[id];
      }

      const nextConversations = { ...state.conversations };
      const nextGroups = { ...state.groupsByConversation };

      for (const [conversationId, conversationState] of Object.entries(state.conversations)) {
        const orderedEventIds = conversationState.orderedEventIds.filter((id) => !removals.has(id));
        if (orderedEventIds.length === conversationState.orderedEventIds.length) {
          continue;
        }
        const orderedEvents = orderedEventIds
          .map((id) => nextEvents[id])
          .filter((event): event is ActivityEvent => !!event);
        nextConversations[conversationId] = {
          ...conversationState,
          orderedEventIds,
          nextSequenceNo: getNextSequenceNo(orderedEvents),
        };
        if (orderedEvents.length > 0) {
          nextGroups[conversationId] = buildActivityGroups(orderedEvents);
        } else {
          delete nextGroups[conversationId];
        }
      }

      return {
        events: nextEvents,
        conversations: nextConversations,
        groupsByConversation: nextGroups,
      };
    }),
  clearEvents: () => set({ events: {}, groupsByConversation: {} }),
}));
