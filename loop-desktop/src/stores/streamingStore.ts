import { create } from 'zustand';
import type { StreamHandle } from '../hooks/useLoopDesktop.types';

// Module-level mutable map — intentionally NOT reactive Zustand state.
// Components that need reactivity use `sendingConversations` (Zustand) instead.
// This is equivalent to the previous `activeStreamsRef.current` in useActivities.
export const activeStreams: Record<string, StreamHandle> = {};

interface StreamingStoreState {
    sendingConversations: Record<string, boolean>;
    setSendingConversations: (
        updater: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
    ) => void;
}

export const useStreamingStore = create<StreamingStoreState>((set) => ({
    sendingConversations: {},
    setSendingConversations: (updater) =>
        set((state) => ({
            sendingConversations:
                typeof updater === 'function' ? updater(state.sendingConversations) : updater,
        })),
}));
