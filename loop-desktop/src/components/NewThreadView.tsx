import { motion, useReducedMotion } from 'framer-motion';

import type { DraftEnvironmentMode } from '../utils/worktreeDraft';

interface NewThreadViewProps {
  workspaceName: string;
  currentBranch: string;
  draftBaseBranch: string;
  draftEnvMode: DraftEnvironmentMode;
  canCreateWorktree: boolean;
}

export function NewThreadView({
  workspaceName,
  currentBranch,
  draftBaseBranch,
  draftEnvMode,
  canCreateWorktree,
}: NewThreadViewProps) {
  const prefersReducedMotion = Boolean(useReducedMotion());
  const isWorktreeMode = draftEnvMode === 'worktree' && canCreateWorktree;
  const branchLabel = isWorktreeMode
    ? draftBaseBranch || currentBranch || 'main'
    : currentBranch || 'main';

  return (
    <div className="flex h-full items-center justify-center px-6 py-8">
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[560px] text-center"
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-loop-700 bg-loop-900/70 px-3 py-1 text-[10px] tracking-[0.16em] text-loop-500">
          <motion.span
            animate={prefersReducedMotion ? undefined : { opacity: [0.45, 1, 0.45] }}
            transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY }}
            className={`h-2 w-2 rounded-full ${isWorktreeMode ? 'bg-cyan-300' : 'bg-emerald-300'}`}
          />
          New thread
        </div>

        <h1 className="mx-auto mt-5 max-w-none text-[24px] font-semibold tracking-[-0.045em] text-loop-100 sm:text-[30px]">
          {isWorktreeMode
            ? 'Next message will start in an isolated worktree.'
            : 'Start a new conversation when you’re ready.'}
        </h1>

        <p className="mx-auto mt-3 max-w-[46ch] text-[13px] leading-6 text-loop-400">
          {isWorktreeMode
            ? `The first send will branch from ${branchLabel} and attach the conversation to a new worktree.`
            : `The first send will continue in ${workspaceName || 'the selected workspace'} on ${branchLabel}.`}
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm text-loop-400">
          <MetaPill label="Workspace" value={workspaceName || 'Unassigned'} />
          <MetaPill
            label={isWorktreeMode ? 'Base branch' : 'Branch'}
            value={branchLabel}
          />
          <MetaPill
            label="Mode"
            value={isWorktreeMode ? 'Worktree' : 'Local'}
          />
        </div>
      </motion.div>
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full border border-loop-700 bg-loop-900/55 px-3 py-1">
      <span className="text-loop-500">{label}</span>
      <span className="mx-2 text-loop-700">/</span>
      <span className="font-mono text-loop-200">{value}</span>
    </div>
  );
}
