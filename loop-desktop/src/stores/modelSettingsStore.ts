import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { ComposerModel, ThinkingLevel } from '../types/ui';
import {
    DEFAULT_COMPOSER_MODEL,
    DEFAULT_THINKING_LEVEL,
} from '../hooks/useLoopDesktop.constants';
import {
    normalizeComposerModel,
    normalizeThinkingLevel,
    normalizeThinkingLevelForModel,
} from '../hooks/useLoopDesktop.helpers';

function applyAction<T>(prev: T, action: SetStateAction<T>): T {
    return typeof action === 'function' ? (action as (p: T) => T)(prev) : action;
}

interface ModelSettingsStoreState {
    draftThinkingLevel: ThinkingLevel;
    draftComposerModel: ComposerModel;
    thinkingLevelsByConversation: Record<string, ThinkingLevel>;
    composerModelsByConversation: Record<string, ComposerModel>;

    setDraftThinkingLevel: (v: ThinkingLevel) => void;
    setDraftComposerModel: (v: ComposerModel) => void;
    setThinkingLevelsByConversation: (v: SetStateAction<Record<string, ThinkingLevel>>) => void;
    setComposerModelsByConversation: (v: SetStateAction<Record<string, ComposerModel>>) => void;

    // Derived getters — call with current conversationId
    getComposerModel: (conversationId: string) => ComposerModel;
    getThinkingLevel: (conversationId: string) => ThinkingLevel;
}

export const useModelSettingsStore = create<ModelSettingsStoreState>((set, get) => ({
    draftThinkingLevel: DEFAULT_THINKING_LEVEL,
    draftComposerModel: DEFAULT_COMPOSER_MODEL,
    thinkingLevelsByConversation: {},
    composerModelsByConversation: {},

    setDraftThinkingLevel: (v) =>
        set({ draftThinkingLevel: normalizeThinkingLevel(v) }),

    setDraftComposerModel: (v) =>
        set({ draftComposerModel: normalizeComposerModel(v) }),

    setThinkingLevelsByConversation: (v) =>
        set((state) => ({
            thinkingLevelsByConversation: applyAction(state.thinkingLevelsByConversation, v),
        })),

    setComposerModelsByConversation: (v) =>
        set((state) => ({
            composerModelsByConversation: applyAction(state.composerModelsByConversation, v),
        })),

    getComposerModel: (conversationId) => {
        const state = get();
        if (!conversationId) return state.draftComposerModel;
        return state.composerModelsByConversation[conversationId] ?? DEFAULT_COMPOSER_MODEL;
    },

    getThinkingLevel: (conversationId) => {
        const state = get();
        const model = state.getComposerModel(conversationId);
        if (!conversationId) {
            return normalizeThinkingLevelForModel(state.draftThinkingLevel, model);
        }
        const stored = state.thinkingLevelsByConversation[conversationId] ?? DEFAULT_THINKING_LEVEL;
        return normalizeThinkingLevelForModel(stored, model);
    },
}));
