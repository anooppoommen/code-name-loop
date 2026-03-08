import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import type { ConversationSummary } from '../types/ui';
import type { DraftEnvironmentMode } from '../utils/worktreeDraft';
import { resolveDraftEnvironmentMode, worktreeLabelFromPath } from '../utils/worktreeDraft';
import type { GitStatus } from '../hooks/useGitStatus';
import { GitBranchPicker } from './GitBranchPicker';

interface ComposerEnvironmentBarProps {
  gitStatus: {
    status: GitStatus | null;
    initGit: () => Promise<boolean | undefined>;
    checkoutBranch: (branch: string, create?: boolean) => Promise<boolean>;
    pushBranch: (branch: string) => Promise<boolean>;
  };
  selectedConversationId: string;
  selectedConversation: ConversationSummary | null;
  draftEnvMode: DraftEnvironmentMode;
  onDraftEnvModeChange: (mode: DraftEnvironmentMode) => void;
  draftBaseBranch: string;
  onDraftBaseBranchChange: (branch: string) => void;
  isPreparingWorktree: boolean;
  worktreeError: string | null;
}

export function ComposerEnvironmentBar({
  gitStatus,
  selectedConversationId,
  selectedConversation,
  draftEnvMode,
  onDraftEnvModeChange,
  draftBaseBranch,
  onDraftBaseBranchChange,
  isPreparingWorktree,
  worktreeError,
}: ComposerEnvironmentBarProps) {
  const status = gitStatus.status;
  const effectiveDraftMode = resolveDraftEnvironmentMode(draftEnvMode, status);
  const canCreateWorktree = Boolean(status?.isInitialized && status.hasCommits);
  const [isPushing, setIsPushing] = useState(false);

  if (isPreparingWorktree) {
    return (
      <div className="mt-3 mb-4 px-4 text-[12px] text-loop-400">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-cyan-100"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
          Preparing isolated worktree
        </motion.div>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  if (!status.isInitialized) {
    return (
      <div className="mt-3 mb-4 flex items-center justify-end px-4 text-[12px] text-loop-400">
        <button
          type="button"
          onClick={() => void gitStatus.initGit()}
          className="group flex items-center gap-1.5 text-white/70 transition-colors hover:text-white focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
        >
          <span className="border-b border-dotted border-white/40 pb-[1px] leading-none transition-colors group-hover:border-white/80">
            Initialize Git
          </span>
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4v16m8-8H4"
            />
          </svg>
        </button>
      </div>
    );
  }

  const handlePush = async () => {
    if (!status?.branch) return;
    setIsPushing(true);
    try {
      await gitStatus.pushBranch(status.branch);
    } finally {
      setIsPushing(false);
    }
  };

  if (selectedConversationId) {
    const hasUpstreamChanges = status.hasUpstreamChanges && status.branch;
    return (
      <div className="mt-3 mb-4 flex items-center justify-between px-4 text-[12px] text-loop-400">
        <div>
          <button
            type="button"
            disabled={!hasUpstreamChanges || isPushing}
            onClick={handlePush}
            className="flex items-center gap-1.5 rounded-full bg-loop-800 px-2.5 py-1 text-loop-400 transition-colors hover:bg-loop-700 hover:text-loop-200 focus:outline-none focus:ring-1 focus:ring-loop-500/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-loop-800 disabled:hover:text-loop-400"
          >
            {isPushing ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-loop-500 border-t-transparent" />
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            )}
            <span>{isPushing ? 'Pushing...' : 'Push to upstream'}</span>
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {selectedConversation?.worktreePath ? (
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-emerald-100">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.55)]" />
              <span>Worktree</span>
              <span className="font-mono text-emerald-50">
                {worktreeLabelFromPath(selectedConversation.worktreePath)}
              </span>
            </div>
          ) : (
            <>
              <div className="mr-2 flex items-center gap-1.5 rounded-full bg-loop-800 px-2 py-0.5 text-loop-400">
                <div className="h-1.5 w-1.5 rounded-full bg-loop-500" />
                <span>Local</span>
              </div>
              <GitBranchPicker
                value={status.branch || 'main'}
                branches={status.branches}
                onSelect={async (branch) => {
                  if (branch !== status.branch) {
                    await gitStatus.checkoutBranch(branch, false);
                  }
                }}
                onCreate={async (branch) => {
                  await gitStatus.checkoutBranch(branch, true);
                }}
                allowCreate
                searchPlaceholder="Find or create a branch..."
              />
            </>
          )}
        </div>
      </div>
    );
  }

  const hasUpstreamChanges = status.hasUpstreamChanges && status.branch;
  return (
    <div className="mt-3 mb-4 px-4 text-[12px] text-loop-400">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {effectiveDraftMode !== 'worktree' && (
            <button
              type="button"
              disabled={!hasUpstreamChanges || isPushing}
              onClick={handlePush}
              className="flex items-center gap-1.5 rounded-full bg-loop-800 px-2.5 py-1 text-loop-400 transition-colors hover:bg-loop-700 hover:text-loop-200 focus:outline-none focus:ring-1 focus:ring-loop-500/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-loop-800 disabled:hover:text-loop-400"
            >
              {isPushing ? (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-loop-500 border-t-transparent" />
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              )}
              <span>{isPushing ? 'Pushing...' : 'Push to upstream'}</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
        <div className="flex items-center rounded-full border border-loop-700 bg-loop-900/80 p-0.5 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <button
            type="button"
            onClick={() => onDraftEnvModeChange('local')}
            className={`rounded-full px-2.5 py-1 transition-colors focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 ${
              effectiveDraftMode === 'local'
                ? 'bg-loop-700 text-loop-100'
                : 'text-loop-500 hover:text-loop-200'
            }`}
          >
            Local thread
          </button>
          <button
            type="button"
            onClick={() => {
              if (canCreateWorktree) {
                onDraftEnvModeChange('worktree');
              }
            }}
            disabled={!canCreateWorktree}
            title={canCreateWorktree ? 'Cmd+Shift+W to toggle' : 'Create a commit before starting a worktree thread'}
            className={`rounded-full px-2.5 py-1 transition-colors focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 ${
              effectiveDraftMode === 'worktree'
                ? 'bg-cyan-500/20 text-cyan-100'
                : canCreateWorktree
                  ? 'text-loop-500 hover:text-loop-200'
                  : 'cursor-not-allowed text-loop-600'
            }`}
          >
            Isolated worktree
          </button>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {effectiveDraftMode === 'worktree' ? (
            <motion.div
              key="worktree-draft-controls"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-cyan-100"
            >
              <span className="text-cyan-200/80">Branch off</span>
              <GitBranchPicker
                value={draftBaseBranch || status.branch || 'main'}
                branches={status.branches}
                onSelect={onDraftBaseBranchChange}
                searchPlaceholder="Choose a base branch..."
                emptyStateLabel="No base branches available"
              />
            </motion.div>
          ) : (
            <motion.div
              key="local-draft-controls"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="flex items-center gap-2 rounded-full border border-loop-700 bg-loop-900/70 px-3 py-1"
            >
              <span className="text-loop-500">Working on</span>
              <GitBranchPicker
                value={status.branch || 'main'}
                branches={status.branches}
                onSelect={async (branch) => {
                  if (branch !== status.branch) {
                    await gitStatus.checkoutBranch(branch, false);
                  }
                }}
                onCreate={async (branch) => {
                  await gitStatus.checkoutBranch(branch, true);
                }}
                allowCreate
                searchPlaceholder="Find or create a branch..."
              />
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {worktreeError ? (
          <motion.p
            key="worktree-error"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mt-2 text-right text-[11px] text-rose-300"
          >
            {worktreeError}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {!canCreateWorktree ? (
        <p className="mt-2 text-right text-[11px] text-loop-500">
          Create an initial commit before starting isolated worktree threads.
        </p>
      ) : null}
    </div>
  );
}
