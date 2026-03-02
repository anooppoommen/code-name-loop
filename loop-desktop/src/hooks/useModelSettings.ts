import { useCallback, useMemo, useState } from 'react';
import type { ComposerModel, ThinkingLevel } from '../types/ui';
import { DEFAULT_COMPOSER_MODEL, DEFAULT_THINKING_LEVEL } from './useLoopDesktop.constants';
import {
    normalizeComposerModel,
    normalizeThinkingLevel,
    normalizeThinkingLevelForModel,
} from './useLoopDesktop.helpers';

export interface UseModelSettingsReturn {
    draftThinkingLevel: ThinkingLevel;
    setDraftThinkingLevel: (value: ThinkingLevel) => void;
    thinkingLevelsByConversation: Record<string, ThinkingLevel>;
    setThinkingLevelsByConversation: React.Dispatch<React.SetStateAction<Record<string, ThinkingLevel>>>;
    draftComposerModel: ComposerModel;
    setDraftComposerModel: (value: ComposerModel) => void;
    composerModelsByConversation: Record<string, ComposerModel>;
    setComposerModelsByConversation: React.Dispatch<React.SetStateAction<Record<string, ComposerModel>>>;
    composerModel: ComposerModel;
    thinkingLevel: ThinkingLevel;
    setThinkingLevel: (value: ThinkingLevel) => void;
    setComposerModel: (value: ComposerModel) => void;
}

export function useModelSettings(selectedConversationId: string): UseModelSettingsReturn {
    const [draftThinkingLevel, setDraftThinkingLevelRaw] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
    const [thinkingLevelsByConversation, setThinkingLevelsByConversation] = useState<Record<string, ThinkingLevel>>({});
    const [draftComposerModel, setDraftComposerModelRaw] = useState<ComposerModel>(DEFAULT_COMPOSER_MODEL);
    const [composerModelsByConversation, setComposerModelsByConversation] = useState<Record<string, ComposerModel>>({});

    const composerModel = useMemo<ComposerModel>(() => {
        if (!selectedConversationId) {
            return draftComposerModel;
        }
        return composerModelsByConversation[selectedConversationId] ?? DEFAULT_COMPOSER_MODEL;
    }, [composerModelsByConversation, draftComposerModel, selectedConversationId]);

    const thinkingLevel = useMemo<ThinkingLevel>(() => {
        if (!selectedConversationId) {
            return normalizeThinkingLevelForModel(draftThinkingLevel, composerModel);
        }
        const stored = thinkingLevelsByConversation[selectedConversationId] ?? DEFAULT_THINKING_LEVEL;
        return normalizeThinkingLevelForModel(stored, composerModel);
    }, [composerModel, draftThinkingLevel, selectedConversationId, thinkingLevelsByConversation]);

    const setThinkingLevel = useCallback(
        (value: ThinkingLevel): void => {
            const normalized = normalizeThinkingLevelForModel(value, composerModel);
            if (!selectedConversationId) {
                setDraftThinkingLevelRaw(normalized);
                return;
            }
            setThinkingLevelsByConversation((prev) => ({
                ...prev,
                [selectedConversationId]: normalized,
            }));
        },
        [composerModel, selectedConversationId],
    );

    const setComposerModel = useCallback(
        (value: ComposerModel): void => {
            const normalized = normalizeComposerModel(value);
            if (!selectedConversationId) {
                setDraftComposerModelRaw(normalized);
                setDraftThinkingLevelRaw((prev) => normalizeThinkingLevelForModel(prev, normalized));
                return;
            }
            setComposerModelsByConversation((prev) => ({
                ...prev,
                [selectedConversationId]: normalized,
            }));
            setThinkingLevelsByConversation((prev) => {
                const current = prev[selectedConversationId] ?? DEFAULT_THINKING_LEVEL;
                const adjusted = normalizeThinkingLevelForModel(current, normalized);
                if (current === adjusted && selectedConversationId in prev) {
                    return prev;
                }
                return {
                    ...prev,
                    [selectedConversationId]: adjusted,
                };
            });
        },
        [selectedConversationId],
    );

    const setDraftThinkingLevel = useCallback((value: ThinkingLevel): void => {
        setDraftThinkingLevelRaw(normalizeThinkingLevel(value));
    }, []);

    const setDraftComposerModel = useCallback((value: ComposerModel): void => {
        setDraftComposerModelRaw(normalizeComposerModel(value));
    }, []);

    return {
        draftThinkingLevel,
        setDraftThinkingLevel,
        thinkingLevelsByConversation,
        setThinkingLevelsByConversation,
        draftComposerModel,
        setDraftComposerModel,
        composerModelsByConversation,
        setComposerModelsByConversation,
        composerModel,
        thinkingLevel,
        setThinkingLevel,
        setComposerModel,
    };
}
