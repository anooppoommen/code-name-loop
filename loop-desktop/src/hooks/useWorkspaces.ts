import { useCallback, useEffect, useMemo, useState } from 'react';
import { chooseFolder, requestJson } from '../lib/loopClient';
import type { WorkspaceSummary } from '../types/ui';
import { lastPathSegment, parseWorkspace, stringifyResponseError } from '../utils/parsers';
import { rowsFromUnknown } from './useLoopDesktop.helpers';
import type { NoticeTone } from './useLoopDesktop.types';

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

export function useWorkspaces(
    backendUrl: string,
    pushNotice: (tone: NoticeTone, message: string) => void,
    clearConversationView: () => void,
    onWorkspacesRefreshed: (parsed: WorkspaceSummary[]) => void,
    onWorkspaceDeleted: (workspaceId: string) => void,
): UseWorkspacesReturn {
    const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
    const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
    const [workspacePath, setWorkspacePath] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');
    const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);

    const selectedWorkspace = useMemo(
        () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
        [selectedWorkspaceId, workspaces],
    );

    const refreshWorkspaces = useCallback(async (): Promise<void> => {
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
            onWorkspacesRefreshed(parsed);
            return;
        }

        onWorkspacesRefreshed(parsed);

        if (!parsed.some((workspace) => workspace.id === selectedWorkspaceId)) {
            setSelectedWorkspaceId(parsed[0].id);
            setWorkspacePath(parsed[0].rootPath);
            setWorkspaceName(parsed[0].name);
        }
    }, [backendUrl, onWorkspacesRefreshed, pushNotice, selectedWorkspaceId]);

    const pickFolder = useCallback(async (): Promise<void> => {
        const folder = await chooseFolder();
        if (!folder) {
            return;
        }

        setWorkspacePath(folder);
        if (!workspaceName.trim()) {
            setWorkspaceName(lastPathSegment(folder));
        }
    }, [workspaceName]);

    const createWorkspace = useCallback(async (): Promise<void> => {
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
    }, [backendUrl, pushNotice, refreshWorkspaces, workspaceName, workspacePath]);

    const pickAndCreateWorkspace = useCallback(async (): Promise<void> => {
        const folder = await chooseFolder();
        if (!folder) {
            return;
        }

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
    }, [backendUrl, pushNotice, refreshWorkspaces]);

    const deleteWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
        if (!workspaceId) {
            return;
        }

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
            setWorkspacePath('');
            setWorkspaceName('');
            onWorkspaceDeleted(workspaceId);
            clearConversationView();
        }

        await refreshWorkspaces();
    }, [backendUrl, clearConversationView, onWorkspaceDeleted, pushNotice, refreshWorkspaces, selectedWorkspaceId]);

    const selectWorkspace = useCallback(
        (workspaceId: string): void => {
            setSelectedWorkspaceId(workspaceId);
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (workspace) {
                setWorkspacePath(workspace.rootPath);
                setWorkspaceName(workspace.name);
            }
            clearConversationView();
        },
        [clearConversationView, workspaces],
    );

    // Initial load
    useEffect(() => {
        void refreshWorkspaces();
    }, [refreshWorkspaces]);

    return {
        workspaces,
        selectedWorkspaceId,
        setSelectedWorkspaceId,
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
