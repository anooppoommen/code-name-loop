import type { ActivityEvent } from '../../types/ui';
import { parseToolResultPayload } from '../../utils/parsers';
import type {
  CommandToolPayload,
  CommandToolStatus,
  ParallelToolPayload,
  ParallelToolResult,
  RequestUserInputOption,
  RequestUserInputPayload,
  RequestUserInputQuestion,
  UpdatePlanItem,
  UpdatePlanPayload,
  FileToolPayload,
} from './types';

export function parseRequestUserInputPayload(event: ActivityEvent): RequestUserInputPayload | null {
  if (!event.tool || event.tool.phase !== 'result' || !toolNameMatches(event.tool.name, 'request_user_input')) {
    return null;
  }

  const payload = toolPayloadRecord(event);
  if (!payload) {
    return null;
  }

  const questions = readQuestions(payload.questions);
  if (questions.length === 0) {
    return null;
  }

  return {
    supported: Boolean(payload.supported),
    reason: readString(payload.reason),
    nextStep: readString(payload.next_step),
    questions,
  };
}

export function parseUpdatePlanPayload(event: ActivityEvent): UpdatePlanPayload | null {
  if (!event.tool || event.tool.phase !== 'result' || !toolNameMatches(event.tool.name, 'update_plan')) {
    return null;
  }

  const payload = toolPayloadRecord(event);
  if (!payload) {
    return null;
  }

  const planRaw = Array.isArray(payload.plan) ? payload.plan : [];
  const plan: UpdatePlanItem[] = planRaw
    .map((item) => {
      const record = asObject(item);
      if (!record) {
        return null;
      }
      const step = readString(record.step);
      const status = readString(record.status);
      if (!step) {
        return null;
      }
      return { step, status };
    })
    .filter((item): item is UpdatePlanItem => item !== null);

  if (plan.length === 0) {
    return null;
  }
  return { plan };
}

export function parseParallelToolPayload(event: ActivityEvent): ParallelToolPayload | null {
  if (!event.tool || event.tool.phase !== 'result' || !toolNameMatches(event.tool.name, 'parallel_tool_use')) {
    return null;
  }

  const payload = toolPayloadRecord(event);
  if (!payload) {
    return null;
  }

  const resultsRaw = Array.isArray(payload.results) ? payload.results : [];
  const results: ParallelToolResult[] = resultsRaw
    .map((item) => {
      const record = asObject(item);
      if (!record) {
        return null;
      }
      const name = readString(record.name) || 'tool';
      const success = Boolean(record.success);
      const error = readString(record.error);
      const response = asObject(record.response);
      const args = asObject(record.arguments);
      const itemResult: ParallelToolResult = { name, success, error, response, arguments: args };
      return itemResult;
    })
    .filter((item): item is ParallelToolResult => item !== null);

  if (results.length === 0) {
    return null;
  }

  return {
    successCount: readNumber(payload.success_count),
    failureCount: readNumber(payload.failure_count),
    results,
  };
}

export function parseCommandToolPayload(event: ActivityEvent): CommandToolPayload | null {
  if (!event.tool || !isCommandToolName(event.tool.name)) {
    return null;
  }

  const payload = toolPayloadRecord(event);
  const payloadOutput = readString(payload?.output);
  const payloadError = readString(payload?.error);
  const parsedOutput = splitExecLikeOutput(payloadOutput || event.body || '');

  const command = (event.tool.command || '').trim() || inferCommandFromBody(event.body || '');
  const status = resolveCommandStatus(
    event,
    payloadError,
    parsedOutput.runningSession,
    Boolean(event.tool?.waitingApproval),
  );
  const error = payloadError || event.tool.error || '';

  return {
    shellLabel: 'bash',
    command,
    output: parsedOutput.output,
    status,
    error,
    wallTime: parsedOutput.wallTime,
    exitCode: parsedOutput.exitCode,
    executedAt: String(event.timestamp),
  };
}

export function parseFileToolPayload(event: ActivityEvent): FileToolPayload | null {
  if (!event.tool || !isFileToolName(event.tool.name)) {
    return null;
  }

  const payload = toolPayloadRecord(event);
  let payloadOutput = '';
  if (payload && typeof payload.output === 'string') {
    payloadOutput = payload.output;
  } else if (event.body) {
    payloadOutput = event.body;
  }

  const payloadError = readString(payload?.error);
  const error = payloadError || event.tool.error || '';

  return {
    toolName: event.tool.name,
    args: event.tool.args || {},
    output: payloadOutput.trimEnd(),
    status: resolveCommandStatus(event, payloadError, false, false),
    error,
    executedAt: String(event.timestamp),
  };
}

export function buildRequestUserInputReply(
  questions: RequestUserInputQuestion[],
  selectedByQuestion: Record<string, number>,
): string {
  const lines = ['request_user_input response'];

  for (const question of questions) {
    const selectedIndex = selectedByQuestion[question.id];
    if (selectedIndex === undefined) {
      continue;
    }
    const selectedOption = question.options[selectedIndex];
    if (!selectedOption) {
      continue;
    }

    lines.push(`- ${question.id}: ${selectedOption.label}`);
    if (selectedOption.description) {
      lines.push(`  rationale: ${selectedOption.description}`);
    }
  }

  return lines.join('\n');
}

export function statusGlyph(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'completed') {
    return '[x]';
  }
  if (normalized === 'in_progress') {
    return '[~]';
  }
  return '[ ]';
}

export function statusTone(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'completed') {
    return 'text-emerald-300';
  }
  if (normalized === 'in_progress') {
    return 'text-amber-300';
  }
  return 'text-loop-400';
}

function readQuestions(value: unknown): RequestUserInputQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = asObject(item);
      if (!record) {
        return null;
      }
      const id = readString(record.id);
      const header = readString(record.header);
      const question = readString(record.question);
      const optionsRaw = Array.isArray(record.options) ? record.options : [];
      const options = optionsRaw
        .map((opt) => {
          const optRecord = asObject(opt);
          if (!optRecord) {
            return null;
          }
          const label = readString(optRecord.label);
          const description = readString(optRecord.description);
          if (!label) {
            return null;
          }
          return { label, description };
        })
        .filter((opt): opt is RequestUserInputOption => opt !== null);

      if (!id || !header || !question || options.length < 2) {
        return null;
      }

      return { id, header, question, options };
    })
    .filter((item): item is RequestUserInputQuestion => item !== null);
}

function toolPayloadRecord(event: ActivityEvent): Record<string, unknown> | null {
  const payload = event.tool?.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload;
  }

  if (!event.body) {
    return null;
  }

  return parseToolResultPayload(event.body);
}

function toolNameMatches(toolName: string, canonical: string): boolean {
  return (
    toolName === canonical ||
    toolName.endsWith(`:${canonical}`) ||
    toolName.endsWith(`.${canonical}`)
  );
}

function isCommandToolName(toolName: string): boolean {
  return toolNameMatches(toolName, 'shell') || toolNameMatches(toolName, 'exec_command');
}

function isFileToolName(toolName: string): boolean {
  return (
    toolNameMatches(toolName, 'read_file') ||
    toolNameMatches(toolName, 'list_dir') ||
    toolNameMatches(toolName, 'grep_files')
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resolveCommandStatus(
  event: ActivityEvent,
  payloadError: string,
  runningSession: boolean,
  waitingApproval: boolean,
): CommandToolStatus {
  if (waitingApproval) {
    return 'waiting';
  }
  if (event.tool?.phase === 'start') {
    return 'running';
  }
  if (event.tool?.success === false || payloadError || event.tool?.error) {
    return 'error';
  }
  if (runningSession) {
    return 'running';
  }
  return 'success';
}

function inferCommandFromBody(body: string): string {
  const text = body.trim();
  if (!text) {
    return '';
  }
  const firstLine = text.split('\n')[0];
  // If first line looks like metadata summary, do not use it as command.
  if (firstLine.startsWith('Wall time:') || firstLine.startsWith('Process exited with code')) {
    return '';
  }
  return firstLine;
}

function splitExecLikeOutput(raw: string): {
  output: string;
  wallTime: string;
  exitCode: string;
  runningSession: boolean;
} {
  const normalized = raw.replace(/\r/g, '');
  if (!normalized.trim()) {
    return { output: '', wallTime: '', exitCode: '', runningSession: false };
  }

  const wallTime = normalized.match(/^Wall time:\s*([^\n]+)$/m)?.[1]?.trim() ?? '';
  const exitCode = normalized.match(/^Process exited with code\s+([^\n]+)$/m)?.[1]?.trim() ?? '';
  const runningSession = /^Process running with session ID\s+/m.test(normalized);

  const outputMarker = '\nOutput:\n';
  const markerIndex = normalized.indexOf(outputMarker);
  if (markerIndex >= 0) {
    return {
      output: normalized.slice(markerIndex + outputMarker.length).trimEnd(),
      wallTime,
      exitCode,
      runningSession,
    };
  }

  return {
    output: normalized.trimEnd(),
    wallTime,
    exitCode,
    runningSession,
  };
}
