import type { ActivityEvent, ComposerModel, ThinkingLevel } from '../types/ui';
import { asRecord, getField, getString } from '../utils/parsers';
import { COMPOSER_MODELS, DEFAULT_COMPOSER_MODEL, DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from './useLoopDesktop.constants';
import type { PendingCommandApproval } from './useLoopDesktop.types';

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value !== 'string') {
    return DEFAULT_THINKING_LEVEL;
  }
  const normalized = value.trim().toLowerCase();
  if (THINKING_LEVELS.includes(normalized as ThinkingLevel)) {
    return normalized as ThinkingLevel;
  }
  return DEFAULT_THINKING_LEVEL;
}

export function normalizeComposerModel(value: unknown): ComposerModel {
  if (typeof value !== 'string') {
    return DEFAULT_COMPOSER_MODEL;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gemini-3-flash') {
    return 'gemini-3-flash-preview';
  }
  if (normalized === 'gemini-3-pro') {
    return 'gemini-3-pro-preview';
  }
  if (COMPOSER_MODELS.includes(normalized as ComposerModel)) {
    return normalized as ComposerModel;
  }
  return DEFAULT_COMPOSER_MODEL;
}

export function rowsFromUnknown(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const direct = getField(record, ['rows', 'items', 'data', 'messages', 'conversations', 'workspaces']);
  if (Array.isArray(direct)) {
    return direct;
  }

  return [];
}

export function parseCommandApprovalEvent(
  eventRecord: Record<string, unknown> | null,
  fallbackConversationId: string,
): PendingCommandApproval | null {
  if (!eventRecord) {
    return null;
  }
  const approvalRecord = asRecord(getField(eventRecord, ['approval_request', 'approvalRequest']));
  return parsePendingCommandApprovalRecord(approvalRecord, fallbackConversationId);
}

export function parsePendingCommandApprovalRecord(
  approvalRecord: Record<string, unknown> | null,
  fallbackConversationId = '',
): PendingCommandApproval | null {
  if (!approvalRecord) {
    return null;
  }

  const id = getString(approvalRecord, ['id']);
  const command = getString(approvalRecord, ['command']);
  if (!id || !command) {
    return null;
  }

  return {
    id,
    conversationId: getString(approvalRecord, ['conversation_id', 'conversationId']) || fallbackConversationId,
    toolName: getString(approvalRecord, ['tool_name', 'toolName']) || 'exec_command',
    command,
    workdir: getString(approvalRecord, ['workdir']),
  };
}

export function getNumber(record: Record<string, unknown> | null, keys: string[]): number {
  const value = getField(record, keys);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return Number.NaN;
}

function toolNameMatches(toolName: string, canonical: string): boolean {
  return (
    toolName === canonical ||
    toolName.endsWith(`:${canonical}`) ||
    toolName.endsWith(`.${canonical}`)
  );
}

function normalizeApprovalToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (toolNameMatches(normalized, 'exec_command')) {
    return 'exec_command';
  }
  if (toolNameMatches(normalized, 'shell')) {
    return 'shell';
  }
  return normalized;
}

function buildApprovalKey(toolName: string, command: string): string {
  const normalizedCommand = command.trim();
  const normalizedToolName = normalizeApprovalToolName(toolName);
  if (!normalizedCommand || !normalizedToolName) {
    return '';
  }
  return `${normalizedToolName}::${normalizedCommand}`;
}

export function annotateActivitiesWithPendingApprovals(
  events: ActivityEvent[],
  pendingApprovals: PendingCommandApproval[],
): ActivityEvent[] {
  if (events.length === 0) {
    return events;
  }

  const pendingByKey = new Map<string, number>();
  for (const approval of pendingApprovals) {
    const key = buildApprovalKey(approval.toolName, approval.command);
    if (!key) {
      continue;
    }
    pendingByKey.set(key, (pendingByKey.get(key) ?? 0) + 1);
  }

  let changed = false;
  const waitingByEventID = new Map<string, boolean>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const tool = event.tool;
    if (!tool || tool.phase !== 'start' || !tool.command) {
      waitingByEventID.set(event.id, false);
      continue;
    }
    const key = buildApprovalKey(tool.name, tool.command);
    const remaining = key ? (pendingByKey.get(key) ?? 0) : 0;
    const isWaiting = remaining > 0;
    waitingByEventID.set(event.id, isWaiting);
    if (isWaiting && key) {
      pendingByKey.set(key, remaining - 1);
    }
  }

  const next = events.map((event) => {
    const tool = event.tool;
    if (!tool) {
      return event;
    }
    const waitingApproval = waitingByEventID.get(event.id) ?? false;
    if (Boolean(tool.waitingApproval) === waitingApproval) {
      return event;
    }
    changed = true;
    return {
      ...event,
      tool: {
        ...tool,
        waitingApproval,
      },
    };
  });

  return changed ? next : events;
}
