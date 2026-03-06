import { create } from 'zustand';
import type { ConversationLiveState } from '../hooks/useLoopDesktop.types';
import type { ActivityEvent } from '../types/ui';

export interface ConversationActivityState {
  liveState: ConversationLiveState;
  orderedEventIds: string[];
  nextSequenceNo: number;
}

export interface ConversationStoreState {
  conversations: Record<string, ConversationActivityState>;
  getConversationState: (conversationId: string) => ConversationActivityState;
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
}

const defaultLiveState = (): ConversationLiveState => ({
  draftAssistantId: null,
  draftThoughtId: null,
  lastStatus: '',
  openToolEventIDs: {},
  retryStatusEventID: null,
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

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  conversations: {},
  getConversationState: (conversationId) => get().conversations[conversationId] || defaultConversationState(),
  replaceConversationEvents: (conversationId, events) =>
    set((state) => {
      const current = state.conversations[conversationId] || defaultConversationState();
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            orderedEventIds: events.map((event) => event.id),
            nextSequenceNo: getNextSequenceNo(events),
          },
        },
      };
    }),
  setOrderedEventIds: (conversationId, orderedEventIds) =>
    set((state) => {
      const current = state.conversations[conversationId] || defaultConversationState();
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            orderedEventIds,
          },
        },
      };
    }),
  removeEventIds: (conversationId, ids) =>
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current || ids.length === 0) {
        return state;
      }
      const removals = new Set(ids);
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            orderedEventIds: current.orderedEventIds.filter((id) => !removals.has(id)),
          },
        },
      };
    }),
  clearConversation: (conversationId) =>
    set((state) => {
      const current = state.conversations[conversationId];
      if (!current) {
        return state;
      }
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: defaultConversationState(),
        },
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
            liveState: { ...current.liveState, ...updates },
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
    (get().conversations[conversationId] || defaultConversationState()).liveState,
}));
