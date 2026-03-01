import type { LoopStreamPacket } from '../electron';
import type { ActivityEvent } from '../types/ui';
import {
  type ActivityInput,
  parseStatusLine,
  parseToolCommand,
  summarizeToolBody,
} from '../utils/activityTimeline';
import {
  asRecord,
  extractMessageText,
  getBoolean,
  getField,
  getString,
  parseToolResultPayload,
  shortID,
} from '../utils/parsers';
import { COMMAND_APPROVAL_KINDS, TERMINAL_TURN_KINDS } from './useLoopDesktop.constants';
import { getNumber, parseCommandApprovalEvent } from './useLoopDesktop.helpers';
import type { ConversationLiveState, NoticeTone, PendingCommandApproval } from './useLoopDesktop.types';

export interface TurnEventHandlerDeps {
  appendStreamingText: (conversationId: string, kind: 'assistant' | 'thought', text: string) => void;
  finalizeTurn: (closeStream: boolean, conversationId?: string) => void;
  getConversationLiveState: (conversationId: string) => ConversationLiveState;
  mutateActivity: (id: string, transform: (event: ActivityEvent) => ActivityEvent) => void;
  pushActivity: (input: ActivityInput) => string;
  settleThoughtDraft: (conversationId: string) => void;
  setCurrentStatus: (value: string) => void;
}

export function createHandleTurnEvent(deps: TurnEventHandlerDeps) {
  const {
    appendStreamingText,
    finalizeTurn,
    getConversationLiveState,
    mutateActivity,
    pushActivity,
    settleThoughtDraft,
    setCurrentStatus,
  } = deps;

  return (eventName: string, data: unknown, conversationId: string): void => {
    const eventRecord = asRecord(data);
    const kind = getString(eventRecord, ['kind']) || eventName;
    const liveState = getConversationLiveState(conversationId);

    if (kind === 'state_transition') {
      const transition = asRecord(getField(eventRecord, ['state_transition'])) ?? eventRecord;
      const from = getString(transition, ['from']);
      const to = getString(transition, ['to']);
      const reason = getString(transition, ['reason']);
      if (!to) {
        console.warn('[loop-ui] skipping malformed state_transition event', eventRecord);
        return;
      }
      if (to === 'turn_completed') {
        liveState.openToolEventIDs = {};
        finalizeTurn(false, conversationId);
        return;
      }
      if (to === 'turn_aborted' || to === 'turn_failed') {
        liveState.openToolEventIDs = {};
        finalizeTurn(false, conversationId);
      }
      pushActivity({
        kind: 'lifecycle',
        title: from ? `State: ${from} -> ${to}` : `State: ${to}`,
        body: reason || undefined,
      });
      return;
    }

    if (kind === 'model_wait_started') {
      const payload = asRecord(getField(eventRecord, ['model_wait_started'])) ?? eventRecord;
      const attempt = getNumber(payload, ['attempt']);
      const model = getString(payload, ['model']);
      const title = Number.isFinite(attempt) && attempt > 0
        ? `Model wait started (attempt ${attempt})`
        : 'Model wait started';
      setCurrentStatus(title);
      pushActivity({
        kind: 'lifecycle',
        title,
        body: model ? `Model: ${model}` : undefined,
      });
      return;
    }

    if (kind === 'model_wait_finished') {
      const payload = asRecord(getField(eventRecord, ['model_wait_finished'])) ?? eventRecord;
      const timings = asRecord(getField(payload, ['timings']));
      const outcome = getString(payload, ['outcome']) || 'unknown';
      const totalMs = getNumber(timings, ['total_ms', 'totalMS']);
      const ttftMs = getNumber(timings, ['wait_for_first_token_ms', 'waitForFirstTokenMS']);
      const streamMs = getNumber(timings, ['stream_ms', 'streamMS']);
      const parts: string[] = [];
      if (Number.isFinite(ttftMs)) {
        parts.push(`TTFT ${Math.round(ttftMs)}ms`);
      }
      if (Number.isFinite(streamMs)) {
        parts.push(`Stream ${Math.round(streamMs)}ms`);
      }
      if (Number.isFinite(totalMs)) {
        parts.push(`Total ${Math.round(totalMs)}ms`);
      }
      const errorText = getString(payload, ['error']);
      pushActivity({
        kind: outcome === 'error' ? 'error' : 'status',
        title: `Model wait finished (${outcome})`,
        body: [parts.join(' · '), errorText].filter(Boolean).join('\n') || undefined,
      });
      return;
    }

    if (kind === 'thread_status') {
      const payload = asRecord(getField(eventRecord, ['thread_status'])) ?? eventRecord;
      const text = getString(payload, ['text']) || '';
      const threadId = getString(payload, ['thread_id', 'threadId']);
      const status = getString(payload, ['status']);
      const phase = getString(payload, ['phase']);
      const errorText = getString(payload, ['error']);
      pushActivity({
        kind: 'thread',
        title: text || `Thread ${threadId ? shortID(threadId) : ''}`.trim(),
        body: [status ? `Status: ${status}` : '', phase ? `Phase: ${phase}` : '', errorText].filter(Boolean).join('\n') || undefined,
      });
      return;
    }

    if (kind === 'retry') {
      const retryRecord = asRecord(getField(eventRecord, ['retry'])) ?? eventRecord;
      const message = getString(retryRecord, ['message']) || 'Temporary server issue. Retrying...';
      const attempt = getNumber(retryRecord, ['attempt']);
      const maxAttempts = getNumber(retryRecord, ['max_attempts', 'maxAttempts']);
      const secondsRemaining = getNumber(retryRecord, ['seconds_remaining', 'secondsRemaining']);
      const hasAttempt = Number.isFinite(attempt) && Number.isFinite(maxAttempts) && attempt > 0 && maxAttempts > 0;
      const body = hasAttempt ? `Server retry ${attempt}/${maxAttempts}` : undefined;

      if (message && message !== liveState.lastStatus) {
        liveState.lastStatus = message;
        setCurrentStatus(message);
      }

      if (liveState.retryStatusEventID) {
        mutateActivity(liveState.retryStatusEventID, (event) => ({
          ...event,
          title: message || event.title,
          body,
          timestamp: Date.now(),
        }));
      } else {
        liveState.retryStatusEventID = pushActivity({
          kind: 'status',
          title: message,
          body,
        });
      }

      if (Number.isFinite(secondsRemaining) && secondsRemaining <= 0) {
        liveState.retryStatusEventID = null;
      }
      return;
    }

    if (kind === 'status') {
      const statusText = getString(asRecord(getField(eventRecord, ['status'])), ['text']);
      if (!statusText) {
        return;
      }
      if (statusText === liveState.lastStatus) {
        return;
      }
      liveState.lastStatus = statusText;
      setCurrentStatus(statusText);

      if (statusText.startsWith('Service unavailable (503). Retrying in ')) {
        if (liveState.retryStatusEventID) {
          mutateActivity(liveState.retryStatusEventID, (event) => ({
            ...event,
            title: statusText,
            timestamp: Date.now(),
          }));
        } else {
          liveState.retryStatusEventID = pushActivity({ kind: 'status', title: statusText });
        }
        return;
      }
      liveState.retryStatusEventID = null;

      const parsed = parseStatusLine(statusText);
      if (parsed?.kind === 'lifecycle' && parsed.title.startsWith('Executing ')) {
        // Match history grouping: once tool execution begins, next thought chunk starts a new row.
        settleThoughtDraft(conversationId);
      }
      if (parsed && parsed.kind !== 'tool') {
        pushActivity(parsed);
      }
      return;
    }

    if (kind === 'delta') {
      const deltaRecord = asRecord(getField(eventRecord, ['delta']));
      const text = getString(deltaRecord, ['text']);
      const isThought = getBoolean(deltaRecord, ['is_thought']);
      if (!text) {
        return;
      }

      appendStreamingText(conversationId, isThought ? 'thought' : 'assistant', text);
      return;
    }

    if (kind === 'tool_call_start') {
      // Start a fresh thought segment after this tool boundary.
      settleThoughtDraft(conversationId);

      const toolCall = asRecord(getField(eventRecord, ['tool_call']));
      const toolName = getString(toolCall, ['name']) || 'unknown tool';
      const callID = getString(toolCall, ['call_id']);
      const args = getString(toolCall, ['args']);
      const command = parseToolCommand(toolName, args);
      const parsedArgs = parseToolResultPayload(args);
      const eventID = pushActivity({
        kind: 'tool',
        title: 'Tool call started',
        body: command || args || undefined,
        tool: {
          name: toolName,
          phase: 'start',
          callId: callID || undefined,
          command: command || undefined,
          args: parsedArgs,
        },
      });
      if (callID) {
        liveState.openToolEventIDs[callID] = eventID;
      }
      return;
    }

    if (kind === 'tool_result') {
      // Defensive split for streams that may emit result without a prior start event.
      settleThoughtDraft(conversationId);

      const toolResult = asRecord(getField(eventRecord, ['tool_result']));
      const toolName = getString(toolResult, ['name']) || 'unknown tool';
      const success = getBoolean(toolResult, ['success']);
      const resultText = getString(toolResult, ['result']);
      const errorText = getString(toolResult, ['error']);
      const argsText = getString(toolResult, ['args']);
      const callID = getString(toolResult, ['call_id']);
      const summary = summarizeToolBody(toolName, resultText, errorText);
      const parsedPayload = parseToolResultPayload(resultText);
      const parsedArgs = parseToolResultPayload(argsText);
      const openEventID = callID ? liveState.openToolEventIDs[callID] : '';

      if (openEventID) {
        mutateActivity(openEventID, (event) => ({
          ...event,
          title: success
            ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}`
            : `${toolName} failed`,
          body: summary.body || undefined,
          tool: {
            ...(event.tool ?? { name: toolName, phase: 'start' as const }),
            name: toolName,
            phase: 'result',
            callId: callID || undefined,
            success,
            resultSummary: summary.title,
            error: errorText || undefined,
            args: event.tool?.args ?? parsedArgs,
            payload: parsedPayload,
          },
          streaming: false,
        }));
        delete liveState.openToolEventIDs[callID];
      } else {
        pushActivity({
          kind: 'tool',
          title: success
            ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}`
            : `${toolName} failed`,
          body: summary.body || undefined,
          tool: {
            name: toolName,
            phase: 'result',
            callId: callID || undefined,
            success,
            resultSummary: summary.title,
            error: errorText || undefined,
            args: parsedArgs,
            payload: parsedPayload,
          },
        });
      }

      const parsedResult = parseToolResultPayload(resultText);
      if (toolName === 'spawn_thread' && parsedResult) {
        const threadID = getString(parsedResult, ['thread_id']);
        if (threadID) {
          const anchorID = getString(parsedResult, ['anchor_message_id']);
          const mode = getString(parsedResult, ['mode']);
          pushActivity({
            kind: 'thread',
            title: `Thread spawned: ${shortID(threadID)}${mode ? ` (${mode})` : ''}`,
            body: anchorID ? `anchor ${shortID(anchorID)}` : undefined,
          });
        }
      }

      if (toolName === 'await_thread' && parsedResult) {
        const threadID = getString(parsedResult, ['thread_id']);
        const status = getString(parsedResult, ['status']);
        if (threadID) {
          pushActivity({
            kind: 'thread',
            title: `Thread awaited: ${shortID(threadID)}`,
            body: status ? `Status: ${status}` : undefined,
          });
        }
      }
      return;
    }

    if (kind === 'message_done') {
      const messageRecord = getField(eventRecord, ['message']);
      const messageText = extractMessageText(messageRecord);
      if (!messageText) {
        return;
      }

      const draftID = liveState.draftAssistantId;
      if (!draftID) {
        liveState.draftAssistantId = pushActivity({
          kind: 'assistant',
          title: 'Assistant response',
          body: messageText,
          streaming: true,
        });
        return;
      }

      mutateActivity(draftID, (event) => ({ ...event, body: messageText, streaming: true }));
      return;
    }

    if (kind === 'error') {
      const errorText = getString(eventRecord, ['error']) || 'Agent returned an error event.';
      pushActivity({ kind: 'error', title: 'Model execution error', body: errorText });
      liveState.openToolEventIDs = {};
      finalizeTurn(false, conversationId);
      return;
    }

    if (kind === 'turn_started') {
      return;
    }

    if (kind === 'turn_aborted') {
      pushActivity({
        kind: 'lifecycle',
        title: 'Turn aborted',
        body: getString(eventRecord, ['error']) || undefined,
      });
      liveState.openToolEventIDs = {};
      finalizeTurn(false, conversationId);
      return;
    }

    if (kind === 'turn_complete') {
      liveState.openToolEventIDs = {};
      finalizeTurn(false, conversationId);
      return;
    }

    console.warn(`[loop-ui] skipping unknown turn event kind=${kind}`, eventRecord);
  };
}

export interface StreamPacketHandlerDeps {
  enqueueCommandApproval: (approval: PendingCommandApproval) => void;
  finalizeTurn: (closeStream: boolean, conversationId?: string) => void;
  getActiveStreamId: (conversationId: string) => string | undefined;
  getConversationLiveState: (conversationId: string) => ConversationLiveState;
  handleTurnEvent: (eventName: string, data: unknown, conversationId: string) => void;
  pushActivity: (input: ActivityInput) => string;
  pushNotice: (tone: NoticeTone, message: string) => void;
  getSelectedConversationId: () => string;
}

export function createHandleStreamPacket(deps: StreamPacketHandlerDeps) {
  const {
    enqueueCommandApproval,
    finalizeTurn,
    getActiveStreamId,
    getConversationLiveState,
    handleTurnEvent,
    pushActivity,
    pushNotice,
    getSelectedConversationId,
  } = deps;

  return (packet: LoopStreamPacket, conversationId: string): void => {
    const activeStreamId = getActiveStreamId(conversationId);
    if (!activeStreamId || packet.streamId !== activeStreamId) {
      return;
    }

    const isViewingStreamConversation = conversationId === getSelectedConversationId();

    if (packet.type === 'event') {
      const eventRecord = asRecord(packet.data);
      const kind = getString(eventRecord, ['kind']) || packet.eventName || 'message';
      if (COMMAND_APPROVAL_KINDS.has(kind)) {
        const approval = parseCommandApprovalEvent(eventRecord, conversationId);
        if (approval) {
          enqueueCommandApproval(approval);
          if (isViewingStreamConversation) {
            pushActivity({
              kind: 'lifecycle',
              title: 'Command approval required',
              body: `${approval.toolName}: ${approval.command}`,
            });
          } else {
            pushNotice('info', `Command approval required for ${shortID(approval.conversationId)}.`);
          }
        }
        return;
      }
      if (!isViewingStreamConversation) {
        // We intentionally skip rendering background activity to avoid mixing
        // timeline rows across conversations, but terminal events must still
        // close background stream state.
        if (TERMINAL_TURN_KINDS.has(kind)) {
          const liveState = getConversationLiveState(conversationId);
          liveState.openToolEventIDs = {};
          finalizeTurn(true, conversationId);
          console.debug(
            `[loop-stream] finalized background conversation=${shortID(conversationId)} kind=${kind}`,
          );
        }
        return;
      }
      handleTurnEvent(packet.eventName ?? 'message', packet.data, conversationId);
      return;
    }

    if (packet.type === 'error') {
      if (isViewingStreamConversation) {
        pushActivity({ kind: 'error', title: 'Stream transport error', body: packet.error ?? '' });
      }
      const liveState = getConversationLiveState(conversationId);
      liveState.openToolEventIDs = {};
      finalizeTurn(true, conversationId);
      return;
    }

    if (packet.type === 'aborted') {
      if (isViewingStreamConversation && packet.error) {
        pushActivity({ kind: 'lifecycle', title: 'Turn canceled', body: packet.error });
      }
      const liveState = getConversationLiveState(conversationId);
      liveState.openToolEventIDs = {};
      finalizeTurn(true, conversationId);
      return;
    }

    if (packet.type === 'done') {
      const liveState = getConversationLiveState(conversationId);
      liveState.openToolEventIDs = {};
      finalizeTurn(true, conversationId);
    }
  };
}
