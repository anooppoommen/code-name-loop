import {
  AlertTriangle,
  Brain,
  Cog,
  GitBranch,
  Info,
  UserRound,
  Workflow,
} from 'lucide-react';
import type { ActivityEvent, ActivityKind } from '../../types/ui';

export type ActivityVisualStyle = {
  row: string;
  icon: string;
  copy: string;
  detail: string;
};

export function toolPhaseLabel(event: ActivityEvent): string {
  if (!event.tool) {
    return '';
  }

  if (event.tool.phase === 'start') {
    return 'started';
  }

  if (event.tool.success === false) {
    return 'failed';
  }

  return 'completed';
}

export function visualStyleFor(event: ActivityEvent): ActivityVisualStyle {
  if (event.kind === 'error' || event.tool?.success === false) {
    return {
      row: '',
      icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-loop-800/90 text-red-300',
      copy: 'text-loop-100',
      detail: 'bg-loop-900/65 text-loop-200',
    };
  }

  if (event.kind === 'tool') {
    return {
      row: '',
      icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-900/25 text-blue-200',
      copy: 'text-loop-200',
      detail: 'bg-loop-900/40 text-blue-100',
    };
  }

  if (event.kind === 'thought') {
    return {
      row: '',
      icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-loop-700/70 text-loop-200',
      copy: 'text-loop-200',
      detail: 'bg-loop-900/50 text-loop-300',
    };
  }

  if (event.kind === 'assistant') {
    return {
      row: '',
      icon: 'flex h-8 w-8 shrink-0 items-center justify-center',
      copy: 'text-loop-200',
      detail: 'bg-loop-900/50 text-loop-300',
    };
  }

  return {
    row: '',
    icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-loop-800/80 text-loop-400',
    copy: 'text-loop-300',
    detail: 'bg-loop-900/50 text-loop-400',
  };
}

interface SystemErrorDetailRow {
  label: string;
  value: string;
}

export type SystemErrorDetails =
  | {
      mode: 'text';
      text: string;
    }
  | {
      mode: 'card';
      summary: string;
      rows: SystemErrorDetailRow[];
    };

export function parseSystemErrorDetails(event: ActivityEvent): SystemErrorDetails | null {
  const isErrorLike =
    event.kind === 'error' || event.tool?.success === false || /error|failed/i.test(event.title);
  const body = event.body?.trim();
  if (!isErrorLike || !body) {
    return null;
  }

  const normalized = body.replace(/\r\n/g, '\n');
  const rows: SystemErrorDetailRow[] = [];
  const seenRows = new Set<string>();
  const pushRow = (label: string, value: string): void => {
    const cleaned = value.trim();
    if (!cleaned) {
      return;
    }
    const key = `${label}:${cleaned.toLowerCase()}`;
    if (seenRows.has(key)) {
      return;
    }
    seenRows.add(key);
    rows.push({ label, value: cleaned });
  };

  const codeMatch = normalized.match(/\bError\s+(\d{3})\b/i);
  if (codeMatch) {
    pushRow('Code', codeMatch[1]);
  }

  const statusMatch = normalized.match(/\bStatus:\s*([A-Z_]+)/i);
  if (statusMatch) {
    pushRow('Status', humanizeStatus(statusMatch[1]));
  }

  const phaseMatch = normalized.match(/\bPhase:\s*([A-Za-z0-9_-]+)/i);
  if (phaseMatch) {
    pushRow('Phase', phaseMatch[1]);
  }

  const detailMatch = normalized.match(/\bDetails:\s*([^\n]+)/i);
  if (detailMatch && detailMatch[1].trim() !== '[]') {
    pushRow('Details', detailMatch[1]);
  }

  for (const metricMatch of normalized.matchAll(/\b(TTFT|Stream|Total)\s+(\d+)ms\b/gi)) {
    const rawLabel = metricMatch[1];
    const label =
      rawLabel.toUpperCase() === 'TTFT'
        ? 'First token'
        : `${rawLabel.charAt(0).toUpperCase()}${rawLabel.slice(1).toLowerCase()}`;
    pushRow(label, `${metricMatch[2]}ms`);
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const messageMatch = normalized.match(/\bMessage:\s*(.+?)(?=,\s*(Status:|Details:|$)|$)/i);
  const fallbackLine = lines.find(
    (line) =>
      !/^(TTFT|Stream|Total)\s+\d+ms/i.test(line) &&
      !/^[A-Za-z ]+:\s*/.test(line) &&
      !/^Error\s+\d{3}\b/i.test(line),
  );
  const rawSummary = messageMatch?.[1] || fallbackLine || lines[0] || '';
  const summary = cleanErrorSummary(rawSummary);
  if (!summary) {
    return null;
  }

  if (rows.length === 0) {
    return { mode: 'text', text: summary };
  }

  return {
    mode: 'card',
    summary,
    rows,
  };
}

export function labelFor(kind: ActivityKind): string {
  switch (kind) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'thought':
      return 'Thought';
    case 'status':
      return 'Status';
    case 'tool':
      return 'Tool';
    case 'thread':
      return 'Thread';
    case 'error':
      return 'Error';
    default:
      return 'Lifecycle';
  }
}

export function iconFor(kind: ActivityKind) {
  switch (kind) {
    case 'user':
      return <UserRound size={18} />;
    case 'assistant':
      return <img src="/gemini-color.svg" width={22} height={22} alt="Gemini" />;
    case 'thought':
      return <Brain size={14} />;
    case 'status':
      return <Info size={14} />;
    case 'tool':
      return <Cog size={14} />;
    case 'thread':
      return <GitBranch size={14} />;
    case 'error':
      return <AlertTriangle size={14} />;
    default:
      return <Workflow size={14} />;
  }
}

export function userThinkingToneClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'minimal':
      return 'text-loop-400';
    case 'low':
      return 'text-sky-300';
    case 'medium':
      return 'text-blue-300';
    case 'high':
      return 'text-violet-300';
    default:
      return 'text-loop-300';
  }
}

export function formatActivityTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function cleanErrorSummary(rawSummary: string): string {
  return rawSummary
    .replace(/^rpc error:\s*code\s*=\s*[a-z_]+\s*desc\s*=\s*/i, '')
    .replace(/^Error\s+\d+\s*,?\s*Message:\s*/i, '')
    .replace(/^Message:\s*/i, '')
    .replace(/,\s*Status:\s*[A-Z_]+.*$/i, '')
    .replace(/,\s*Details:\s*\[[^\]]*\].*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\.,/g, '.')
    .replace(/,\s*$/, '')
    .trim();
}

function humanizeStatus(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}
