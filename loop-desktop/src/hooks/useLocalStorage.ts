import { useEffect, useRef } from 'react';
import type { ComposerModel, ThinkingLevel } from '../types/ui';
import { STORAGE_KEY } from './useLoopDesktop.constants';
import { normalizeComposerModel, normalizeThinkingLevel } from './useLoopDesktop.helpers';
import type { SshTunnelConfig } from './useLoopDesktop.types';

export interface LocalStorageState {
    backendUrl: string;
    setBackendUrl: (value: string) => void;
    selectedWorkspaceId: string;
    setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string>>;
    selectedConversationId: string;
    setSelectedConversationId: React.Dispatch<React.SetStateAction<string>>;
    workspacePath: string;
    setWorkspacePath: (value: string) => void;
    hideLifecycle: boolean;
    setHideLifecycle: (value: boolean) => void;
    showMascot: boolean;
    setShowMascot: (value: boolean) => void;
    reactScanEnabled: boolean;
    setReactScanEnabled: (value: boolean) => void;
    draftThinkingLevel: ThinkingLevel;
    setDraftThinkingLevel: (value: ThinkingLevel) => void;
    thinkingLevelsByConversation: Record<string, ThinkingLevel>;
    setThinkingLevelsByConversation: React.Dispatch<React.SetStateAction<Record<string, ThinkingLevel>>>;
    draftComposerModel: ComposerModel;
    setDraftComposerModel: (value: ComposerModel) => void;
    composerModelsByConversation: Record<string, ComposerModel>;
    setComposerModelsByConversation: React.Dispatch<React.SetStateAction<Record<string, ComposerModel>>>;
    sshTunnelConfig: SshTunnelConfig;
    setSshTunnelConfig: React.Dispatch<React.SetStateAction<SshTunnelConfig>>;
}

export function useLocalStorage(state: LocalStorageState): void {
    const lastPersistedRef = useRef<string | null>(null);

    // Hydrate from localStorage on mount
    useEffect(() => {
        const raw = localStorage.getItem(STORAGE_KEY);
        lastPersistedRef.current = raw;
        if (!raw) {
            return;
        }

        try {
            const parsed = JSON.parse(raw) as {
                backendUrl?: string;
                selectedWorkspaceId?: string;
                selectedConversationId?: string;
                workspacePath?: string;
                hideLifecycle?: boolean;
                showMascot?: boolean;
                reactScanEnabled?: boolean;
                draftThinkingLevel?: ThinkingLevel;
                thinkingLevelsByConversation?: Record<string, unknown>;
                draftComposerModel?: ComposerModel;
                composerModelsByConversation?: Record<string, unknown>;
                sshTunnelConfig?: SshTunnelConfig;
            };

            if (parsed.backendUrl) {
                state.setBackendUrl(parsed.backendUrl);
            }
            if (parsed.selectedWorkspaceId) {
                state.setSelectedWorkspaceId(parsed.selectedWorkspaceId);
            }
            if (parsed.selectedConversationId) {
                state.setSelectedConversationId(parsed.selectedConversationId);
            }
            if (parsed.workspacePath) {
                state.setWorkspacePath(parsed.workspacePath);
            }
            if (typeof parsed.hideLifecycle === 'boolean') {
                state.setHideLifecycle(parsed.hideLifecycle);
            }
            if (typeof parsed.showMascot === 'boolean') {
                state.setShowMascot(parsed.showMascot);
            }
            if (typeof parsed.reactScanEnabled === 'boolean') {
                state.setReactScanEnabled(parsed.reactScanEnabled);
            }
            if (parsed.draftThinkingLevel) {
                state.setDraftThinkingLevel(normalizeThinkingLevel(parsed.draftThinkingLevel));
            }
            if (parsed.thinkingLevelsByConversation && typeof parsed.thinkingLevelsByConversation === 'object') {
                const normalized: Record<string, ThinkingLevel> = {};
                for (const [conversationID, level] of Object.entries(parsed.thinkingLevelsByConversation)) {
                    if (!conversationID) {
                        continue;
                    }
                    normalized[conversationID] = normalizeThinkingLevel(level);
                }
                state.setThinkingLevelsByConversation(normalized);
            }
            if (parsed.draftComposerModel) {
                state.setDraftComposerModel(normalizeComposerModel(parsed.draftComposerModel));
            }
            if (parsed.composerModelsByConversation && typeof parsed.composerModelsByConversation === 'object') {
                const normalized: Record<string, ComposerModel> = {};
                for (const [conversationID, model] of Object.entries(parsed.composerModelsByConversation)) {
                    if (!conversationID) {
                        continue;
                    }
                    normalized[conversationID] = normalizeComposerModel(model);
                }
                state.setComposerModelsByConversation(normalized);
            }
            if (parsed.sshTunnelConfig) {
                state.setSshTunnelConfig((prev) => ({ ...prev, ...parsed.sshTunnelConfig }));
            }
        } catch {
            // Ignore invalid local storage state.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Persist to localStorage on state changes
    useEffect(() => {
        const payload = {
            backendUrl: state.backendUrl,
            selectedWorkspaceId: state.selectedWorkspaceId,
            selectedConversationId: state.selectedConversationId,
            workspacePath: state.workspacePath,
            hideLifecycle: state.hideLifecycle,
            showMascot: state.showMascot,
            reactScanEnabled: state.reactScanEnabled,
            draftThinkingLevel: state.draftThinkingLevel,
            thinkingLevelsByConversation: state.thinkingLevelsByConversation,
            draftComposerModel: state.draftComposerModel,
            composerModelsByConversation: state.composerModelsByConversation,
            sshTunnelConfig: state.sshTunnelConfig,
        };

        let cancelled = false;
        let timeoutId: number | null = null;
        let idleId: number | null = null;

        const persist = () => {
            if (cancelled) {
                return;
            }

            const serialized = JSON.stringify(payload);
            if (serialized === lastPersistedRef.current) {
                return;
            }

            localStorage.setItem(STORAGE_KEY, serialized);
            lastPersistedRef.current = serialized;
        };

        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            idleId = window.requestIdleCallback(persist, { timeout: 500 });
        } else {
            timeoutId = globalThis.setTimeout(persist, 0);
        }

        return () => {
            cancelled = true;
            if (idleId !== null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
                window.cancelIdleCallback(idleId);
            }
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [
        state.backendUrl,
        state.selectedWorkspaceId,
        state.selectedConversationId,
        state.workspacePath,
        state.hideLifecycle,
        state.showMascot,
        state.reactScanEnabled,
        state.draftThinkingLevel,
        state.thinkingLevelsByConversation,
        state.draftComposerModel,
        state.composerModelsByConversation,
        state.sshTunnelConfig,
    ]);
}
