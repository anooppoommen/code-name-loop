import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { ComposerImage, QueuedMessage } from '../hooks/useLoopDesktop.types';

interface ComposerDraftStoreState {
  composerInputs: Record<string, string>;
  composerImagesMap: Record<string, ComposerImage[]>;
  queuedMessagesMap: Record<string, QueuedMessage[]>;
  editingMessageByConversation: Record<string, string>;
  setMessageInput: (conversationId: string, value: SetStateAction<string>) => void;
  setComposerImages: (conversationId: string, value: SetStateAction<ComposerImage[]>) => void;
  clearComposerDraft: (conversationId: string) => void;
  setEditingMessage: (conversationId: string, messageId: string) => void;
  clearEditingMessage: (conversationId: string) => void;
  enqueueConversationMessage: (
    conversationId: string,
    messageText: string,
    messageImages: ComposerImage[],
  ) => boolean;
  queueDraftMessage: (conversationId: string) => boolean;
  dequeueQueuedMessage: (conversationId: string) => QueuedMessage | null;
  removeQueuedMessage: (conversationId: string, id: string) => void;
  reorderQueuedMessage: (conversationId: string, id: string, direction: 'up' | 'down') => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_IMAGES: ComposerImage[] = [];

function applyStateAction<T>(previous: T, value: SetStateAction<T>): T {
  return typeof value === 'function' ? (value as (prevState: T) => T)(previous) : value;
}

export const useComposerDraftStore = create<ComposerDraftStoreState>((set, get) => ({
  composerInputs: {},
  composerImagesMap: {},
  queuedMessagesMap: {},
  editingMessageByConversation: {},
  setMessageInput: (conversationId, value) =>
    set((state) => {
      const previous = state.composerInputs[conversationId] ?? '';
      const next = applyStateAction(previous, value);
      if (previous === next) {
        return state;
      }
      return {
        composerInputs: {
          ...state.composerInputs,
          [conversationId]: next,
        },
      };
    }),
  setComposerImages: (conversationId, value) =>
    set((state) => {
      const previous = state.composerImagesMap[conversationId] ?? EMPTY_IMAGES;
      const next = applyStateAction(previous, value);
      if (previous === next) {
        return state;
      }
      return {
        composerImagesMap: {
          ...state.composerImagesMap,
          [conversationId]: next,
        },
      };
    }),
  clearComposerDraft: (conversationId) =>
    set((state) => ({
      composerInputs: {
        ...state.composerInputs,
        [conversationId]: '',
      },
      composerImagesMap: {
        ...state.composerImagesMap,
        [conversationId]: [],
      },
    })),
  setEditingMessage: (conversationId, messageId) =>
    set((state) => ({
      editingMessageByConversation: {
        ...state.editingMessageByConversation,
        [conversationId]: messageId,
      },
    })),
  clearEditingMessage: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.editingMessageByConversation)) {
        return state;
      }
      const next = { ...state.editingMessageByConversation };
      delete next[conversationId];
      return { editingMessageByConversation: next };
    }),
  enqueueConversationMessage: (conversationId, messageText, messageImages) => {
    const text = messageText.trim();
    if (!conversationId || (!text && messageImages.length === 0)) {
      return false;
    }

    set((state) => {
      const previous = state.queuedMessagesMap[conversationId] ?? EMPTY_QUEUE;
      return {
        queuedMessagesMap: {
          ...state.queuedMessagesMap,
          [conversationId]: [...previous, { id: crypto.randomUUID(), text, images: messageImages }],
        },
      };
    });
    return true;
  },
  queueDraftMessage: (conversationId) => {
    const state = get();
    const text = state.composerInputs[conversationId] ?? '';
    const images = state.composerImagesMap[conversationId] ?? EMPTY_IMAGES;
    const queued = state.enqueueConversationMessage(conversationId, text, images);
    if (!queued) {
      return false;
    }
    state.clearComposerDraft(conversationId);
    return true;
  },
  dequeueQueuedMessage: (conversationId) => {
    const queue = get().queuedMessagesMap[conversationId] ?? EMPTY_QUEUE;
    const nextMessage = queue[0] ?? null;
    if (!nextMessage) {
      return null;
    }

    set((state) => ({
      queuedMessagesMap: {
        ...state.queuedMessagesMap,
        [conversationId]: queue.slice(1),
      },
    }));
    return nextMessage;
  },
  removeQueuedMessage: (conversationId, id) =>
    set((state) => {
      const previous = state.queuedMessagesMap[conversationId] ?? EMPTY_QUEUE;
      const next = previous.filter((message) => message.id !== id);
      if (next.length === previous.length) {
        return state;
      }
      return {
        queuedMessagesMap: {
          ...state.queuedMessagesMap,
          [conversationId]: next,
        },
      };
    }),
  reorderQueuedMessage: (conversationId, id, direction) =>
    set((state) => {
      const previous = state.queuedMessagesMap[conversationId] ?? EMPTY_QUEUE;
      const index = previous.findIndex((message) => message.id === id);
      if (index < 0) {
        return state;
      }

      const next = [...previous];
      if (direction === 'up' && index > 0) {
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
      } else if (direction === 'down' && index < previous.length - 1) {
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
      } else {
        return state;
      }

      return {
        queuedMessagesMap: {
          ...state.queuedMessagesMap,
          [conversationId]: next,
        },
      };
    }),
}));
