import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConversationWorktreeBranchName,
  resolveDraftBaseBranch,
  resolveDraftEnvironmentMode,
  worktreeLabelFromPath,
} from '../src/utils/worktreeDraft.ts';

test('buildConversationWorktreeBranchName normalizes the seed into a short loop branch', () => {
  assert.equal(
    buildConversationWorktreeBranchName('ABCD-1234-efgh-5678'),
    'loop/abcd1234',
  );
});

test('resolveDraftEnvironmentMode falls back to local when worktrees cannot be created yet', () => {
  assert.equal(
    resolveDraftEnvironmentMode('worktree', {
      isInitialized: true,
      hasCommits: false,
      branch: 'main',
      branches: ['main'],
    }),
    'local',
  );
});

test('resolveDraftBaseBranch keeps a valid chosen branch and otherwise falls back to the active branch', () => {
  assert.equal(
    resolveDraftBaseBranch('release', {
      isInitialized: true,
      hasCommits: true,
      branch: 'main',
      branches: ['main', 'release'],
    }),
    'release',
  );

  assert.equal(
    resolveDraftBaseBranch('missing', {
      isInitialized: true,
      hasCommits: true,
      branch: 'main',
      branches: ['main', 'release'],
    }),
    'main',
  );
});

test('worktreeLabelFromPath returns the terminal directory name', () => {
  assert.equal(
    worktreeLabelFromPath('/tmp/.gemini-loop/worktrees/repo/loop-feature'),
    'loop-feature',
  );
});
