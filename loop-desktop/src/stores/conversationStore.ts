import { create } from 'zustand';
import type { ConversationLiveState } from '../hooks/useLoopDesktop.types';
import { cloneLiveState, createDefaultLiveState } from './activityStore.helpers.ts';

export interface ConversationActivityState {
  liveState: ConversationLiveState;
  orderedEventIds: string[];
  nextSequenceNo: number;
  structureVersion: number;
  lastHydratedAt: number;
}

export interface ConversationStoreState {
  conversations: Record<string, ConversationActivityState>;
  getConversationState: (conversationId: string) => ConversationActivityState;
  setConversationIndex: (
    conversationId: string,
    orderedEventIds: string[],
    nextSequenceNo: number,
    options?: { hydratedAt?: number },
  ) => void;
  reserveSequenceNo: (conversationId: string, requested?: number) => number;
  updateLiveState: (
    conversationId: string,
    stateOrUpdater:
      | Partial<ConversationLiveState>
      | ((prev: ConversationLiveState) => Partial<ConversationLiveState>)
  ) => void;
  resetLiveState: (conversationId: string) => void;
  getLiveState: (conversationId: string) => ConversationLiveState;
  clearConversation: (conversationId: string) => void;
}

function defaultConversationState(): ConversationActivityState {
  return {
    liveState: createDefaultLiveState(),
    orderedEventIds: [],
    nextSequenceNo: 1,
    structureVersion: 0,
    lastHydratedAt: 0,
  };
}

function cloneOrderedEventIds(orderedEventIds: string[]): string[] {
  return orderedEventIds.length > 0 ? [...orderedEventIds] : [];
}

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  conversations: {},
  getConversationState: (conversationId) => get().conversations[conversationId] || defaultConversationState(),
  setConversationIndex: (conversationId, orderedEventIds, nextSequenceNo, options) =>
    set((state) => {
      const current = state.conversations[conversationId] || defaultConversationState();
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...current,
            orderedEventIds: cloneOrderedEventIds(orderedEventIds),
            nextSequenceNo,
            structureVersion: current.structureVersion + 1,
            lastHydratedAt: options?.hydratedAt ?? current.lastHydratedAt,
          },
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
            liveState: createDefaultLiveState(),
          },
        },
      };
    }),
  getLiveState: (conversationId) =>
    cloneLiveState((get().conversations[conversationId] || defaultConversationState()).liveState),
  clearConversation: (conversationId) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [conversationId]: defaultConversationState(),
      },
    })),
}));
