import { useCallback, useEffect, useState } from 'react';
import { requestJson } from '../lib/loopClient';

export interface GitStatus {
  isInitialized: boolean;
  branch: string;
  branches: string[];
}

export function useGitStatus(backendUrl: string, workspaceId: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }
    setIsLoading(true);
    const response = await requestJson<{ is_initialized: boolean; branch: string; branches: string[] }>({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}/git`,
      method: 'GET',
    });
    setIsLoading(false);

    if (response.ok && response.data) {
      setStatus({
        isInitialized: response.data.is_initialized,
        branch: response.data.branch,
        branches: response.data.branches || [],
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
    }
  }, [backendUrl, workspaceId, fetchStatus]);

  const checkoutBranch = useCallback(async (branch: string, create: boolean = false) => {
    if (!workspaceId) return;
    const response = await requestJson({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}/git/checkout`,
      method: 'POST',
      body: { branch, create },
    });
    if (response.ok) {
      await fetchStatus();
      return true;
    }
    return false;
  }, [backendUrl, workspaceId, fetchStatus]);

  useEffect(() => {
    void fetchStatus();
    // Poll every 5 seconds to keep the branch up to date
    const interval = setInterval(() => {
      void fetchStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return { status, isLoading, initGit, checkoutBranch, refreshGitStatus: fetchStatus };
}
