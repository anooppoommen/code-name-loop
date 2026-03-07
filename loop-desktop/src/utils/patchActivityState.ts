import type { ActivityEvent } from '../types/ui';
import { buildPatchIdFromToolCallIDs } from './patchRevertKey.ts';

export interface AssistantPatchContextEntry {
  patches: string[];
  checkpointId?: string;
  patchId?: string;
  revertedPaths?: string[];
}

export function buildAssistantPatchContext(timelineEvents: ActivityEvent[]): Map<string, AssistantPatchContextEntry> {
  const contextByAssistant = new Map<string, AssistantPatchContextEntry>();
  const revertByAppliedCheckpoint = new Map<string, { patchId?: string; baseCheckpointId: string; filePaths: string[] }>();
  const revertedPathsByPatchID = new Map<string, Set<string>>();
  const revertedPathsBySourceCheckpoint = new Map<string, Set<string>>();
  let currentPatches: string[] = [];
  let currentPatchCallIDs: string[] = [];
  let currentCheckpointId = '';
  let currentUserMessageId = '';

  const addPatchRevertedPaths = (patchId: string, filePaths: string[]) => {
    if (!patchId || filePaths.length === 0) {
      return;
    }
    const next = revertedPathsByPatchID.get(patchId) ?? new Set<string>();
    for (const path of filePaths) {
      next.add(path);
    }
    revertedPathsByPatchID.set(patchId, next);
  };

  const removePatchRevertedPaths = (patchId: string, filePaths: string[]) => {
    if (!patchId || filePaths.length === 0) {
      return;
    }
    const existing = revertedPathsByPatchID.get(patchId);
    if (!existing) {
      return;
    }
    for (const path of filePaths) {
      existing.delete(path);
    }
    if (existing.size === 0) {
      revertedPathsByPatchID.delete(patchId);
    }
  };

  const addRevertedPaths = (checkpointId: string, filePaths: string[]) => {
    if (!checkpointId || filePaths.length === 0) {
      return;
    }
    const next = revertedPathsBySourceCheckpoint.get(checkpointId) ?? new Set<string>();
    for (const path of filePaths) {
      next.add(path);
    }
    revertedPathsBySourceCheckpoint.set(checkpointId, next);
  };

  const removeRevertedPaths = (checkpointId: string, filePaths: string[]) => {
    if (!checkpointId || filePaths.length === 0) {
      return;
    }
    const existing = revertedPathsBySourceCheckpoint.get(checkpointId);
    if (!existing) {
      return;
    }
    for (const path of filePaths) {
      existing.delete(path);
    }
    if (existing.size === 0) {
      revertedPathsBySourceCheckpoint.delete(checkpointId);
    }
  };

  for (const event of timelineEvents) {
    if (event.kind === 'user') {
      currentPatches = [];
      currentPatchCallIDs = [];
      currentCheckpointId = event.checkpointId || '';
      currentUserMessageId = event.messageId || event.id;
      continue;
    }

    if (event.kind === 'lifecycle' && event.title === 'Selected changes reverted') {
      if (event.checkpointId && event.baseCheckpointId && event.filePaths && event.filePaths.length > 0) {
        revertByAppliedCheckpoint.set(event.checkpointId, {
          patchId: event.patchId,
          baseCheckpointId: event.baseCheckpointId,
          filePaths: [...event.filePaths],
        });
        if (event.patchId) {
          addPatchRevertedPaths(event.patchId, event.filePaths);
        }
        addRevertedPaths(event.baseCheckpointId, event.filePaths);
      }
      continue;
    }

    if (event.kind === 'lifecycle' && event.title === 'Undo restored checkpoint' && event.checkpointId) {
      const reverted = revertByAppliedCheckpoint.get(event.checkpointId);
      if (reverted) {
        if (reverted.patchId) {
          removePatchRevertedPaths(reverted.patchId, reverted.filePaths);
        }
        removeRevertedPaths(reverted.baseCheckpointId, reverted.filePaths);
      }
      continue;
    }

    if (event.kind === 'lifecycle' && event.title === 'Checkpoint created' && event.messageId === currentUserMessageId) {
      if (event.checkpointId) {
        currentCheckpointId = event.checkpointId;
      }
      continue;
    }

    if (event.kind === 'tool') {
      const toolName = event.tool?.name || '';
      if (
        (toolName === 'apply_patch' || toolName.endsWith(':apply_patch') || toolName.endsWith('.apply_patch')) &&
        event.tool?.success !== false
      ) {
        const patchText = event.tool?.command || event.body;
        if (patchText) {
          currentPatches.push(patchText);
          if (event.tool?.callId) {
            currentPatchCallIDs.push(event.tool.callId);
          }
        }
      }
      continue;
    }

    if (event.kind === 'assistant') {
      if (currentPatches.length > 0) {
        const patchId = buildPatchIdFromToolCallIDs(event.conversationId, currentPatchCallIDs, currentPatches);
        contextByAssistant.set(event.id, {
          patches: [...currentPatches],
          checkpointId: currentCheckpointId || undefined,
          patchId,
        });
      }
      currentPatches = [];
      currentPatchCallIDs = [];
    }
  }

  for (const [assistantId, context] of contextByAssistant.entries()) {
    const revertedPaths = context.patchId
      ? Array.from(revertedPathsByPatchID.get(context.patchId) ?? [])
      : Array.from(revertedPathsBySourceCheckpoint.get(context.checkpointId ?? '') ?? []);
    contextByAssistant.set(assistantId, {
      ...context,
      revertedPaths: revertedPaths.length > 0 ? revertedPaths : undefined,
    });
  }

  return contextByAssistant;
}
