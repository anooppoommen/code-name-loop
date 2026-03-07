import type { ActivityEvent, ActivityKind } from '../types/ui';
import {
  asRecord,
  extractMessageText,
  getBoolean,
  getField,
  getString,
  parseToolResultPayload,
  trimForUI,
  extractMessageImages,
} from './parsers.ts';

export interface ActivityInput {
  kind: ActivityKind;
  title: string;
  body?: string;
  streaming?: boolean;
  tool?: ActivityEvent['tool'];
  images?: { mimeType: string; dataUrl: string }[];
  userTurn?: ActivityEvent['userTurn'];
  checkpointId?: string;
  checkpointReason?: string;
  baseCheckpointId?: string;
  patchId?: string;
  filePaths?: string[];
}

function isApplyPatch(toolName: string): boolean {
  return toolNameMatches(toolName, 'apply_patch');
}

function isExecCommand(toolName: string): boolean {
  return toolNameMatches(toolName, 'exec_command');
}

function isRequestUserInput(toolName: string): boolean {
  return toolNameMatches(toolName, 'request_user_input');
}

function isUpdatePlan(toolName: string): boolean {
  return toolNameMatches(toolName, 'update_plan');
}

function isParallelToolUse(toolName: string): boolean {
  return toolNameMatches(toolName, 'parallel_tool_use');
}

function isReadFile(toolName: string): boolean {
  return toolNameMatches(toolName, 'read_file');
}

function toolNameMatches(toolName: string, canonical: string): boolean {
  return (
    toolName === canonical ||
    toolName.endsWith(`:${canonical}`) ||
    toolName.endsWith(`.${canonical}`)
  );
}

export function parseStatusLine(statusText: string): ActivityInput | null {
  if (statusText.startsWith('thinking')) {
    // Thought bodies are rendered from dedicated thought delta events.
    return null;
  }

  if (/^tool\s+\d+\/\d+\s+/.test(statusText)) {
    // Tool start/result rows are rendered from structured tool events.
    return null;
  }

  if (statusText.startsWith('turn started')) {
    return { kind: 'status', title: statusText };
  }

  if (statusText.startsWith('turn complete')) {
    return { kind: 'lifecycle', title: 'Turn completed' };
  }

  if (statusText.startsWith('model call started')) {
    return { kind: 'lifecycle', title: 'Model call started' };
  }

  if (statusText.startsWith('model produced final response')) {
    return { kind: 'lifecycle', title: 'Model produced final response' };
  }

  const executingMatch = statusText.match(/^executing\s+(\d+)\s+tool call\(s\):\s+(.+)$/);
  if (executingMatch) {
    return {
      kind: 'lifecycle',
      title: `Executing ${executingMatch[1]} tool call(s)`,
      body: executingMatch[2],
    };
  }

  if (statusText.startsWith('[thread ')) {
    return { kind: 'thread', title: statusText };
  }

  return { kind: 'status', title: statusText };
}

export function summarizeToolBody(toolName: string, resultText: string, errorText: string): { title: string; body: string } {
  if (errorText) {
    return { title: 'error', body: trimForUI(errorText, 500) };
  }

  const parsed = parseToolResultPayload(resultText);
  if (parsed) {
    const embeddedError = getString(parsed, ['error']);
    if (embeddedError) {
      return { title: 'error', body: trimForUI(embeddedError, 500) };
    }

    if (isRequestUserInput(toolName)) {
      const questions = getArray(parsed, ['questions']);
      const reason = getString(parsed, ['reason']);
      const parts: string[] = [];
      if (questions.length > 0) {
        parts.push(`${questions.length} question${questions.length === 1 ? '' : 's'} waiting for user input.`);
      }
      if (reason) {
        parts.push(reason);
      }
      return {
        title: 'input required',
        body: trimForUI(parts.join('\n') || 'User input required.', 900),
      };
    }

    if (isUpdatePlan(toolName)) {
      const planLines = summarizePlanRows(parsed);
      return {
        title: 'plan updated',
        body: trimForUI(planLines || 'Plan updated.', 900),
      };
    }

    if (isParallelToolUse(toolName)) {
      const summary = summarizeParallelRows(parsed);
      return {
        title: 'parallel run',
        body: trimForUI(summary || 'Parallel tool run completed.', 900),
      };
    }

    if (isReadFile(toolName)) {
      return {
        title: 'file read',
        body: '', // We don't want to show the file contents
      };
    }

    const output = getString(parsed, ['output']);
    if (output) {
      if (isExecCommand(toolName)) {
        const wall = output.match(/Wall time:\s*([^\n]+)/)?.[1] ?? '';
        const exit = output.match(/Process exited with code\s+([^\n]+)/)?.[1] ?? '';
        const commandOutput = output.split('Output:\n')[1] ?? '';
        const titleParts = [wall ? `wall ${wall}` : '', exit ? `exit ${exit}` : ''].filter(Boolean);
        return {
          title: titleParts.join(' · ') || 'exec result',
          body: trimForUI(commandOutput || output, 900),
        };
      }
      return { title: 'output', body: trimForUI(output, 900) };
    }

    const message = getString(parsed, ['message', 'result']);
    if (message) {
      return { title: 'result', body: trimForUI(message, 900) };
    }
  }

  if (!resultText) {
    return { title: '', body: '' };
  }

  return { title: 'raw', body: trimForUI(resultText, 900) };
}

export function historyRowsToActivities(items: unknown[]): ActivityEvent[] {
  const activityRows: ActivityEvent[] = [];
  const toolResultCallIDs = collectPersistedToolResultCallIDs(items);
  const openToolByCallID = new Map<string, number>();
  let fallbackSequenceNo = 1;

  for (const item of items) {
    const record = asRecord(item);
    const type = getString(record, ['type', 'Type']);
    const timelineSeq = getNumber(record, ['timeline_seq', 'timelineSeq']) ?? undefined;
    const sequenceNo = timelineSeq ?? fallbackSequenceNo++;

    if (type === 'message') {
      const msg = asRecord(getField(record, ['message', 'Message']));
      const msgID = getString(msg, ['ID', 'id']) || crypto.randomUUID();
      const conversationId = getString(msg, ['ConversationID', 'conversation_id', 'conversationId']);
      const msgSeq = getNumber(msg, ['Seq', 'seq']) ?? undefined;
      const msgVersion = getNumber(msg, ['Version', 'version']) ?? undefined;
      const msgArchived = getBoolean(msg, ['Archived', 'archived']);
      const sentBy = getString(msg, ['SentBy', 'sent_by', 'sentBy']);
      if (sentBy === 'user') {
        const metadata = asRecord(getField(msg, ['Metadata', 'metadata']));
        if (getBoolean(metadata, ['hidden_from_ui', 'hiddenFromUI'])) {
          continue;
        }
        const text = extractMessageText(msg);
        const images = extractMessageImages(msg);
        const checkpointId = getString(metadata, ['checkpoint_id', 'checkpointId']);
        const userTurn = userTurnFromMetadata(metadata);
        if (text || images.length > 0) {
          activityRows.push({
            id: msgID,
            conversationId,
            sequenceNo,
            timelineSeq,
            messageId: msgID,
            messageSeq: msgSeq,
            messageVersion: msgVersion,
            archived: msgArchived,
            kind: 'user',
            title: 'User prompt',
            body: text || '(Images attached)',
            userTurn,
            checkpointId: checkpointId || undefined,
            timestamp: messageTimestamp(msg),
            images,
          });
        }
      } else if (sentBy === 'agent') {
        const text = extractMessageText(msg);
        const images = extractMessageImages(msg);
        if (text || images.length > 0) {
          activityRows.push({
            id: msgID,
            conversationId,
            sequenceNo,
            timelineSeq,
            messageId: msgID,
            messageSeq: msgSeq,
            messageVersion: msgVersion,
            archived: msgArchived,
            kind: 'assistant',
            title: 'Assistant response',
            body: text || '(Images attached)',
            timestamp: messageTimestamp(msg),
            images,
          });
        }
      } else if (sentBy === 'tool') {
        activityRows.push(...toolMessageToActivities(msg, toolResultCallIDs, sequenceNo, timelineSeq));
      }
    } else if (type === 'ui_event') {
      const uiEvt = asRecord(getField(record, ['ui_event', 'UIEvent']));
      const id = getString(uiEvt, ['id', 'ID']) || crypto.randomUUID();
      const conversationId = getString(uiEvt, ['conversation_id', 'ConversationID', 'conversationId']);
      const messageId = getString(uiEvt, ['message_id', 'MessageID', 'messageId']) || undefined;
      const eventSeq = getNumber(uiEvt, ['seq', 'Seq']) ?? undefined;
      const messageVersion = getNumber(uiEvt, ['version', 'Version']) ?? undefined;
      const archived = getBoolean(uiEvt, ['archived', 'Archived']);
      const kind = getString(uiEvt, ['kind', 'Kind']);
      const text = getString(uiEvt, ['text', 'Text']);
      const timestamp = messageTimestamp(uiEvt);
      const metadata = asRecord(getField(uiEvt, ['metadata', 'Metadata'])) || {};

      switch (kind) {
        case 'thought': {
          appendThoughtChunk(activityRows, {
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            timestamp,
            text,
          });
          break;
        }
        case 'tool_start': {
          const callId = getString(metadata, ['call_id', 'callId']);
          const toolName = getString(metadata, ['tool_name']);
          const argsText = getString(metadata, ['args']);
          const parsedArgs = parseToolResultPayload(argsText);
          const command = parseToolCommand(toolName, argsText);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'tool',
            title: `${toolName || 'tool'} started`,
            body: isApplyPatch(toolName) ? (command || argsText || text || undefined) : (trimForUI(command || argsText || text, 900) || undefined),
            timestamp,
            tool: {
              name: toolName || 'tool',
              phase: 'start',
              callId: callId || undefined,
              command: command || undefined,
              args: parsedArgs,
            },
          });
          if (callId) {
            openToolByCallID.set(callId, activityRows.length - 1);
          }
          break;
        }
        case 'tool_result': {
          const callId = getString(metadata, ['call_id', 'callId']);
          const toolName = getString(metadata, ['tool_name']) || 'tool';
          const success = getBoolean(metadata, ['success']);
          const resultText = getString(metadata, ['result']);
          const errorMsg = getString(metadata, ['error']);
          const argsText = getString(metadata, ['args']);
          const parsedArgs = parseToolResultPayload(argsText);
          const summary = summarizeToolBody(toolName, resultText, errorMsg);
          const fallbackBody = success ? text : errorMsg || text;
          const mergedCommand = parseToolCommand(toolName, argsText);
          const parsedPayload = parseToolResultPayload(resultText);

          const existingIndex = callId ? openToolByCallID.get(callId) : undefined;
          if (existingIndex !== undefined) {
            const existing = activityRows[existingIndex];
            if (existing && existing.kind === 'tool') {
              activityRows[existingIndex] = {
                ...existing,
                conversationId,
                sequenceNo,
                timelineSeq,
                eventSeq,
                messageId,
                messageVersion,
                archived,
                title: success ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}` : `${toolName} failed`,
                body: isApplyPatch(toolName) ? (summary.body || fallbackBody || undefined) : (summary.body || trimForUI(fallbackBody, 900) || undefined),
                tool: {
                  ...(existing.tool ?? { name: toolName, phase: 'start' as const }),
                  name: toolName,
                  phase: 'result',
                  callId: callId || undefined,
                  success,
                  resultSummary: summary.title || undefined,
                  error: errorMsg || undefined,
                  command: existing.tool?.command || mergedCommand || undefined,
                  args: existing.tool?.args ?? parsedArgs,
                  payload: parsedPayload,
                },
              };
              openToolByCallID.delete(callId);
              break;
            }
          }

          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'tool',
            title: success ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}` : `${toolName} failed`,
            body: isApplyPatch(toolName) ? (summary.body || fallbackBody || undefined) : (summary.body || trimForUI(fallbackBody, 900) || undefined),
            timestamp,
            tool: {
              name: toolName,
              phase: 'result',
              callId: callId || undefined,
              success,
              resultSummary: summary.title || undefined,
              error: errorMsg || undefined,
              command: mergedCommand || undefined,
              args: parsedArgs,
              payload: parsedPayload,
            },
          });
          break;
        }
        case 'thread_status': {
          const parsed = parseStatusLine(text);
          if (parsed) {
            activityRows.push(statusInputToEvent(id, conversationId, sequenceNo, timestamp, parsed, {
              timelineSeq,
              eventSeq,
              messageId,
              messageVersion,
              archived,
            }));
          } else {
            activityRows.push({
              id,
              conversationId,
              sequenceNo,
              timelineSeq,
              eventSeq,
              messageId,
              messageVersion,
              archived,
              kind: 'thread',
              title: text || 'Thread update',
              timestamp,
            });
          }
          break;
        }
        case 'state_transition': {
          const from = getString(metadata, ['from']);
          const to = getString(metadata, ['to']);
          const reason = getString(metadata, ['reason']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: from && to ? `State: ${from} -> ${to}` : text || 'State transition',
            body: reason || undefined,
            timestamp,
          });
          break;
        }
        case 'model_wait_started': {
          const attempt = getNumber(metadata, ['attempt']);
          const model = getString(metadata, ['model']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: attempt !== null ? `Model wait started (attempt ${attempt})` : (text || 'Model wait started'),
            body: model ? `Model: ${model}` : undefined,
            timestamp,
          });
          break;
        }
        case 'model_wait_finished': {
          const outcome = getString(metadata, ['outcome']);
          const timings = asRecord(getField(metadata, ['timings']));
          const totalMS = getNumber(timings, ['total_ms', 'totalMS']);
          const waitMS = getNumber(timings, ['wait_for_first_token_ms', 'waitForFirstTokenMS']);
          const streamMS = getNumber(timings, ['stream_ms', 'streamMS']);
          const parts: string[] = [];
          if (waitMS !== null) {
            parts.push(`TTFT ${Math.round(waitMS)}ms`);
          }
          if (streamMS !== null) {
            parts.push(`Stream ${Math.round(streamMS)}ms`);
          }
          if (totalMS !== null) {
            parts.push(`Total ${Math.round(totalMS)}ms`);
          }
          const error = getString(metadata, ['error']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: outcome === 'error' ? 'error' : 'status',
            title: outcome ? `Model wait finished (${outcome})` : (text || 'Model wait finished'),
            body: [parts.join(' · '), error].filter(Boolean).join('\n') || undefined,
            timestamp,
          });
          break;
        }
        case 'approval_request': {
          const command = getString(metadata, ['command']);
          const toolName = getString(metadata, ['tool_name']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: 'Command approval required',
            body: `${toolName || 'tool'}: ${command || text}`.trim(),
            timestamp,
          });
          break;
        }
        case 'status': {
          const parsed = parseStatusLine(text);
          if (parsed) {
            activityRows.push(statusInputToEvent(id, conversationId, sequenceNo, timestamp, parsed, {
              timelineSeq,
              eventSeq,
              messageId,
              messageVersion,
              archived,
            }));
          }
          break;
        }
        case 'error': {
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'error',
            title: 'Agent error',
            body: text,
            timestamp,
          });
          break;
        }
        case 'abort': {
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: 'Turn aborted',
            body: text || undefined,
            timestamp,
          });
          break;
        }
        case 'checkpoint_created': {
          const checkpointId = getString(metadata, ['checkpoint_id', 'checkpointId']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: 'Checkpoint created',
            body: text || undefined,
            checkpointId: checkpointId || undefined,
            checkpointReason: getString(metadata, ['reason']),
            timestamp,
          });
          break;
        }
        case 'checkpoint_restored': {
          const checkpointId = getString(metadata, ['checkpoint_id', 'checkpointId']);
          const reason = getString(metadata, ['reason']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: reason === 'undo_latest' ? 'Undo restored checkpoint' : 'Checkpoint restored',
            body: text || undefined,
            checkpointId: checkpointId || undefined,
            checkpointReason: reason || undefined,
            timestamp,
          });
          break;
        }
        case 'checkpoint_restore_failed': {
          const checkpointId = getString(metadata, ['checkpoint_id', 'checkpointId']);
          const reason = getString(metadata, ['reason']);
          const error = getString(metadata, ['error']);
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'error',
            title: reason === 'undo_latest' ? 'Undo restore failed' : 'Checkpoint restore failed',
            body: text || error || undefined,
            checkpointId: checkpointId || undefined,
            checkpointReason: reason || undefined,
            timestamp,
          });
          break;
        }
        case 'workspace_changes_applied': {
          const checkpointId = getString(metadata, ['checkpoint_id', 'checkpointId']);
          const baseCheckpointId = getString(metadata, ['base_checkpoint_id', 'baseCheckpointId']);
          const patchId = getString(metadata, ['patch_id', 'patchId']);
          const reason = getString(metadata, ['reason']);
          const fileCount = getNumber(metadata, ['file_count', 'fileCount']);
          const rawPaths = getField(metadata, ['file_paths', 'filePaths']);
          const filePaths = Array.isArray(rawPaths)
            ? rawPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : [];
          activityRows.push({
            id,
            conversationId,
            sequenceNo,
            timelineSeq,
            eventSeq,
            messageId,
            messageVersion,
            archived,
            kind: 'lifecycle',
            title: reason === 'manual_revert' ? 'Selected changes reverted' : 'Workspace changes applied',
            body: text || (fileCount ? `Updated ${fileCount} file(s)` : undefined),
            checkpointId: checkpointId || undefined,
            checkpointReason: reason || undefined,
            baseCheckpointId: baseCheckpointId || undefined,
            patchId: patchId || undefined,
            filePaths: filePaths.length > 0 ? filePaths : undefined,
            timestamp,
          });
          break;
        }
      }
    }
  }

  return activityRows;
}

// Removed messageRecordToActivities since logic is natively handled by the Timeline endpoint now

function messageTimestamp(record: Record<string, unknown> | null): number {
  const createdAt = getString(record, ['CreatedAt', 'created_at', 'createdAt']);
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) {
    return Date.now();
  }
  return parsed;
}

function statusInputToEvent(
  id: string,
  conversationId: string,
  sequenceNo: number,
  timestamp: number,
  input: ActivityInput,
  metadata?: {
    timelineSeq?: number;
    eventSeq?: number;
    messageId?: string;
    messageVersion?: number;
    archived?: boolean;
  },
): ActivityEvent {
  return {
    id,
    conversationId,
    sequenceNo,
    timelineSeq: metadata?.timelineSeq,
    eventSeq: metadata?.eventSeq,
    messageId: metadata?.messageId,
    messageVersion: metadata?.messageVersion,
    archived: metadata?.archived,
    timestamp,
    kind: input.kind,
    title: input.title,
    body: input.body,
    tool: input.tool,
    userTurn: input.userTurn,
  };
}

function userTurnFromMetadata(metadata: Record<string, unknown> | null): ActivityEvent['userTurn'] {
  const model = getString(metadata, ['model', 'Model']);
  const thinkingLevel = getString(metadata, ['thinking_level', 'thinkingLevel', 'ThinkingLevel']);
  if (!model && !thinkingLevel) {
    return undefined;
  }
  return {
    model: model || undefined,
    thinkingLevel: thinkingLevel || undefined,
  };
}

function appendThoughtChunk(
  activityRows: ActivityEvent[],
  input: {
    id: string;
    conversationId: string;
    sequenceNo: number;
    timelineSeq?: number;
    eventSeq?: number;
    messageId?: string;
    messageVersion?: number;
    archived?: boolean;
    timestamp: number;
    text: string;
  },
): void {
  const normalized = input.text.replace(/^thinking:\s*/, '');
  if (!normalized) {
    return;
  }

  // Look backwards for the most recent thought event in this sequence.
  // We skip over 'status', 'lifecycle', 'thread', 'error' and 'tool' (start) events
  // to group thoughts from the same turn together.
  let target: ActivityEvent | null = null;
  for (let i = activityRows.length - 1; i >= 0; i--) {
    const row = activityRows[i];
    if (row.kind === 'thought') {
      target = row;
      break;
    }
    // A tool start/result marks a new thought segment boundary.
    if (row.kind === 'tool') {
      break;
    }
    // Stop looking if we see a structural break like a user message, assistant message, or tool result.
    if (row.kind === 'user' || row.kind === 'assistant') {
      break;
    }
    // Break if we see turn boundary events
    if (row.kind === 'lifecycle' && (row.title === 'Turn completed' || row.title === 'Turn aborted')) {
      break;
    }
    if (row.kind === 'status' && row.title?.startsWith('turn started')) {
      break;
    }
  }

  if (target) {
    target.body = `${target.body ?? ''}${normalized}`;
    target.timestamp = Math.max(target.timestamp, input.timestamp);
    return;
  }

  activityRows.push({
    id: input.id,
    conversationId: input.conversationId,
    sequenceNo: input.sequenceNo,
    timelineSeq: input.timelineSeq,
    eventSeq: input.eventSeq,
    messageId: input.messageId,
    messageVersion: input.messageVersion,
    archived: input.archived,
    kind: 'thought',
    title: 'Model thought',
    body: normalized,
    timestamp: input.timestamp,
  });
}

function collectPersistedToolResultCallIDs(items: unknown[]): Set<string> {
  const ids = new Set<string>();

  for (const item of items) {
    const record = asRecord(item);
    if (getString(record, ['type', 'Type']) !== 'ui_event') {
      continue;
    }

    const uiEvt = asRecord(getField(record, ['ui_event', 'UIEvent']));
    if (getString(uiEvt, ['kind', 'Kind']) !== 'tool_result') {
      continue;
    }

    const metadata = asRecord(getField(uiEvt, ['metadata', 'Metadata']));
    const callId = getString(metadata, ['call_id', 'callId']);
    if (callId) {
      ids.add(callId);
    }
  }

  return ids;
}

function toolMessageToActivities(
  msg: Record<string, unknown> | null,
  uiEventCallIDs: Set<string>,
  baseSequenceNo: number,
  timelineSeq?: number,
): ActivityEvent[] {
  const timestamp = messageTimestamp(msg);
  const rawParts = getField(msg, ['Parts', 'parts']);
  if (!Array.isArray(rawParts)) {
    return [];
  }

  const messageID = getString(msg, ['ID', 'id']) || crypto.randomUUID();
  const conversationId = getString(msg, ['ConversationID', 'conversation_id', 'conversationId']);
  const messageSeq = getNumber(msg, ['Seq', 'seq']) ?? undefined;
  const messageVersion = getNumber(msg, ['Version', 'version']) ?? undefined;
  const messageArchived = getBoolean(msg, ['Archived', 'archived']);
  const events: ActivityEvent[] = [];

  rawParts.forEach((part, index) => {
    const partRecord = asRecord(part);
    const kind = getString(partRecord, ['Kind', 'kind']);
    if (kind !== 'function_response') {
      return;
    }

    const response = asRecord(getField(partRecord, ['FunctionResponse', 'function_response']));
    const toolName = getString(response, ['Name', 'name']) || 'tool';
    const callID = getString(response, ['CallID', 'call_id']);

    if (callID && uiEventCallIDs.has(callID)) {
      return;
    }

    const rawResult = getField(response, ['ResponseJSON', 'response_json']);
    const resultText = rawValueToString(rawResult);
    const summary = summarizeToolBody(toolName, resultText, '');
    const parsedPayload = parseToolResultPayload(resultText);
    const failed = summary.title === 'error';

    events.push({
      id: `${messageID}:tool:${index}`,
      conversationId,
      sequenceNo: baseSequenceNo + index / 1000,
      timelineSeq,
      messageId: messageID,
      messageSeq,
      messageVersion,
      archived: messageArchived,
      kind: 'tool',
      title: failed ? `${toolName} failed` : `${toolName} completed${summary.title ? ` (${summary.title})` : ''}`,
      body: summary.body || undefined,
      timestamp: timestamp + index,
      tool: {
        name: toolName,
        phase: 'result',
        callId: callID || undefined,
        success: !failed,
        resultSummary: summary.title || undefined,
        error: failed ? summary.body : undefined,
        command: undefined,
        payload: parsedPayload,
      },
    });
  });

  return events;
}

export function parseToolCommand(toolName: string, argsText: string): string {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return '';
  }

  const parsed = parseToolResultPayload(trimmed);
  if (parsed) {
    if (toolName === 'shell') {
      return getString(parsed, ['command']);
    }
    if (isExecCommand(toolName)) {
      return getString(parsed, ['cmd']);
    }
    if (isApplyPatch(toolName)) {
      return getString(parsed, ['input', 'patch']);
    }
    if (isParallelToolUse(toolName)) {
      const toolUses = getArray(parsed, ['tool_uses']);
      if (toolUses.length > 0) {
        return `${toolUses.length} parallel tool call(s)`;
      }
    }
    if (isReadFile(toolName)) {
      const filePath = getString(parsed, ['file_path']);
      const offset = typeof parsed.offset === 'number' ? parsed.offset : 1;
      const limit = typeof parsed.limit === 'number' ? parsed.limit : 0;
      if (limit > 0) {
        return `Reading ${filePath} (lines ${offset}-${offset + limit - 1})`;
      }
      return `Reading ${filePath} (starting at line ${offset})`;
    }
  }

  // Fallback for already-summarized command text.
  if (toolName === 'shell' || isExecCommand(toolName) || isApplyPatch(toolName) || isReadFile(toolName)) {
    return trimmed;
  }

  return '';
}

function summarizePlanRows(parsed: Record<string, unknown> | null): string {
  const plan = getArray(parsed, ['plan']);
  if (plan.length === 0) {
    return '';
  }

  const lines: string[] = [];
  for (const item of plan) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const step = getString(record, ['step']);
    const status = getString(record, ['status']);
    if (!step) {
      continue;
    }
    lines.push(`${statusToGlyph(status)} ${step}`);
  }
  return lines.join('\n');
}

function summarizeParallelRows(parsed: Record<string, unknown> | null): string {
  const results = getArray(parsed, ['results']);
  const successCount = getNumber(parsed, ['success_count']);
  const failureCount = getNumber(parsed, ['failure_count']);

  const lines: string[] = [];
  if (successCount !== null || failureCount !== null) {
    lines.push(
      `success ${successCount ?? 0} · failed ${failureCount ?? 0}`,
    );
  }

  for (const item of results.slice(0, 6)) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const name = getString(record, ['name']) || 'tool';
    const success = getBoolean(record, ['success']);
    const err = getString(record, ['error']);
    lines.push(`${success ? 'ok' : 'error'} ${name}${err ? `: ${err}` : ''}`);
  }

  if (results.length > 6) {
    lines.push(`...and ${results.length - 6} more`);
  }

  return lines.join('\n');
}

function statusToGlyph(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'completed') {
    return '[x]';
  }
  if (normalized === 'in_progress') {
    return '[~]';
  }
  return '[ ]';
}

function getArray(record: Record<string, unknown> | null, keys: string[]): unknown[] {
  const value = getField(record, keys);
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function getNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  const value = getField(record, keys);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function rawValueToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
