import type { CreateWorktreeResult } from '../hooks/useGitStatus';
import { buildConversationWorktreeBranchName, type DraftEnvironmentMode } from './worktreeDraft.ts';

interface DraftConversationSubmitOptions {
  selectedConversationId: string;
  draftEnvMode: DraftEnvironmentMode;
  draftBaseBranch: string;
  currentBranch: string;
  createWorktree: (path: string, branch: string, base?: string) => Promise<CreateWorktreeResult>;
  sendMessage: (options?: { worktreePath?: string }) => Promise<void>;
  makeBranchName?: () => string;
}

export type DraftConversationSubmitResult =
  | { ok: true; mode: 'local' | 'worktree' }
  | { ok: false; error: string };

export async function submitDraftConversation({
  selectedConversationId,
  draftEnvMode,
  draftBaseBranch,
  currentBranch,
  createWorktree,
  sendMessage,
  makeBranchName = buildConversationWorktreeBranchName,
}: DraftConversationSubmitOptions): Promise<DraftConversationSubmitResult> {
  if (selectedConversationId || draftEnvMode !== 'worktree') {
    await sendMessage();
    return { ok: true, mode: 'local' };
  }

  const worktreeResult = await createWorktree(
    '',
    makeBranchName(),
    draftBaseBranch || currentBranch || '',
  );
  if (!worktreeResult.ok) {
    return { ok: false, error: worktreeResult.error };
  }

  await sendMessage({ worktreePath: worktreeResult.worktree.path });
  return { ok: true, mode: 'worktree' };
}
