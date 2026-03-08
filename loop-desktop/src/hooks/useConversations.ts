import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attachReplyStream, getActiveReplyStream, requestJson } from '../lib/loopClient';
import { useConversationStore } from '../stores/conversationStore';
import type { ActivityEvent, CheckpointSummary, ConversationSummary } from '../types/ui';
import { type ActivityInput, historyRowsToActivities } from '../utils/activityTimeline';
import type { PatchFile } from '../utils/patches';
import {
    asRecord,
    buildConversationTitle,
    getField,
    getBoolean,
    getString,
    parseCheckpoint,
    parseConversation,
    shortID,
    stringifyResponseError,
} from '../utils/parsers';
import { annotateActivitiesWithPendingApprovals, rowsFromUnknown } from './useLoopDesktop.helpers';

import { useConnectionStore } from '../stores/connectionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useNoticeStore } from '../stores/noticeStore';
import { useStreamingStore, activeStreams } from '../stores/streamingStore';
import { useCommandApprovalStore } from '../stores/commandApprovalStore';
import { useModelSettingsStore } from '../stores/modelSettingsStore';
import { useComposerDraftStore } from '../stores/composerDraftStore';

interface ConversationPageCursor {
    id: string;
    updatedAt: string;
}

interface WorkspaceChangeApiPayload {
    kind: string;
    text: string;
    reason?: string;
    patch_id?: string;
    checkpoint_id?: string;
    base_checkpoint_id?: string;
    file_count?: number;
    file_paths?: string[];
}

export interface ApplyPatchResult {
    workspaceChange: WorkspaceChangeApiPayload | null;
}

function parseWorkspaceChangeApiPayload(payload: unknown): WorkspaceChangeApiPayload | null {
    const record = asRecord(payload);
    if (!record) return null;

    const kind = getString(record, ['kind']);
    const text = getString(record, ['text']);
    if (!kind || !text) return null;

    const rawPaths = getField(record, ['file_paths']);
    const filePaths = Array.isArray(rawPaths)
        ? rawPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : undefined;

    return {
        kind,
        text,
        reason: getString(record, ['reason']) || undefined,
        patch_id: getString(record, ['patch_id']) || undefined,
        checkpoint_id: getString(record, ['checkpoint_id']) || undefined,
        base_checkpoint_id: getString(record, ['base_checkpoint_id']) || undefined,
        file_count: typeof record.file_count === 'number' ? record.file_count : undefined,
        file_paths: filePaths && filePaths.length > 0 ? filePaths : undefined,
    };
}

function compareConversationSummaries(a: ConversationSummary, b: ConversationSummary): number {
    const timeA = new Date(a.updatedAt).getTime();
    const timeB = new Date(b.updatedAt).getTime();
    if (timeA !== timeB) return timeB - timeA;
    return b.id.localeCompare(a.id);
}

function mergeConversationSummaries(
    existing: ConversationSummary[],
    incoming: ConversationSummary[],
): ConversationSummary[] {
    const merged = new Map<string, ConversationSummary>();
    for (const conversation of existing) merged.set(conversation.id, conversation);
    for (const conversation of incoming) merged.set(conversation.id, conversation);
    return Array.from(merged.values()).sort(compareConversationSummaries);
}

function parseConversationPageCursor(payload: unknown): ConversationPageCursor | null {
    const record = asRecord(payload);
    const cursorRecord = asRecord(getField(record, ['next_cursor', 'nextCursor']));
    if (!cursorRecord) return null;

    const id = getString(cursorRecord, ['id', 'ID']);
    const updatedAt = getString(cursorRecord, ['updated_at', 'updatedAt']);
    if (!id || !updatedAt) return null;

    return { id, updatedAt };
}

export interface UseConversationsReturn {
    conversationsByWorkspace: Record<string, ConversationSummary[]>;
    setConversationsByWorkspace: React.Dispatch<React.SetStateAction<Record<string, ConversationSummary[]>>>;
    selectedConversation: ConversationSummary | null;
    conversations: ConversationSummary[];
    checkpointsByConversation: Record<string, CheckpointSummary[]>;
    setCheckpointsByConversation: React.Dispatch<React.SetStateAction<Record<string, CheckpointSummary[]>>>;
    checkpoints: CheckpointSummary[];
    refreshConversationsByWorkspace: (workspaceId: string, preserveEmpty?: boolean) => Promise<void>;
    loadMoreConversations: (workspaceId: string) => Promise<void>;
    hasMoreConversationsByWorkspace: Record<string, boolean>;
    refreshCheckpointsForConversation: (conversationId: string) => Promise<CheckpointSummary[]>;
    loadConversationHistory: (conversationId: string) => Promise<void>;
    createConversation: (seedText: string, options?: { worktreePath?: string }) => Promise<string | null>;
    deleteConversation: (conversationId: string) => Promise<void>;
    renameConversation: (conversationId: string, title: string) => Promise<void>;
    ensureConversationId: (seedText: string, options?: { worktreePath?: string }) => Promise<string | null>;
    selectConversation: (conversationId: string) => void;
    newConversation: () => Promise<void>;
    refreshConversations: () => Promise<void>;
    refreshCheckpoints: () => Promise<void>;
    createCheckpoint: (label?: string) => Promise<void>;
    restoreCheckpoint: (checkpointId: string) => Promise<void>;
    undoLatestCheckpoint: () => Promise<void>;
    applyPatchToWorkspace: (
        conversationId: string,
        files: PatchFile[],
        message: string,
        baseCheckpointId?: string,
        patchId?: string,
    ) => Promise<ApplyPatchResult | null>;
    isRestoringCheckpoint: boolean;
    isLoadingSelectedConversation: boolean;
}

export function useConversations(): UseConversationsReturn {
    // ── Read from stores ─────────────────────────────────
    const backendUrl = useConnectionStore((s) => s.backendUrl);
    const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
    const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
    const setSelectedConversationId = useSelectionStore.getState().setSelectedConversationId;

    // Keep a stable ref to selected conversation ID for use in async callbacks
    const selectedConversationIdRef = useRef(selectedConversationId);
    useEffect(() => {
        selectedConversationIdRef.current = selectedConversationId;
    }, [selectedConversationId]);

    // ── Local state ──────────────────────────────────────
    const [conversationsByWorkspace, setConversationsByWorkspace] = useState<Record<string, ConversationSummary[]>>({});
    const [checkpointsByConversation, setCheckpointsByConversation] = useState<Record<string, CheckpointSummary[]>>({});
    const [isRestoringCheckpoint, setIsRestoringCheckpoint] = useState(false);
    const [isLoadingSelectedConversation, setIsLoadingSelectedConversation] = useState(false);
    const [hasMoreConversationsByWorkspace, setHasMoreConversationsByWorkspace] = useState<Record<string, boolean>>({});
    const [conversationCursorByWorkspace, setConversationCursorByWorkspace] = useState<Record<string, ConversationPageCursor | null>>({});
    const loadingMoreConversationsRef = useRef<Record<string, boolean>>({});

    // ── Derived ─────────────────────────────────────────
    const conversations = useMemo(
        () => conversationsByWorkspace[selectedWorkspaceId] ?? [],
        [conversationsByWorkspace, selectedWorkspaceId],
    );

    const selectedConversation = useMemo(
        () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
        [conversations, selectedConversationId],
    );

    const checkpoints = useMemo(
        () => checkpointsByConversation[selectedConversationId] ?? [],
        [checkpointsByConversation, selectedConversationId],
    );

    // Helper: push an activity event for the current / given conversation
    const pushActivity = useCallback((input: ActivityInput, conversationId?: string): string => {
        const targetConversationId = conversationId ?? selectedConversationIdRef.current;
        if (!targetConversationId) return '';

        const sequenceNo = useConversationStore.getState().reserveSequenceNo(targetConversationId);
        const event: ActivityEvent = {
            id: crypto.randomUUID(),
            conversationId: targetConversationId,
            sequenceNo,
            kind: input.kind,
            title: input.title,
            body: input.body,
            userTurn: input.userTurn,
            checkpointId: input.checkpointId,
            checkpointReason: input.checkpointReason,
            baseCheckpointId: input.baseCheckpointId,
            patchId: input.patchId,
            filePaths: input.filePaths,
            tool: input.tool,
            images: input.images,
            timestamp: Date.now(),
            streaming: input.streaming,
        };
        useConversationStore.getState().upsertConversationEvent(event);
        return event.id;
    }, [selectedConversationIdRef]);

    // Helper: replace activities for a conversation
    const replaceConversationActivities = useCallback((conversationId: string, events: ActivityEvent[]): void => {
        if (!conversationId) return;
        const sorted = [...events].sort((l, r) => {
            if (l.sequenceNo !== r.sequenceNo) return l.sequenceNo - r.sequenceNo;
            if (l.timestamp !== r.timestamp) return l.timestamp - r.timestamp;
            return l.id.localeCompare(r.id);
        });
        useConversationStore.getState().replaceConversationEvents(conversationId, sorted);
    }, []);

    // Helper: clear view for current conversation
    const clearConversationView = useCallback((): void => {
        const conversationId = selectedConversationIdRef.current;
        if (!conversationId) return;
        useConversationStore.getState().clearConversation(conversationId);
    }, [selectedConversationIdRef]);

    const handleStreamPacketRef = useRef<((packet: import('../electron').LoopStreamPacket, conversationId: string) => void) | null>(null);

    // ── Conversation loading ──────────────────────────────
    const refreshConversationsByWorkspace = useCallback(
        async (workspaceId: string, preserveEmpty = false, limit = 50, cursor: ConversationPageCursor | null = null): Promise<void> => {
            const pushNotice = useNoticeStore.getState().pushNotice;
            const setSendingConversations = useStreamingStore.getState().setSendingConversations;
            const query = new URLSearchParams({ limit: String(limit) });
            if (cursor) {
                query.set('before_updated_at', cursor.updatedAt);
                query.set('before_id', cursor.id);
            }
            const response = await requestJson<unknown>({
                baseUrl: backendUrl,
                endpointPath: `/workspaces/${workspaceId}/conversations?${query.toString()}`,
                method: 'GET',
            });

            if (!response.ok) {
                pushNotice('error', `Unable to load conversations: ${response.error ?? 'Unknown error'}`);
                pushActivity({
                    kind: 'error',
                    title: 'Unable to load conversations',
                    body: response.error ?? 'Unknown error',
                }, selectedConversationIdRef.current);
                return;
            }

            const rows = rowsFromUnknown(response.data);
            const parsed = rows
                .map((item) => parseConversation(item))
                .filter((item): item is ConversationSummary => item !== null);
            const rootsOnly = parsed.filter((conversation) => !conversation.isThread).sort(compareConversationSummaries);

            const payload = asRecord(response.data);
            const hasMore = getBoolean(payload, ['has_more', 'hasMore']);
            const nextCursor = parseConversationPageCursor(response.data);
            setHasMoreConversationsByWorkspace((prev) => ({ ...prev, [workspaceId]: hasMore }));
            setConversationCursorByWorkspace((prev) => ({ ...prev, [workspaceId]: nextCursor }));

            const currentSelectedId = selectedConversationIdRef.current;
            let mergedConversations = rootsOnly;
            setConversationsByWorkspace((prev) => {
                const existing = prev[workspaceId] ?? [];
                if (cursor) {
                    mergedConversations = mergeConversationSummaries(existing, rootsOnly);
                    return { ...prev, [workspaceId]: mergedConversations };
                }

                mergedConversations = rootsOnly;
                if (currentSelectedId && !mergedConversations.some((c) => c.id === currentSelectedId)) {
                    const selectedExisting = existing.find((c) => c.id === currentSelectedId);
                    if (selectedExisting) {
                        mergedConversations = mergeConversationSummaries(mergedConversations, [selectedExisting]);
                    }
                }
                return { ...prev, [workspaceId]: mergedConversations };
            });

            // Restore active streams for any root conversation that is currently running
            for (const conv of rootsOnly) {
                if (!activeStreams[conv.id]) {
                    void (async () => {
                        const active = await getActiveReplyStream({
                            baseUrl: backendUrl,
                            conversationId: conv.id,
                        });
                        if (active.ok && active.streamId && !activeStreams[conv.id]) {
                            const attached = attachReplyStream(active.streamId, (packet) => {
                                handleStreamPacketRef.current?.(packet, conv.id);
                            });
                            activeStreams[conv.id] = { ...attached, conversationId: conv.id };
                            setSendingConversations((prev) => ({ ...prev, [conv.id]: true }));
                        }
                    })();
                }
            }

            if (preserveEmpty && currentSelectedId === '') {
                // keep empty
            } else if (currentSelectedId && mergedConversations.some((c) => c.id === currentSelectedId)) {
                // preserve current selection
            } else {
                setSelectedConversationId(mergedConversations[0]?.id ?? '');
            }
        },
        [backendUrl, pushActivity, selectedConversationIdRef, setSelectedConversationId],
    );

    const loadMoreConversations = useCallback(
        async (workspaceId: string) => {
            if (loadingMoreConversationsRef.current[workspaceId]) return;
            if (!hasMoreConversationsByWorkspace[workspaceId]) return;

            const cursor = conversationCursorByWorkspace[workspaceId];
            if (!cursor) return;

            loadingMoreConversationsRef.current[workspaceId] = true;
            try {
                await refreshConversationsByWorkspace(workspaceId, true, 50, cursor);
            } finally {
                loadingMoreConversationsRef.current[workspaceId] = false;
            }
        },
        [conversationCursorByWorkspace, hasMoreConversationsByWorkspace, refreshConversationsByWorkspace],
    );

    const refreshCheckpointsForConversation = useCallback(
        async (conversationId: string): Promise<CheckpointSummary[]> => {
            if (!conversationId) return [];
            const response = await requestJson<unknown>({
                baseUrl: backendUrl,
                endpointPath: `/conversations/${conversationId}/checkpoints?limit=60`,
                method: 'GET',
            });
            if (!response.ok) return [];

            const rows = rowsFromUnknown(response.data);
            const parsed = rows
                .map((item) => parseCheckpoint(item))
                .filter((item): item is CheckpointSummary => item !== null);

            setCheckpointsByConversation((prev) => ({ ...prev, [conversationId]: parsed }));
            return parsed;
        },
        [backendUrl],
    );

    const loadConversationHistory = useCallback(
        async (conversationId: string): Promise<void> => {
            const pushNotice = useNoticeStore.getState().pushNotice;
            const response = await requestJson<unknown>({
                baseUrl: backendUrl,
                endpointPath: `/conversations/${conversationId}/timeline`,
                method: 'GET',
            });

            if (!response.ok) {
                pushNotice('error', `Unable to load conversation history: ${response.error ?? 'Unknown error'}`);
                return;
            }

            const rows = rowsFromUnknown(response.data);
            if (rows.length === 0 && response.data && !Array.isArray(response.data)) {
                const payload = asRecord(response.data);
                const status = getString(payload, ['status']);
                const message = getString(payload, ['message']);
                if (status === 'success' && message.includes('Hello, world')) {
                    const restartMsg = 'Conversation history endpoint not active on backend. Restart Loop API server to load history.';
                    pushNotice('info', restartMsg);
                    pushActivity({
                        kind: 'error',
                        title: 'History unavailable',
                        body: restartMsg,
                    }, conversationId);
                    return;
                }
            }

            if (selectedConversationIdRef.current !== conversationId) return;

            const sendingConversations = useStreamingStore.getState().sendingConversations;
            const hasActiveStream = !!activeStreams[conversationId];
            const isConversationSending = !!sendingConversations[conversationId];
            if (rows.length === 0 && (hasActiveStream || isConversationSending)) return;

            const pendingApprovals = useCommandApprovalStore.getState().getPendingForConversation(conversationId);
            replaceConversationActivities(
                conversationId,
                annotateActivitiesWithPendingApprovals(historyRowsToActivities(rows), pendingApprovals),
            );
            useConversationStore.getState().resetLiveState(conversationId);
            useStreamingStore.getState().setSendingConversations((prev) => {
                if (!prev[conversationId]) return prev;
                return prev;
            });
        },
        [backendUrl, pushActivity, replaceConversationActivities, selectedConversationIdRef],
    );

    const createConversation = useCallback(
        async (seedText: string, options?: { worktreePath?: string }): Promise<string | null> => {
            const pushNotice = useNoticeStore.getState().pushNotice;
            if (!selectedWorkspaceId) {
                pushNotice('info', 'Pick or create a workspace first.');
                return null;
            }

            const conversationId = `conv-${crypto.randomUUID()}`;
            const response = await requestJson<unknown>({
                baseUrl: backendUrl,
                endpointPath: '/conversations',
                method: 'POST',
                body: {
                    ID: conversationId,
                    WorkspaceID: selectedWorkspaceId,
                    Title: buildConversationTitle(seedText),
                    WorktreePath: options?.worktreePath || '',
                },
            });

            if (!response.ok) {
                pushNotice('error', `Failed to create conversation: ${stringifyResponseError(response.data, response.error)}`);
                return null;
            }

            await refreshConversationsByWorkspace(selectedWorkspaceId, true);
            return conversationId;
        },
        [backendUrl, refreshConversationsByWorkspace, selectedWorkspaceId],
    );

    const deleteConversation = useCallback(
        async (conversationId: string): Promise<void> => {
            const pushNotice = useNoticeStore.getState().pushNotice;
            if (!selectedWorkspaceId) return;

            const targetConversation = conversations.find((conversation) => conversation.id === conversationId);
            const displayName = targetConversation?.title || shortID(conversationId);
            const confirmed = window.confirm(`Delete conversation "${displayName}"? This will also remove nested thread history.`);
            if (!confirmed) return;

            const response = await requestJson<unknown>({
                baseUrl: backendUrl,
                endpointPath: `/conversations/${conversationId}`,
                method: 'DELETE',
            });

            if (!response.ok) {
                pushNotice('error', `Failed to delete conversation: ${stringifyResponseError(response.data, response.error)}`);
                return;
            }

            const wasSelected = selectedConversationId === conversationId;
            if (wasSelected) {
                setSelectedConversationId('');
                clearConversationView();
            }

            setConversationsByWorkspace((prev) => ({
                ...prev,
                [selectedWorkspaceId]: (prev[selectedWorkspaceId] ?? []).filter((conversation) => conversation.id !== conversationId),
            }));
            useModelSettingsStore.getState().setThinkingLevelsByConversation((prev) => {
                if (!(conversationId in prev)) return prev;
                const next = { ...prev };
                delete next[conversationId];
                return next;
            });
            setCheckpointsByConversation((prev) => {
                if (!(conversationId in prev)) return prev;
                const next = { ...prev };
                delete next[conversationId];
                return next;
            });
            useComposerDraftStore.getState().clearEditingMessage(conversationId);
            pushNotice('success', `Deleted conversation "${displayName}".`);
            await refreshConversationsByWorkspace(selectedWorkspaceId, selectedConversationId === '' && !wasSelected);
        },
        [
            backendUrl,
            clearConversationView,
            conversations,
            refreshConversationsByWorkspace,
            selectedConversationId,
            selectedWorkspaceId,
            setSelectedConversationId,
        ],
    );

    const renameConversation = useCallback(
        async (conversationId: string, newTitle: string): Promise<void> => {
            const pushNotice = useNoticeStore.getState().pushNotice;
            const trimmedTitle = newTitle.trim();
            if (!selectedWorkspaceId || !trimmedTitle || !conversationId) return;

            const response = await requestJson<unknown>({
                baseUrl: backendUrl,
                endpointPath: `/conversations/${conversationId}`,
                method: 'PATCH',
                body: { title: trimmedTitle },
            });

            if (!response.ok) {
                pushNotice('error', `Failed to rename conversation: ${stringifyResponseError(response.data, response.error)}`);
                return;
            }

            setConversationsByWorkspace((prev) => ({
                ...prev,
                [selectedWorkspaceId]: (prev[selectedWorkspaceId] ?? []).map((conversation) =>
                    conversation.id === conversationId ? { ...conversation, title: trimmedTitle } : conversation,
                ),
            }));

            await refreshConversationsByWorkspace(selectedWorkspaceId, true);
        },
        [backendUrl, refreshConversationsByWorkspace, selectedWorkspaceId],
    );

    const ensureConversationId = useCallback(
        async (seedText: string, options?: { worktreePath?: string }): Promise<string | null> => {
            if (selectedConversationId) return selectedConversationId;
            const conversationId = await createConversation(seedText, options);
            if (!conversationId) return null;
            setSelectedConversationId(conversationId);
            return conversationId;
        },
        [createConversation, selectedConversationId, setSelectedConversationId],
    );

    const selectConversation = useCallback((conversationId: string): void => {
        setSelectedConversationId(conversationId);
    }, [setSelectedConversationId]);

    const newConversation = useCallback(async (): Promise<void> => {
        clearConversationView();
        setSelectedConversationId('');
        useNoticeStore.getState().clearNotices();
    }, [clearConversationView, setSelectedConversationId]);

    const refreshConversations = useCallback(async (): Promise<void> => {
        if (!selectedWorkspaceId) return;
        await refreshConversationsByWorkspace(selectedWorkspaceId, true);
    }, [refreshConversationsByWorkspace, selectedWorkspaceId]);

    const refreshCheckpoints = useCallback(async (): Promise<void> => {
        if (!selectedConversationId) return;
        await refreshCheckpointsForConversation(selectedConversationId);
    }, [refreshCheckpointsForConversation, selectedConversationId]);

    const createCheckpoint = useCallback(async (label?: string): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        if (!selectedConversationId) return;

        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/conversations/${encodeURIComponent(selectedConversationId)}/checkpoints`,
            method: 'POST',
            body: label?.trim() ? { label: label.trim() } : {},
        });

        if (!response.ok) {
            pushNotice('error', `Failed to create checkpoint: ${stringifyResponseError(response.data, response.error)}`);
            return;
        }

        await refreshCheckpointsForConversation(selectedConversationId);
        pushNotice('success', 'Checkpoint created.');
    }, [backendUrl, refreshCheckpointsForConversation, selectedConversationId]);

    const restoreCheckpoint = useCallback(async (checkpointId: string): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        const isSending = !!useStreamingStore.getState().sendingConversations[selectedConversationId];
        const checkpointID = checkpointId.trim();
        if (!selectedConversationId) {
            pushNotice('error', 'Unable to restore checkpoint: no conversation is selected.');
            return;
        }
        if (!checkpointID) {
            pushNotice('error', 'Unable to restore checkpoint: checkpoint id is missing.');
            return;
        }
        if (isRestoringCheckpoint) {
            pushNotice('info', 'A checkpoint restore is already in progress.');
            return;
        }
        if (isSending) {
            pushNotice('info', 'Wait for the current response to finish before restoring a checkpoint.');
            return;
        }

        setIsRestoringCheckpoint(true);
        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/conversations/${encodeURIComponent(selectedConversationId)}/checkpoints/${encodeURIComponent(checkpointID)}/restore`,
            method: 'POST',
        });
        setIsRestoringCheckpoint(false);

        if (!response.ok) {
            pushNotice('error', `Failed to restore checkpoint: ${stringifyResponseError(response.data, response.error)}`);
            return;
        }

        await Promise.all([
            loadConversationHistory(selectedConversationId),
            refreshCheckpointsForConversation(selectedConversationId),
        ]);
        pushNotice('success', 'Checkpoint restored.');
    }, [
        backendUrl,
        isRestoringCheckpoint,
        loadConversationHistory,
        refreshCheckpointsForConversation,
        selectedConversationId,
    ]);

    const undoLatestCheckpoint = useCallback(async (): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        const isSending = !!useStreamingStore.getState().sendingConversations[selectedConversationId];
        if (!selectedConversationId) {
            pushNotice('error', 'Unable to undo: no conversation is selected.');
            return;
        }
        if (isRestoringCheckpoint) {
            pushNotice('info', 'A checkpoint restore is already in progress.');
            return;
        }
        if (isSending) {
            pushNotice('info', 'Wait for the current response to finish before undoing.');
            return;
        }

        setIsRestoringCheckpoint(true);
        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/conversations/${encodeURIComponent(selectedConversationId)}/undo`,
            method: 'POST',
        });
        setIsRestoringCheckpoint(false);

        if (!response.ok) {
            pushNotice('error', `Failed to undo: ${stringifyResponseError(response.data, response.error)}`);
            return;
        }

        await Promise.all([
            loadConversationHistory(selectedConversationId),
            refreshCheckpointsForConversation(selectedConversationId),
        ]);
        pushNotice('success', 'Undo completed.');
    }, [
        backendUrl,
        isRestoringCheckpoint,
        loadConversationHistory,
        refreshCheckpointsForConversation,
        selectedConversationId,
    ]);

    // Load conversations when workspace changes
    useEffect(() => {
        if (!selectedWorkspaceId) {
            setSelectedConversationId('');
            return;
        }
        void refreshConversationsByWorkspace(selectedWorkspaceId, true);
    }, [refreshConversationsByWorkspace, selectedWorkspaceId, setSelectedConversationId]);

    // Load conversation history when selected conversation changes
    useEffect(() => {
        if (!selectedConversationId) {
            setIsLoadingSelectedConversation(false);
            clearConversationView();
            return;
        }
        setIsLoadingSelectedConversation(true);
        void loadConversationHistory(selectedConversationId).finally(() => {
            if (selectedConversationIdRef.current === selectedConversationId) {
                setIsLoadingSelectedConversation(false);
            }
        });
    }, [clearConversationView, loadConversationHistory, selectedConversationId, selectedConversationIdRef]);

    // Reload history after sending finishes
    const prevIsSendingRef = useRef(false);
    const isSending = !!useStreamingStore((s) => s.sendingConversations[selectedConversationId]);
    useEffect(() => {
        if (prevIsSendingRef.current && !isSending && selectedConversationId) {
            const liveState = useConversationStore.getState().getLiveState(selectedConversationId);
            if (liveState.skipNextHistoryReload) {
                useConversationStore.getState().updateLiveState(selectedConversationId, {
                    skipNextHistoryReload: false,
                });
                prevIsSendingRef.current = isSending;
                return;
            }
            void loadConversationHistory(selectedConversationId);
        }
        prevIsSendingRef.current = isSending;
    }, [isSending, selectedConversationId, loadConversationHistory]);

    const applyPatchToWorkspace = useCallback(async (
        conversationId: string,
        files: PatchFile[],
        message: string,
        baseCheckpointId?: string,
        patchId?: string,
    ): Promise<ApplyPatchResult | null> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        if (!conversationId) {
            pushNotice('error', 'Unable to revert changes: no conversation is selected.');
            return null;
        }
        if (files.length === 0) {
            pushNotice('info', 'Select at least one file to revert.');
            return null;
        }

        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/conversations/${encodeURIComponent(conversationId)}/apply-patch`,
            method: 'POST',
            body: {
                files,
                message,
                baseCheckpointId: baseCheckpointId?.trim() || undefined,
                patchId: patchId?.trim() || undefined,
            },
        });

        if (!response.ok) {
            pushNotice('error', `Failed to apply patch: ${stringifyResponseError(response.data, response.error)}`);
            return null;
        }

        const responseRecord = asRecord(response.data);
        const workspaceChange = parseWorkspaceChangeApiPayload(getField(responseRecord, ['workspace_change', 'workspaceChange']));
        if (workspaceChange?.kind === 'workspace_changes_applied') {
            pushActivity({
                kind: 'lifecycle',
                title: workspaceChange.reason === 'manual_revert' ? 'Selected changes reverted' : 'Workspace changes applied',
                body: workspaceChange.text,
                checkpointId: workspaceChange.checkpoint_id,
                checkpointReason: workspaceChange.reason,
                baseCheckpointId: workspaceChange.base_checkpoint_id,
                patchId: workspaceChange.patch_id,
                filePaths: workspaceChange.file_paths,
            }, conversationId);
        }

        pushNotice('info', 'Successfully reverted changes.');
        void Promise.all([
            loadConversationHistory(conversationId),
            refreshCheckpointsForConversation(conversationId),
        ]);
        return { workspaceChange };
    }, [backendUrl, loadConversationHistory, pushActivity, refreshCheckpointsForConversation]);

    return {
        conversationsByWorkspace,
        setConversationsByWorkspace,
        selectedConversation,
        hasMoreConversationsByWorkspace,
        loadMoreConversations,
        conversations,
        checkpointsByConversation,
        setCheckpointsByConversation,
        checkpoints,
        refreshConversationsByWorkspace,
        refreshCheckpointsForConversation,
        loadConversationHistory,
        createConversation,
        deleteConversation,
        renameConversation,
        ensureConversationId,
        selectConversation,
        newConversation,
        refreshConversations,
        refreshCheckpoints,
        createCheckpoint,
        restoreCheckpoint,
        undoLatestCheckpoint,
        applyPatchToWorkspace,
        isRestoringCheckpoint,
        isLoadingSelectedConversation,
    };
}
