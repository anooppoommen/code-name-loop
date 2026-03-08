import { useCallback, useEffect, useState } from 'react';
import { requestJson } from '../lib/loopClient';
import { stringifyResponseError } from '../utils/parsers';
import type { NoticeTone } from './useLoopDesktop.types';

export interface GitStatus {
  isInitialized: boolean;
  hasCommits: boolean;
  branch: string;
  branches: string[];
  worktrees: { path: string; branch: string }[];
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  base?: string;
}

export type CreateWorktreeResult =
  | { ok: true; worktree: GitWorktreeInfo }
  | { ok: false; error: string };

export function useGitStatus(
  backendUrl: string,
  workspaceId: string,
  pushNotice?: (tone: NoticeTone, message: string) => void,
) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }
    setIsLoading(true);
    const response = await requestJson<{
      is_initialized: boolean;
      has_commits?: boolean;
      branch: string;
      branches: string[];
      worktrees: { path: string; branch: string }[];
    }>({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}/git`,
      method: 'GET',
    });
    setIsLoading(false);

    if (response.ok && response.data) {
      setStatus({
        isInitialized: response.data.is_initialized,
        hasCommits: Boolean(response.data.has_commits),
        branch: response.data.branch,
        branches: response.data.branches || [],
        worktrees: response.data.worktrees || [],
      });
    }
  }, [backendUrl, workspaceId]);

  const initGit = useCallback(async () => {
    if (!workspaceId) return;
    const response = await requestJson({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}/git/init`,
      method: 'POST',
    });
    if (response.ok) {
      await fetchStatus();
      return true;
    }
    pushNotice?.('error', `Failed to initialize Git: ${stringifyResponseError(response.data, response.error)}`);
    return false;
  }, [backendUrl, workspaceId, fetchStatus, pushNotice]);

  const checkoutBranch = useCallback(async (branch: string, create: boolean = false) => {
    if (!workspaceId) {
      return false;
    }
    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}/git/checkout`,
      method: 'POST',
      body: { branch, create },
    });
    if (response.ok) {
      await fetchStatus();
      return true;
    }
    const action = create ? 'create branch' : 'switch branch';
    pushNotice?.('error', `Failed to ${action}: ${stringifyResponseError(response.data, response.error)}`);
    return false;
  }, [backendUrl, workspaceId, fetchStatus, pushNotice]);

  const createWorktree = useCallback(async (path: string, branch: string, base: string = ''): Promise<CreateWorktreeResult> => {
    if (!workspaceId) {
      return { ok: false, error: 'No workspace selected.' };
    }
    const response = await requestJson<GitWorktreeInfo | string>({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}/git/worktree`,
      method: 'POST',
      body: { path, branch, base },
    });
    if (response.ok && response.data && typeof response.data !== 'string') {
      await fetchStatus();
      return {
        ok: true,
        worktree: {
          path: response.data.path,
          branch: response.data.branch,
          base: response.data.base,
        },
      };
    }
    const errorText =
      typeof response.data === 'string' && response.data.trim()
        ? response.data
        : response.error || 'Failed to create worktree.';
    return { ok: false, error: errorText };
  }, [backendUrl, workspaceId, fetchStatus]);

  useEffect(() => {
    void fetchStatus();
    // Poll every 5 seconds to keep the branch up to date
    const interval = setInterval(() => {
      void fetchStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return { status, isLoading, initGit, checkoutBranch, createWorktree, refreshGitStatus: fetchStatus };
}
