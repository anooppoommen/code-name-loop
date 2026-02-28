import type { ConversationSummary, WorkspaceSummary } from '../types/ui';

export function parseWorkspace(input: unknown): WorkspaceSummary | null {
  const record = asRecord(input);
  const id = getString(record, ['ID', 'id']);
  const rootPath =
    getString(record, ['RootPath', 'rootPath']) ||
    getString(record, ['CanonicalRootPath', 'canonicalRootPath']);

  if (!id) {
    return null;
  }

  return {
    id,
    rootPath,
    name: getString(record, ['Name', 'name']) || id,
  };
}

export function extractMessageImages(message: unknown): { mimeType: string; dataUrl: string }[] {
  const record = asRecord(message);
  const rawParts = getField(record, ['Parts', 'parts']);
  if (!Array.isArray(rawParts)) {
    return [];
  }

  const images: { mimeType: string; dataUrl: string }[] = [];
  for (const part of rawParts) {
    const partRecord = asRecord(part);
    const kind = getString(partRecord, ['Kind', 'kind']);
    if (kind === 'inline_blob') {
      const blob = asRecord(getField(partRecord, ['inline_blob', 'InlineBlob']));
      if (blob) {
        const mimeType = getString(blob, ['mime_type', 'MIMEType']);
        const data = getString(blob, ['data', 'Data']);
        if (mimeType && data) {
          images.push({ mimeType, dataUrl: `data:${mimeType};base64,${data}` });
        }
      }
    }
  }
  return images;
}

export function parseConversation(input: unknown): ConversationSummary | null {
  const record = asRecord(input);
  const id = getString(record, ['ID', 'id']);

  if (!id) {
    return null;
  }

  const parentConversationID = getString(record, [
    'ParentConversationID',
    'parentConversationId',
    'parent_conversation_id',
  ]).trim();

  return {
    id,
    title: getString(record, ['Title', 'title']) || id,
    isThread: parentConversationID !== '',
    updatedAt: getString(record, ['UpdatedAt', 'updatedAt', 'updated_at']),
  };
}

export function extractMessageText(message: unknown): string {
  const record = asRecord(message);
  const rawParts = getField(record, ['Parts', 'parts']);
  if (!Array.isArray(rawParts)) {
    return '';
  }

  const textChunks: string[] = [];

  for (const part of rawParts) {
    const partRecord = asRecord(part);
    const kind = getString(partRecord, ['Kind', 'kind']);

    if (kind === 'thought') {
      continue;
    }

    if (kind === 'text') {
      const textValue = getString(asRecord(getField(partRecord, ['text', 'Text'])), ['text', 'Text']);
      if (textValue) {
        textChunks.push(textValue);
      }
      continue;
    }

    const fallbackText = getString(partRecord, ['text', 'Text']);
    if (fallbackText) {
      textChunks.push(fallbackText);
    }
  }

  return textChunks.join('');
}

export function buildConversationTitle(seedText: string): string {
  const trimmed = seedText.trim();
  if (trimmed.length <= 56) {
    return trimmed;
  }
  return `${trimmed.slice(0, 56)}...`;
}

export function lastPathSegment(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'workspace';
}

export function trimForUI(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

export function shortID(id: string): string {
  if (id.length <= 8) {
    return id;
  }
  return id.slice(0, 8);
}

export function stringifyResponseError(data: unknown, fallback: string | null): string {
  if (typeof data === 'string' && data.trim()) {
    return data;
  }

  const record = asRecord(data);
  const message = getString(record, ['error', 'message']);
  if (message) {
    return message;
  }

  if (fallback) {
    return fallback;
  }

  return 'Unknown error';
}

export function parseToolResultPayload(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }

  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function getField(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return null;
}

export function getString(record: Record<string, unknown> | null, keys: string[]): string {
  const value = getField(record, keys);
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

export function getBoolean(record: Record<string, unknown> | null, keys: string[]): boolean {
  const value = getField(record, keys);
  if (typeof value === 'boolean') {
    return value;
  }
  return false;
}

export function formatRelativeTime(dateString: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffInMs = now.getTime() - date.getTime();

  if (isNaN(diffInMs)) return '';

  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInMinutes < 1) return 'just now';
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  if (diffInHours < 24) return `${diffInHours}h ago`;
  if (diffInDays === 1) return `yesterday`;
  if (diffInDays < 7) return `${diffInDays}d ago`;

  // Format as short date if older than a week
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
