import assert from 'node:assert/strict';
import test from 'node:test';

import { submitDraftConversation } from '../src/utils/draftConversationSubmit.ts';

test('submitDraftConversation sends locally when not using worktree mode', async () => {
  const calls: Array<{ worktreePath?: string }> = [];

  const result = await submitDraftConversation({
    selectedConversationId: '',
    draftEnvMode: 'local',
    draftBaseBranch: '',
    currentBranch: 'main',
    createWorktree: async () => {
      throw new Error('should not create a worktree');
    },
    sendMessage: async (options) => {
      calls.push(options ?? {});
    },
  });

  assert.deepEqual(result, { ok: true, mode: 'local' });
  assert.deepEqual(calls, [{}]);
});

test('submitDraftConversation creates a worktree and sends using its path', async () => {
  const sent: Array<{ worktreePath?: string }> = [];
  const createCalls: Array<{ path: string; branch: string; base: string }> = [];

  const result = await submitDraftConversation({
    selectedConversationId: '',
    draftEnvMode: 'worktree',
    draftBaseBranch: 'release',
    currentBranch: 'main',
    makeBranchName: () => 'loop/test-branch',
    createWorktree: async (path, branch, base = '') => {
      createCalls.push({ path, branch, base });
      return {
        ok: true,
        worktree: {
          path: '/tmp/worktrees/loop-test-branch',
          branch,
          base,
        },
      };
    },
    sendMessage: async (options) => {
      sent.push(options ?? {});
    },
  });

  assert.deepEqual(result, { ok: true, mode: 'worktree' });
  assert.deepEqual(createCalls, [{
    path: '',
    branch: 'loop/test-branch',
    base: 'release',
  }]);
  assert.deepEqual(sent, [{ worktreePath: '/tmp/worktrees/loop-test-branch' }]);
});

test('submitDraftConversation surfaces worktree creation failures and skips send', async () => {
  let sent = false;

  const result = await submitDraftConversation({
    selectedConversationId: '',
    draftEnvMode: 'worktree',
    draftBaseBranch: '',
    currentBranch: 'main',
    makeBranchName: () => 'loop/test-branch',
    createWorktree: async () => ({ ok: false, error: 'branch already exists' }),
    sendMessage: async () => {
      sent = true;
    },
  });

  assert.deepEqual(result, { ok: false, error: 'branch already exists' });
  assert.equal(sent, false);
});
