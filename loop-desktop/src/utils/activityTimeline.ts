import type { ActivityEvent, ActivityKind } from '../types/ui';
import {
  asRecord,
  extractMessageText,
  getBoolean,
  getField,
  getString,
  parseToolResultPayload,
  trimForUI,
} from './parsers';

export interface ActivityInput {
  kind: ActivityKind;
  title: string;
  body?: string;
  streaming?: boolean;
  tool?: ActivityEvent['tool'];
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

    const output = getString(parsed, ['output']);
    if (output) {
      if (toolName === 'exec_command') {
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

  for (const item of items) {
    const record = asRecord(item);
    const type = getString(record, ['type', 'Type']);

    if (type === 'message') {
      const msg = asRecord(getField(record, ['message', 'Message']));
      const sentBy = getString(msg, ['SentBy', 'sent_by', 'sentBy']);
      if (sentBy === 'user') {
        const text = extractMessageText(msg);
        if (text) {
          activityRows.push({
            id: getString(msg, ['ID', 'id']) || crypto.randomUUID(),
            kind: 'user',
            title: 'User prompt',
            body: text,
            timestamp: messageTimestamp(msg),
          });
        }
      } else if (sentBy === 'agent') {
        const text = extractMessageText(msg);
        if (text) {
          activityRows.push({
            id: getString(msg, ['ID', 'id']) || crypto.randomUUID(),
            kind: 'assistant',
            title: 'Assistant response',
            body: text,
            timestamp: messageTimestamp(msg),
          });
        }
      } else if (sentBy === 'tool') {
        activityRows.push(...toolMessageToActivities(msg, toolResultCallIDs));
      }
    } else if (type === 'ui_event') {
      const uiEvt = asRecord(getField(record, ['ui_event', 'UIEvent']));
      const id = getString(uiEvt, ['id', 'ID']) || crypto.randomUUID();
      const kind = getString(uiEvt, ['kind', 'Kind']);
      const text = getString(uiEvt, ['text', 'Text']);
      const timestamp = messageTimestamp(uiEvt);
      const metadata = asRecord(getField(uiEvt, ['metadata', 'Metadata'])) || {};

      switch (kind) {
        case 'thought': {
          appendThoughtChunk(activityRows, { id, timestamp, text });
          break;
        }
        case 'tool_start': {
          const callId = getString(metadata, ['call_id', 'callId']);
          const toolName = getString(metadata, ['tool_name']);
          const args = getString(metadata, ['args']);
          const command = parseToolCommand(toolName, args);
          activityRows.push({
            id,
            kind: 'tool',
            title: `${toolName || 'tool'} started`,
            body: trimForUI(command || args || text, 900) || undefined,
            timestamp,
            tool: {
              name: toolName || 'tool',
              phase: 'start',
              callId: callId || undefined,
              command: command || undefined,
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
          const summary = summarizeToolBody(toolName, resultText, errorMsg);
          const fallbackBody = success ? text : errorMsg || text;
          const mergedCommand = parseToolCommand(toolName, getString(metadata, ['args']));

          const existingIndex = callId ? openToolByCallID.get(callId) : undefined;
          if (existingIndex !== undefined) {
            const existing = activityRows[existingIndex];
            if (existing && existing.kind === 'tool') {
              activityRows[existingIndex] = {
                ...existing,
                title: success ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}` : `${toolName} failed`,
                body: summary.body || trimForUI(fallbackBody, 900) || undefined,
                tool: {
                  ...(existing.tool ?? { name: toolName, phase: 'start' as const }),
                  name: toolName,
                  phase: 'result',
                  callId: callId || undefined,
                  success,
                  resultSummary: summary.title || undefined,
                  error: errorMsg || undefined,
                  command: existing.tool?.command || mergedCommand || undefined,
                },
              };
              openToolByCallID.delete(callId);
              break;
            }
          }

          activityRows.push({
            id,
            kind: 'tool',
            title: success ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}` : `${toolName} failed`,
            body: summary.body || trimForUI(fallbackBody, 900) || undefined,
            timestamp,
            tool: {
              name: toolName,
              phase: 'result',
              callId: callId || undefined,
              success,
              resultSummary: summary.title || undefined,
              error: errorMsg || undefined,
              command: mergedCommand || undefined,
            },
          });
          break;
        }
        case 'thread_status': {
          const parsed = parseStatusLine(text);
          if (parsed) {
            activityRows.push(statusInputToEvent(id, timestamp, parsed));
          }
          break;
        }
        case 'status': {
          const parsed = parseStatusLine(text);
          if (parsed) {
            activityRows.push(statusInputToEvent(id, timestamp, parsed));
          }
          break;
        }
        case 'error': {
          activityRows.push({ id, kind: 'error', title: 'Agent error', body: text, timestamp });
          break;
        }
        case 'abort': {
          activityRows.push({ id, kind: 'lifecycle', title: 'Turn aborted', body: text || undefined, timestamp });
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

function statusInputToEvent(id: string, timestamp: number, input: ActivityInput): ActivityEvent {
  return {
    id,
    timestamp,
    kind: input.kind,
    title: input.title,
    body: input.body,
    tool: input.tool,
  };
}

function appendThoughtChunk(
  activityRows: ActivityEvent[],
  input: {
    id: string;
    timestamp: number;
    text: string;
  },
): void {
  const normalized = input.text.replace(/^thinking:\s*/, '');
  if (!normalized) {
    return;
  }

  const prev = activityRows[activityRows.length - 1];
  if (prev && prev.kind === 'thought') {
    prev.body = `${prev.body ?? ''}${normalized}`;
    prev.timestamp = input.timestamp;
    return;
  }

  activityRows.push({
    id: input.id,
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

function toolMessageToActivities(msg: Record<string, unknown> | null, uiEventCallIDs: Set<string>): ActivityEvent[] {
  const timestamp = messageTimestamp(msg);
  const rawParts = getField(msg, ['Parts', 'parts']);
  if (!Array.isArray(rawParts)) {
    return [];
  }

  const messageID = getString(msg, ['ID', 'id']) || crypto.randomUUID();
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
    const failed = summary.title === 'error';

    events.push({
      id: `${messageID}:tool:${index}`,
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
    if (toolName === 'exec_command') {
      return getString(parsed, ['cmd']);
    }
  }

  // Fallback for already-summarized command text.
  if (toolName === 'shell' || toolName === 'exec_command') {
    return trimmed;
  }

  return '';
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
