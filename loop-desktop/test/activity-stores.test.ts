import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActivityEvent } from '../src/types/ui.ts';
import { useConversationStore } from '../src/stores/conversationStore.ts';
import { buildActivityGroups } from '../src/stores/groupStore.ts';
import { buildRenderGroups } from '../src/utils/activityRenderGroups.ts';
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

test('buildRenderGroups shows the latest event when no assistant reply exists', () => {
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
      { type: 'intermediate', ids: ['thought-1', 'tool-1'], defaultExpanded: true },
      { type: 'single', ids: ['status-1'], defaultExpanded: false },
    ],
  );
});
