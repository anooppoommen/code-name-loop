export type DraftEnvironmentMode = 'local' | 'worktree';

export interface GitStatusSnapshot {
  isInitialized: boolean;
  hasCommits: boolean;
  branch: string;
  branches: string[];
}

export function buildConversationWorktreeBranchName(seed = ''): string {
  const source = seed || crypto.randomUUID();
  const token = source.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  return `loop/${token || 'draft'}`;
}

export function resolveDraftEnvironmentMode(
  requestedMode: DraftEnvironmentMode,
  status: GitStatusSnapshot | null,
): DraftEnvironmentMode {
  if (requestedMode !== 'worktree') {
    return 'local';
  }
  if (!status?.isInitialized || !status.hasCommits) {
    return 'local';
  }
  return 'worktree';
}

export function resolveDraftBaseBranch(
  currentBranch: string,
  status: GitStatusSnapshot | null,
): string {
  const trimmedCurrent = currentBranch.trim();
  if (trimmedCurrent && status?.branches.includes(trimmedCurrent)) {
    return trimmedCurrent;
  }
  if (status?.branch) {
    return status.branch;
  }
  return status?.branches[0] || '';
}

export function worktreeLabelFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'worktree';
}
