import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActivityEvent } from '../src/types/ui.ts';
import { useConversationStore } from '../src/stores/conversationStore.ts';
import { buildActivityGroups } from '../src/stores/groupStore.ts';
import { buildRenderGroups } from '../src/utils/activityRenderGroups.ts';
import { buildAssistantPatchContext } from '../src/utils/patchActivityState.ts';
import { historyRowsToActivities } from '../src/utils/activityTimeline.ts';

function event(overrides: Partial<ActivityEvent> & Pick<ActivityEvent, 'id' | 'conversationId' | 'sequenceNo' | 'kind' | 'title' | 'timestamp'>): ActivityEvent {
  return {
    body: undefined,
    tool: undefined,
    userTurn: undefined,
    images: undefined,
    messageId: undefined,
    messageSeq: undefined,
    messageVersion: undefined,
    timelineSeq: undefined,
    eventSeq: undefined,
    archived: false,
    streaming: false,
    ...overrides,
  };
}

test('buildActivityGroups uses sequence order and user messages split groups', () => {
  const groups = buildActivityGroups([
    event({ id: 'tool-1', conversationId: 'conv-1', sequenceNo: 3, kind: 'tool', title: 'tool', timestamp: 3 }),
    event({ id: 'user-1', conversationId: 'conv-1', sequenceNo: 1, kind: 'user', title: 'user', timestamp: 1 }),
    event({ id: 'assistant-1', conversationId: 'conv-1', sequenceNo: 2, kind: 'assistant', title: 'assistant', timestamp: 2 }),
    event({ id: 'tool-2', conversationId: 'conv-1', sequenceNo: 5, kind: 'tool', title: 'tool', timestamp: 5 }),
    event({ id: 'user-2', conversationId: 'conv-1', sequenceNo: 4, kind: 'user', title: 'user', timestamp: 4 }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].eventIds, ['user-1', 'assistant-1', 'tool-1']);
  assert.equal(groups[0].headId, 'user-1');
  assert.equal(groups[0].tailId, 'tool-1');
  assert.deepEqual(groups[1].eventIds, ['user-2', 'tool-2']);
});

test('buildActivityGroups keeps pre-user events in the prior sequence bucket when a later user arrives', () => {
  const groups = buildActivityGroups([
    event({ id: 'user-1', conversationId: 'conv-1', sequenceNo: 1, kind: 'user', title: 'user', timestamp: 1 }),
    event({ id: 'assistant-1', conversationId: 'conv-1', sequenceNo: 2, kind: 'assistant', title: 'assistant', timestamp: 2 }),
    event({ id: 'user-2', conversationId: 'conv-1', sequenceNo: 4, kind: 'user', title: 'user', timestamp: 4 }),
    event({ id: 'status-1', conversationId: 'conv-1', sequenceNo: 3, kind: 'status', title: 'status', timestamp: 3 }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].eventIds, ['user-1', 'assistant-1', 'status-1']);
  assert.deepEqual(groups[1].eventIds, ['user-2']);
});

test('conversation store advances next sequence from replaced events and explicit reservations', () => {
  useConversationStore.setState({ conversations: {} });
  const store = useConversationStore.getState();

  store.replaceConversationEvents('conv-1', [
    event({ id: 'user-1', conversationId: 'conv-1', sequenceNo: 1, kind: 'user', title: 'user', timestamp: 1 }),
    event({ id: 'assistant-1', conversationId: 'conv-1', sequenceNo: 3, kind: 'assistant', title: 'assistant', timestamp: 3 }),
  ]);

  assert.equal(useConversationStore.getState().getConversationState('conv-1').nextSequenceNo, 4);
  assert.equal(useConversationStore.getState().reserveSequenceNo('conv-1', 10), 10);
  assert.equal(useConversationStore.getState().getConversationState('conv-1').nextSequenceNo, 11);
  assert.equal(useConversationStore.getState().reserveSequenceNo('conv-1'), 11);
});

test('historyRowsToActivities preserves conversation and sequence metadata from timeline rows', () => {
  const activities = historyRowsToActivities([
    {
      type: 'message',
      timeline_seq: 7,
      message: {
        ID: 'msg-1',
        ConversationID: 'conv-1',
        Seq: 2,
        Version: 1,
        SentBy: 'user',
        Parts: [{ Kind: 'text', text: { text: 'hello' } }],
        CreatedAt: '2026-03-06T18:27:37.185252Z',
      },
    },
    {
      type: 'ui_event',
      timeline_seq: 8,
      ui_event: {
        id: 'evt-1',
        conversation_id: 'conv-1',
        message_id: 'msg-2',
        seq: 11,
        version: 2,
        kind: 'status',
        text: 'turn started',
        created_at: '2026-03-06T18:27:38.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 2);
  assert.equal(activities[0].conversationId, 'conv-1');
  assert.equal(activities[0].sequenceNo, 7);
  assert.equal(activities[0].timelineSeq, 7);
  assert.equal(activities[1].conversationId, 'conv-1');
  assert.equal(activities[1].sequenceNo, 8);
  assert.equal(activities[1].timelineSeq, 8);
  assert.equal(activities[1].eventSeq, 11);
  assert.equal(activities[1].messageId, 'msg-2');
  assert.equal(activities[1].messageVersion, 2);
});

test('historyRowsToActivities preserves checkpoint ids from checkpoint lifecycle events', () => {
  const activities = historyRowsToActivities([
    {
      type: 'ui_event',
      timeline_seq: 9,
      ui_event: {
        id: 'evt-ckpt',
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        seq: 12,
        kind: 'checkpoint_created',
        text: 'checkpoint saved',
        metadata: {
          checkpoint_id: 'chk-123',
        },
        created_at: '2026-03-06T18:27:39.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].kind, 'lifecycle');
  assert.equal(activities[0].title, 'Checkpoint created');
  assert.equal(activities[0].checkpointId, 'chk-123');
  assert.equal(activities[0].messageId, 'msg-1');
});

test('historyRowsToActivities hides synthetic workspace-change user messages', () => {
  const activities = historyRowsToActivities([
    {
      type: 'message',
      timeline_seq: 9,
      message: {
        ID: 'msg-workspace-change',
        ConversationID: 'conv-1',
        Seq: 3,
        SentBy: 'user',
        Parts: [{ Kind: 'text', text: { text: 'System: The user manually reverted changes.' } }],
        Metadata: {
          hidden_from_ui: true,
          synthetic_kind: 'workspace_change',
          checkpoint_id: 'chk-999',
        },
        CreatedAt: '2026-03-06T18:27:39.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 0);
});

test('historyRowsToActivities keeps checkpoint ids and undo semantics for restore events', () => {
  const activities = historyRowsToActivities([
    {
      type: 'ui_event',
      timeline_seq: 10,
      ui_event: {
        id: 'evt-restore',
        conversation_id: 'conv-1',
        message_id: 'msg-2',
        seq: 13,
        kind: 'checkpoint_restored',
        text: 'undo restored checkpoint (abc1234)',
        metadata: {
          checkpoint_id: 'chk-456',
          reason: 'undo_latest',
        },
        created_at: '2026-03-06T18:27:40.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].kind, 'lifecycle');
  assert.equal(activities[0].title, 'Undo restored checkpoint');
  assert.equal(activities[0].checkpointId, 'chk-456');
  assert.equal(activities[0].body, 'undo restored checkpoint (abc1234)');
});

test('historyRowsToActivities keeps checkpoint ids and errors for failed restores', () => {
  const activities = historyRowsToActivities([
    {
      type: 'ui_event',
      timeline_seq: 11,
      ui_event: {
        id: 'evt-restore-failed',
        conversation_id: 'conv-1',
        message_id: 'msg-3',
        seq: 14,
        kind: 'checkpoint_restore_failed',
        text: '',
        metadata: {
          checkpoint_id: 'chk-789',
          reason: 'undo_latest',
          error: 'restore exploded',
        },
        created_at: '2026-03-06T18:27:41.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].kind, 'error');
  assert.equal(activities[0].title, 'Undo restore failed');
  assert.equal(activities[0].checkpointId, 'chk-789');
  assert.equal(activities[0].body, 'restore exploded');
});

test('historyRowsToActivities surfaces manual selective revert events', () => {
  const activities = historyRowsToActivities([
    {
      type: 'ui_event',
      timeline_seq: 12,
      ui_event: {
        id: 'evt-workspace-applied',
        conversation_id: 'conv-1',
        message_id: 'msg-4',
        seq: 15,
        kind: 'workspace_changes_applied',
        text: 'reverted 4 selected file(s)',
        metadata: {
          reason: 'manual_revert',
          file_count: 4,
          base_checkpoint_id: 'chk-base',
        },
        created_at: '2026-03-06T18:27:42.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].kind, 'lifecycle');
  assert.equal(activities[0].title, 'Selected changes reverted');
  assert.equal(activities[0].body, 'reverted 4 selected file(s)');
  assert.equal(activities[0].checkpointId, undefined);
  assert.equal(activities[0].baseCheckpointId, 'chk-base');
  assert.deepEqual(activities[0].filePaths, undefined);
});

test('historyRowsToActivities preserves base checkpoint and file paths for manual reverts', () => {
  const activities = historyRowsToActivities([
    {
      type: 'ui_event',
      timeline_seq: 13,
      ui_event: {
        id: 'evt-workspace-applied-files',
        conversation_id: 'conv-1',
        message_id: 'msg-5',
        seq: 16,
        kind: 'workspace_changes_applied',
        text: 'reverted 2 selected file(s)',
        metadata: {
          reason: 'manual_revert',
          patch_id: 'tool-calls:conv-1:call-a,call-b',
          checkpoint_id: 'chk-revert',
          base_checkpoint_id: 'chk-source',
          file_count: 2,
          file_paths: ['a.txt', 'b.txt'],
        },
        created_at: '2026-03-06T18:27:43.185252Z',
      },
    },
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].patchId, 'tool-calls:conv-1:call-a,call-b');
  assert.equal(activities[0].checkpointId, 'chk-revert');
  assert.equal(activities[0].baseCheckpointId, 'chk-source');
  assert.deepEqual(activities[0].filePaths, ['a.txt', 'b.txt']);
});

test('buildAssistantPatchContext marks assistant patch files as reverted after manual undo', () => {
  const context = buildAssistantPatchContext([
    event({
      id: 'user-1',
      conversationId: 'conv-1',
      sequenceNo: 1,
      kind: 'user',
      title: 'User prompt',
      messageId: 'msg-1',
      checkpointId: 'chk-source',
      timestamp: 1,
    }),
    event({
      id: 'tool-1',
      conversationId: 'conv-1',
      sequenceNo: 2,
      kind: 'tool',
      title: 'apply_patch completed',
      body: '*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n',
      tool: {
        name: 'functions.apply_patch',
        phase: 'result',
        callId: 'call-a',
        success: true,
      },
      timestamp: 2,
    }),
    event({
      id: 'assistant-1',
      conversationId: 'conv-1',
      sequenceNo: 3,
      kind: 'assistant',
      title: 'Assistant response',
      timestamp: 3,
    }),
    event({
      id: 'revert-1',
      conversationId: 'conv-1',
      sequenceNo: 4,
      kind: 'lifecycle',
      title: 'Selected changes reverted',
      checkpointId: 'chk-revert',
      baseCheckpointId: 'chk-source',
      patchId: 'tool-calls:conv-1:call-a',
      filePaths: ['a.txt'],
      timestamp: 4,
    }),
  ]);
  const entry = context.get('assistant-1');
  assert.ok(entry);
  assert.equal(entry.patchId, 'tool-calls:conv-1:call-a');
  assert.equal(entry.checkpointId, 'chk-source');
  assert.deepEqual(entry.patches, ['*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n']);
  assert.deepEqual(entry.revertedPaths, ['a.txt']);
});

test('buildAssistantPatchContext clears reverted markers when the revert checkpoint is undone', () => {
  const context = buildAssistantPatchContext([
    event({
      id: 'user-1',
      conversationId: 'conv-1',
      sequenceNo: 1,
      kind: 'user',
      title: 'User prompt',
      messageId: 'msg-1',
      checkpointId: 'chk-source',
      timestamp: 1,
    }),
    event({
      id: 'tool-1',
      conversationId: 'conv-1',
      sequenceNo: 2,
      kind: 'tool',
      title: 'apply_patch completed',
      body: '*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n',
      tool: {
        name: 'functions.apply_patch',
        phase: 'result',
        callId: 'call-a',
        success: true,
      },
      timestamp: 2,
    }),
    event({
      id: 'assistant-1',
      conversationId: 'conv-1',
      sequenceNo: 3,
      kind: 'assistant',
      title: 'Assistant response',
      timestamp: 3,
    }),
    event({
      id: 'revert-1',
      conversationId: 'conv-1',
      sequenceNo: 4,
      kind: 'lifecycle',
      title: 'Selected changes reverted',
      checkpointId: 'chk-revert',
      baseCheckpointId: 'chk-source',
      patchId: 'tool-calls:conv-1:call-a',
      filePaths: ['a.txt'],
      timestamp: 4,
    }),
    event({
      id: 'undo-1',
      conversationId: 'conv-1',
      sequenceNo: 5,
      kind: 'lifecycle',
      title: 'Undo restored checkpoint',
      checkpointId: 'chk-revert',
      timestamp: 5,
    }),
  ]);
  const entry = context.get('assistant-1');
  assert.ok(entry);
  assert.equal(entry.patchId, 'tool-calls:conv-1:call-a');
  assert.equal(entry.checkpointId, 'chk-source');
  assert.deepEqual(entry.patches, ['*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n']);
  assert.equal(entry.revertedPaths, undefined);
});

test('buildAssistantPatchContext keeps earlier partial reverts when only the latest revert checkpoint is undone', () => {
  const context = buildAssistantPatchContext([
    event({
      id: 'user-1',
      conversationId: 'conv-1',
      sequenceNo: 1,
      kind: 'user',
      title: 'User prompt',
      messageId: 'msg-1',
      checkpointId: 'chk-source',
      timestamp: 1,
    }),
    event({
      id: 'tool-1',
      conversationId: 'conv-1',
      sequenceNo: 2,
      kind: 'tool',
      title: 'apply_patch completed',
      body: '*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old-a\n+new-a\n*** Update File: b.txt\n@@ -1 +1 @@\n-old-b\n+new-b\n*** Update File: c.txt\n@@ -1 +1 @@\n-old-c\n+new-c\n*** End Patch\n',
      tool: {
        name: 'functions.apply_patch',
        phase: 'result',
        callId: 'call-a',
        success: true,
      },
      timestamp: 2,
    }),
    event({
      id: 'assistant-1',
      conversationId: 'conv-1',
      sequenceNo: 3,
      kind: 'assistant',
      title: 'Assistant response',
      timestamp: 3,
    }),
    event({
      id: 'revert-1',
      conversationId: 'conv-1',
      sequenceNo: 4,
      kind: 'lifecycle',
      title: 'Selected changes reverted',
      checkpointId: 'chk-revert-1',
      baseCheckpointId: 'chk-source',
      patchId: 'tool-calls:conv-1:call-a',
      filePaths: ['a.txt', 'b.txt'],
      timestamp: 4,
    }),
    event({
      id: 'revert-2',
      conversationId: 'conv-1',
      sequenceNo: 5,
      kind: 'lifecycle',
      title: 'Selected changes reverted',
      checkpointId: 'chk-revert-2',
      baseCheckpointId: 'chk-source',
      patchId: 'tool-calls:conv-1:call-a',
      filePaths: ['c.txt'],
      timestamp: 5,
    }),
    event({
      id: 'undo-1',
      conversationId: 'conv-1',
      sequenceNo: 6,
      kind: 'lifecycle',
      title: 'Undo restored checkpoint',
      checkpointId: 'chk-revert-2',
      timestamp: 6,
    }),
  ]);

  const entry = context.get('assistant-1');
  assert.ok(entry);
  assert.equal(entry.patchId, 'tool-calls:conv-1:call-a');
  assert.deepEqual(entry.revertedPaths, ['a.txt', 'b.txt']);
});

test('buildAssistantPatchContext isolates reverted paths to the matching patch card by patch id', () => {
  const context = buildAssistantPatchContext([
    event({
      id: 'user-1',
      conversationId: 'conv-1',
      sequenceNo: 1,
      kind: 'user',
      title: 'User prompt',
      messageId: 'msg-1',
      checkpointId: 'chk-source-1',
      timestamp: 1,
    }),
    event({
      id: 'tool-1',
      conversationId: 'conv-1',
      sequenceNo: 2,
      kind: 'tool',
      title: 'apply_patch completed',
      body: '*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n',
      tool: {
        name: 'functions.apply_patch',
        phase: 'result',
        callId: 'call-a',
        success: true,
      },
      timestamp: 2,
    }),
    event({
      id: 'assistant-1',
      conversationId: 'conv-1',
      sequenceNo: 3,
      kind: 'assistant',
      title: 'Assistant response 1',
      timestamp: 3,
    }),
    event({
      id: 'user-2',
      conversationId: 'conv-1',
      sequenceNo: 4,
      kind: 'user',
      title: 'Second user prompt',
      messageId: 'msg-2',
      checkpointId: 'chk-source-2',
      timestamp: 4,
    }),
    event({
      id: 'tool-2',
      conversationId: 'conv-1',
      sequenceNo: 5,
      kind: 'tool',
      title: 'apply_patch completed',
      body: '*** Begin Patch\n*** Update File: b.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch\n',
      tool: {
        name: 'functions.apply_patch',
        phase: 'result',
        callId: 'call-b',
        success: true,
      },
      timestamp: 5,
    }),
    event({
      id: 'assistant-2',
      conversationId: 'conv-1',
      sequenceNo: 6,
      kind: 'assistant',
      title: 'Assistant response 2',
      timestamp: 6,
    }),
    event({
      id: 'revert-2',
      conversationId: 'conv-1',
      sequenceNo: 7,
      kind: 'lifecycle',
      title: 'Selected changes reverted',
      checkpointId: 'chk-revert-2',
      baseCheckpointId: 'chk-source-2',
      patchId: 'tool-calls:conv-1:call-b',
      filePaths: ['b.txt'],
      timestamp: 7,
    }),
  ]);

  const firstEntry = context.get('assistant-1');
  const secondEntry = context.get('assistant-2');
  assert.ok(firstEntry);
  assert.ok(secondEntry);
  assert.equal(firstEntry?.patchId, 'tool-calls:conv-1:call-a');
  assert.equal(secondEntry?.patchId, 'tool-calls:conv-1:call-b');
  assert.equal(firstEntry?.revertedPaths, undefined);
  assert.deepEqual(secondEntry?.revertedPaths, ['b.txt']);
});

test('buildRenderGroups keeps the active group expanded while sending', () => {
  const events = [
    event({ id: 'user-1', conversationId: 'conv-1', sequenceNo: 1, kind: 'user', title: 'user', timestamp: 1 }),
    event({ id: 'tool-1', conversationId: 'conv-1', sequenceNo: 2, kind: 'tool', title: 'tool', timestamp: 2 }),
    event({ id: 'assistant-1', conversationId: 'conv-1', sequenceNo: 3, kind: 'assistant', title: 'assistant', timestamp: 3 }),
  ];
  const groups = buildActivityGroups(events);
  const eventsById = Object.fromEntries(events.map((item) => [item.id, item]));
  const renderGroups = buildRenderGroups(groups, eventsById, false, true);

  assert.deepEqual(
    renderGroups.map((group) => ({
      type: group.type,
      ids: group.events.map((item) => item.id),
      defaultExpanded: group.defaultExpanded ?? false,
    })),
    [
      { type: 'single', ids: ['user-1'], defaultExpanded: false },
      { type: 'intermediate', ids: ['tool-1'], defaultExpanded: true },
      { type: 'single', ids: ['assistant-1'], defaultExpanded: false },
    ],
  );
});

test('buildRenderGroups keeps all non-terminal events in the intermediate group', () => {
  const events = [
    event({ id: 'user-1', conversationId: 'conv-1', sequenceNo: 1, kind: 'user', title: 'user', timestamp: 1 }),
    event({ id: 'thought-1', conversationId: 'conv-1', sequenceNo: 2, kind: 'thought', title: 'thought', timestamp: 2 }),
    event({ id: 'tool-1', conversationId: 'conv-1', sequenceNo: 3, kind: 'tool', title: 'tool', timestamp: 3 }),
    event({ id: 'status-1', conversationId: 'conv-1', sequenceNo: 4, kind: 'status', title: 'status', timestamp: 4 }),
  ];
  const groups = buildActivityGroups(events);
  const eventsById = Object.fromEntries(events.map((item) => [item.id, item]));
  const renderGroups = buildRenderGroups(groups, eventsById, false, true);

  assert.deepEqual(
    renderGroups.map((group) => ({
      type: group.type,
      ids: group.events.map((item) => item.id),
      defaultExpanded: group.defaultExpanded ?? false,
    })),
    [
      { type: 'single', ids: ['user-1'], defaultExpanded: false },
      { type: 'intermediate', ids: ['thought-1', 'tool-1', 'status-1'], defaultExpanded: true },
    ],
  );
});
