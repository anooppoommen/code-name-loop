import { useEffect, useRef } from 'react';
import { STORAGE_KEY } from './useLoopDesktop.constants';
import { normalizeComposerModel, normalizeThinkingLevel } from './useLoopDesktop.helpers';
import { useConnectionStore } from '../stores/connectionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useUiPrefsStore } from '../stores/uiPrefsStore';
import { useModelSettingsStore } from '../stores/modelSettingsStore';
import { useSshTunnelStore } from '../stores/sshTunnelStore';
import type { ComposerModel, ThinkingLevel } from '../types/ui';
import type { SshTunnelConfig } from './useLoopDesktop.types';

export function useLocalStorage(): void {
    const lastPersistedRef = useRef<string | null>(null);

    // ── Hydrate from localStorage on mount ───────────────
    useEffect(() => {
        const raw = localStorage.getItem(STORAGE_KEY);
        lastPersistedRef.current = raw;
        if (!raw) return;

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
                useConnectionStore.getState().setBackendUrl(parsed.backendUrl);
            }
            if (parsed.selectedWorkspaceId) {
                useSelectionStore.getState().setSelectedWorkspaceId(parsed.selectedWorkspaceId);
            }
            if (parsed.selectedConversationId) {
                useSelectionStore.getState().setSelectedConversationId(parsed.selectedConversationId);
            }
            if (typeof parsed.hideLifecycle === 'boolean') {
                useUiPrefsStore.getState().setHideLifecycle(parsed.hideLifecycle);
            }
            if (typeof parsed.showMascot === 'boolean') {
                useUiPrefsStore.getState().setShowMascot(parsed.showMascot);
            }
            if (typeof parsed.reactScanEnabled === 'boolean') {
                useUiPrefsStore.getState().setReactScanEnabled(parsed.reactScanEnabled);
            }
            if (parsed.draftThinkingLevel) {
                useModelSettingsStore.getState().setDraftThinkingLevel(normalizeThinkingLevel(parsed.draftThinkingLevel));
            }
            if (parsed.thinkingLevelsByConversation && typeof parsed.thinkingLevelsByConversation === 'object') {
                const normalized: Record<string, ThinkingLevel> = {};
                for (const [id, level] of Object.entries(parsed.thinkingLevelsByConversation)) {
                    if (id) normalized[id] = normalizeThinkingLevel(level);
                }
                useModelSettingsStore.getState().setThinkingLevelsByConversation(normalized);
            }
            if (parsed.draftComposerModel) {
                useModelSettingsStore.getState().setDraftComposerModel(normalizeComposerModel(parsed.draftComposerModel));
            }
            if (parsed.composerModelsByConversation && typeof parsed.composerModelsByConversation === 'object') {
                const normalized: Record<string, ComposerModel> = {};
                for (const [id, model] of Object.entries(parsed.composerModelsByConversation)) {
                    if (id) normalized[id] = normalizeComposerModel(model);
                }
                useModelSettingsStore.getState().setComposerModelsByConversation(normalized);
            }
            if (parsed.sshTunnelConfig) {
                useSshTunnelStore.getState().setSshTunnelConfig((prev) => ({ ...prev, ...parsed.sshTunnelConfig }));
            }
        } catch {
            // Ignore invalid local storage state.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Persist to localStorage on state changes ─────────
    const backendUrl = useConnectionStore((s) => s.backendUrl);
    const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
    const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
    const hideLifecycle = useUiPrefsStore((s) => s.hideLifecycle);
    const showMascot = useUiPrefsStore((s) => s.showMascot);
    const reactScanEnabled = useUiPrefsStore((s) => s.reactScanEnabled);
    const draftThinkingLevel = useModelSettingsStore((s) => s.draftThinkingLevel);
    const thinkingLevelsByConversation = useModelSettingsStore((s) => s.thinkingLevelsByConversation);
    const draftComposerModel = useModelSettingsStore((s) => s.draftComposerModel);
    const composerModelsByConversation = useModelSettingsStore((s) => s.composerModelsByConversation);
    const sshTunnelConfig = useSshTunnelStore((s) => s.sshTunnelConfig);

    useEffect(() => {
        const payload = {
            backendUrl,
            selectedWorkspaceId,
            selectedConversationId,
            hideLifecycle,
            showMascot,
            reactScanEnabled,
            draftThinkingLevel,
            thinkingLevelsByConversation,
            draftComposerModel,
            composerModelsByConversation,
            sshTunnelConfig,
        };

        let cancelled = false;
        let timeoutId: number | null = null;
        let idleId: number | null = null;

        const persist = () => {
            if (cancelled) return;
            const serialized = JSON.stringify(payload);
            if (serialized === lastPersistedRef.current) return;
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
        backendUrl,
        selectedWorkspaceId,
        selectedConversationId,
        hideLifecycle,
        showMascot,
        reactScanEnabled,
        draftThinkingLevel,
        thinkingLevelsByConversation,
        draftComposerModel,
        composerModelsByConversation,
        sshTunnelConfig,
    ]);
}
