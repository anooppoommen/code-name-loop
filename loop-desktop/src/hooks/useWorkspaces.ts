import { useCallback, useEffect, useMemo, useState } from 'react';
import { chooseFolder, requestJson } from '../lib/loopClient';
import type { WorkspaceSummary } from '../types/ui';
import { lastPathSegment, parseWorkspace, stringifyResponseError } from '../utils/parsers';
import { rowsFromUnknown } from './useLoopDesktop.helpers';
import { useConnectionStore } from '../stores/connectionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useNoticeStore } from '../stores/noticeStore';
import { useConversationStore } from '../stores/conversationStore';
import { usePatchRevertStore } from '../stores/patchRevertStore';

export interface UseWorkspacesReturn {
    workspaces: WorkspaceSummary[];
    selectedWorkspaceId: string;
    setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string>>;
    selectedWorkspace: WorkspaceSummary | null;
    workspacePath: string;
    setWorkspacePath: (value: string) => void;
    workspaceName: string;
    setWorkspaceName: (value: string) => void;
    isLoadingWorkspaces: boolean;
    refreshWorkspaces: () => Promise<void>;
    pickFolder: () => Promise<void>;
    createWorkspace: () => Promise<void>;
    pickAndCreateWorkspace: () => Promise<void>;
    deleteWorkspace: (workspaceId: string) => Promise<void>;
    selectWorkspace: (workspaceId: string) => void;
}

export function useWorkspaces(): UseWorkspacesReturn {
    // ── Read from stores ─────────────────────────────────
    const backendUrl = useConnectionStore((s) => s.backendUrl);
    const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
    const setSelectedWorkspaceId = useSelectionStore.getState().setSelectedWorkspaceId;
    const setSelectedConversationId = useSelectionStore.getState().setSelectedConversationId;

    const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
    const [workspacePath, setWorkspacePath] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');
    const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);

    const selectedWorkspace = useMemo(
        () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
        [selectedWorkspaceId, workspaces],
    );

    const refreshWorkspaces = useCallback(async (): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        setIsLoadingWorkspaces(true);
        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: '/workspaces',
            method: 'GET',
        });
        setIsLoadingWorkspaces(false);

        if (!response.ok) {
            pushNotice('error', `Unable to load workspaces: ${response.error ?? 'Unknown error'}`);
            return;
        }

        const rows = rowsFromUnknown(response.data);
        const parsed = rows
            .map((item) => parseWorkspace(item))
            .filter((item): item is WorkspaceSummary => item !== null);

        setWorkspaces(parsed);

        if (parsed.length === 0) {
            setSelectedWorkspaceId('');
            return;
        }

        if (!parsed.some((workspace) => workspace.id === selectedWorkspaceId)) {
            setSelectedWorkspaceId(parsed[0].id);
            setWorkspacePath(parsed[0].rootPath);
            setWorkspaceName(parsed[0].name);
        }
    }, [backendUrl, selectedWorkspaceId, setSelectedWorkspaceId]);

    const pickFolder = useCallback(async (): Promise<void> => {
        const folder = await chooseFolder();
        if (!folder) return;
        setWorkspacePath(folder);
        if (!workspaceName.trim()) {
            setWorkspaceName(lastPathSegment(folder));
        }
    }, [workspaceName]);

    const createWorkspace = useCallback(async (): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        const trimmedPath = workspacePath.trim();
        if (!trimmedPath) {
            pushNotice('info', 'Select a workspace folder before creating the workspace.');
            return;
        }

        const id = `ws-${crypto.randomUUID()}`;
        const name = workspaceName.trim() || lastPathSegment(trimmedPath);

        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: '/workspaces',
            method: 'POST',
            body: {
                ID: id,
                Name: name,
                RootPath: trimmedPath,
                CanonicalRootPath: trimmedPath,
                PathGrants: [],
                ConversationRoots: [],
            },
        });

        if (!response.ok) {
            pushNotice('error', `Failed to create workspace: ${stringifyResponseError(response.data, response.error)}`);
            return;
        }

        pushNotice('success', `Workspace "${name}" created.`);
        await refreshWorkspaces();
        setSelectedWorkspaceId(id);
    }, [backendUrl, refreshWorkspaces, workspaceName, workspacePath, setSelectedWorkspaceId]);

    const pickAndCreateWorkspace = useCallback(async (): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        const folder = await chooseFolder();
        if (!folder) return;

        const id = `ws-${crypto.randomUUID()}`;
        const name = lastPathSegment(folder);

        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: '/workspaces',
            method: 'POST',
            body: {
                ID: id,
                Name: name,
                RootPath: folder,
                CanonicalRootPath: folder,
                PathGrants: [],
                ConversationRoots: [],
            },
        });

        if (!response.ok) {
            pushNotice('error', `Failed to create workspace: ${stringifyResponseError(response.data, response.error)}`);
            return;
        }

        pushNotice('success', `Workspace "${name}" created.`);
        await refreshWorkspaces();
        setSelectedWorkspaceId(id);
    }, [backendUrl, refreshWorkspaces, setSelectedWorkspaceId]);

    const deleteWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
        const pushNotice = useNoticeStore.getState().pushNotice;
        if (!workspaceId) return;

        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}`,
            method: 'DELETE',
        });

        if (!response.ok) {
            pushNotice('error', `Failed to delete workspace: ${stringifyResponseError(response.data, response.error)}`);
            return;
        }

        pushNotice('success', 'Workspace deleted.');

        if (selectedWorkspaceId === workspaceId) {
            setSelectedWorkspaceId('');
            setSelectedConversationId('');
            setWorkspacePath('');
            setWorkspaceName('');
            // Clear the conversation view
            const conversationId = useSelectionStore.getState().selectedConversationId;
            if (conversationId) {
                useConversationStore.getState().clearConversation(conversationId);
                usePatchRevertStore.getState().clearConversation(conversationId);
            }
        }

        await refreshWorkspaces();
    }, [backendUrl, refreshWorkspaces, selectedWorkspaceId, setSelectedConversationId, setSelectedWorkspaceId]);

    const selectWorkspace = useCallback(
        (workspaceId: string): void => {
            setSelectedWorkspaceId(workspaceId);
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (workspace) {
                setWorkspacePath(workspace.rootPath);
                setWorkspaceName(workspace.name);
            }
            // Clear conversation view when swapping workspaces
            const conversationId = useSelectionStore.getState().selectedConversationId;
            if (conversationId) {
                useConversationStore.getState().clearConversation(conversationId);
                usePatchRevertStore.getState().clearConversation(conversationId);
            }
        },
        [setSelectedWorkspaceId, workspaces],
    );

    // Initial load
    useEffect(() => {
        void refreshWorkspaces();
    }, [refreshWorkspaces]);

    return {
        workspaces,
        selectedWorkspaceId,
        setSelectedWorkspaceId: (action) => {
            const next = typeof action === 'function' ? action(selectedWorkspaceId) : action;
            setSelectedWorkspaceId(next);
        },
        selectedWorkspace,
        workspacePath,
        setWorkspacePath,
        workspaceName,
        setWorkspaceName,
        isLoadingWorkspaces,
        refreshWorkspaces,
        pickFolder,
        createWorkspace,
        pickAndCreateWorkspace,
        deleteWorkspace,
        selectWorkspace,
    };
}
