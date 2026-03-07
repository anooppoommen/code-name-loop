export function buildPatchRevertKey(conversationId: string, patchId: string | undefined, patches: string[]): string {
  const trimmedPatchId = patchId?.trim();
  if (trimmedPatchId) {
    return `patch-id:${trimmedPatchId}`;
  }
  return `patch:${conversationId}:${hashPatchTexts(patches)}`;
}

function hashPatchTexts(patches: string[]): string {
  const text = patches.join('\n@@patch@@\n');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function buildPatchIdFromToolCallIDs(conversationId: string, callIds: string[], patches: string[]): string {
  const cleaned = Array.from(new Set(callIds.map((value) => value.trim()).filter(Boolean))).sort();
  if (cleaned.length > 0) {
    return `tool-calls:${conversationId}:${cleaned.join(',')}`;
  }
  return `tool-fallback:${conversationId}:${hashPatchTexts(patches)}`;
}
