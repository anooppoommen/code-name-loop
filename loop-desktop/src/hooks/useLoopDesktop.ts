import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { attachReplyStream, getActiveReplyStream, openReplyStream } from '../lib/loopClient';
import type { ConversationSummary } from '../types/ui';
import { shortID } from '../utils/parsers';
import { normalizeComposerModel, normalizeThinkingLevelForModel } from './useLoopDesktop.helpers';
import type {
  ComposerImage,
  LoopDesktopController,
} from './useLoopDesktop.types';

import { useActivities } from './useActivities';
import { useCommandApprovals } from './useCommandApprovals';
import { useComposer } from './useComposer';
import { useConversations } from './useConversations';
import { useLocalStorage } from './useLocalStorage';
import { useModelSettings } from './useModelSettings';
import { useNotices } from './useNotices';
import { useSshTunnel } from './useSshTunnel';
import { useWorkspaces } from './useWorkspaces';

export type {
  CommandApprovalDecision,
  ComposerImage,
  LoopDesktopController,
  NoticeToast,
  PendingCommandApproval,
  QueuedMessage,
  SshTunnelConfig,
  SshTunnelStatus,
} from './useLoopDesktop.types';

function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    return dataUrl.trim();
  }
  return dataUrl.slice(commaIndex + 1).trim();
}

export function useLoopDesktop(): LoopDesktopController {
  const [backendUrl, setBackendUrl] = useState('http://localhost:8080');

  // ── Selected Conversation (owned here, shared via params) ──
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const selectedConversationIdRef = useRef('');
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  // ── Notices ──────────────────────────────────────────────
  const notices = useNotices();

  // ── SSH Tunnel ──────────────────────────────────────────
  const sshTunnel = useSshTunnel(notices.pushNotice, setBackendUrl);

  // ── Command Approvals ──────────────────────────────────
  const commandApprovals = useCommandApprovals(backendUrl, selectedConversationId, notices.pushNotice);

  // ── Activities & Streaming ─────────────────────────────
  const activitiesHook = useActivities(
    selectedConversationId,
    selectedConversationIdRef,
    commandApprovals.enqueueCommandApproval,
    notices.pushNotice,
    commandApprovals.pendingApprovalsForSelectedConversation,
  );

  // ── Model Settings ─────────────────────────────────────
  const modelSettings = useModelSettings(selectedConversationId);

  // ── Composer ───────────────────────────────────────────
  const composer = useComposer(selectedConversationId);

  // ── Workspaces ─────────────────────────────────────────
  const workspacesHook = useWorkspaces(
    backendUrl,
    notices.pushNotice,
    activitiesHook.clearConversationView,
    useCallback((parsed) => {
      if (parsed.length === 0) {
        setSelectedConversationId('');
        conversationsHook.setConversationsByWorkspace({});
        modelSettings.setThinkingLevelsByConversation({});
        modelSettings.setComposerModelsByConversation({});
      } else {
        conversationsHook.setConversationsByWorkspace((prev) => {
          const next: Record<string, ConversationSummary[]> = {};
          for (const workspace of parsed) {
            if (prev[workspace.id]) {
              next[workspace.id] = prev[workspace.id];
            }
          }
          return next;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    useCallback(() => {
      setSelectedConversationId('');
    }, []),
  );

  // ── Conversations ──────────────────────────────────────
  const isSending = !!activitiesHook.sendingConversations[selectedConversationId];
  const conversationsHook = useConversations(
    backendUrl,
    workspacesHook.selectedWorkspaceId,
    selectedConversationId,
    setSelectedConversationId,
    selectedConversationIdRef,
    notices.pushNotice,
    activitiesHook.pushActivity,
    activitiesHook.replaceConversationActivities,
    activitiesHook.clearConversationView,
    notices.clearNotices,
    activitiesHook.resetConversationLiveState,
    activitiesHook.activeStreamsRef,
    activitiesHook.handleStreamPacketRef,
    activitiesHook.setSendingConversations,
    activitiesHook.sendingConversationsRef,
    isSending,
    commandApprovals.pendingCommandApprovalsRef,
    modelSettings.setThinkingLevelsByConversation as React.Dispatch<React.SetStateAction<Record<string, unknown>>>,
    composer.setEditingMessageByConversation,
    activitiesHook.setCurrentStatus,
  );

  // ── Local Storage ──────────────────────────────────────
  useLocalStorage({
    backendUrl,
    setBackendUrl,
    selectedWorkspaceId: workspacesHook.selectedWorkspaceId,
    setSelectedWorkspaceId: workspacesHook.setSelectedWorkspaceId,
    selectedConversationId,
    setSelectedConversationId,
    workspacePath: workspacesHook.workspacePath,
    setWorkspacePath: workspacesHook.setWorkspacePath,
    hideLifecycle: activitiesHook.hideLifecycle,
    setHideLifecycle: activitiesHook.setHideLifecycle,
    showMascot: activitiesHook.showMascot,
    setShowMascot: activitiesHook.setShowMascot,
    draftThinkingLevel: modelSettings.draftThinkingLevel,
    setDraftThinkingLevel: modelSettings.setDraftThinkingLevel,
    thinkingLevelsByConversation: modelSettings.thinkingLevelsByConversation,
    setThinkingLevelsByConversation: modelSettings.setThinkingLevelsByConversation,
    draftComposerModel: modelSettings.draftComposerModel,
    setDraftComposerModel: modelSettings.setDraftComposerModel,
    composerModelsByConversation: modelSettings.composerModelsByConversation,
    setComposerModelsByConversation: modelSettings.setComposerModelsByConversation,
    sshTunnelConfig: sshTunnel.sshTunnelConfig,
    setSshTunnelConfig: sshTunnel.setSshTunnelConfig,
  });

  // ── Messaging Actions (cross-hook) ────────────────────

  const sendMessageText = useCallback(
    async (
      messageText: string,
      messageImages: ComposerImage[],
      clearComposer: boolean,
      forceSend = false,
      options?: { retryMessageId?: string; editMessageId?: string; worktreePath?: string },
    ): Promise<void> => {
      const text = messageText.trim();
      const retryMessageId = options?.retryMessageId?.trim() || '';
      const editMessageId = options?.editMessageId?.trim() || '';
      const isRetry = retryMessageId.length > 0;
      const isEdit = editMessageId.length > 0;
      const isBranch = isRetry || isEdit;
      const hasContent = text.length > 0 || messageImages.length > 0;

      if (isRetry && isEdit) {
        return;
      }
      const curSelectedConversationId = selectedConversationIdRef.current;
      const hasActiveSelectedStream = !!(curSelectedConversationId && activitiesHook.activeStreamsRef.current[curSelectedConversationId]);
      const isSelectedConversationSending = !!(curSelectedConversationId && activitiesHook.sendingConversations[curSelectedConversationId]);
      if (((!isBranch && !hasContent) || (isEdit && !hasContent)) || ((hasActiveSelectedStream || isSelectedConversationSending) && !forceSend)) {
        return;
      }
      const selectedComposerModel = normalizeComposerModel(modelSettings.composerModel);
      const selectedThinkingLevel = normalizeThinkingLevelForModel(modelSettings.thinkingLevel, selectedComposerModel);

      let conversationId = curSelectedConversationId;
      if (!isBranch) {
        const ensuredConversationId = await conversationsHook.ensureConversationId(text, { worktreePath: options?.worktreePath });
        if (!ensuredConversationId) {
          return;
        }
        conversationId = ensuredConversationId;
      }
      if (!conversationId) {
        return;
      }
      modelSettings.setThinkingLevelsByConversation((prev) => ({
        ...prev,
        [conversationId]: selectedThinkingLevel,
      }));
      modelSettings.setComposerModelsByConversation((prev) => ({
        ...prev,
        [conversationId]: selectedComposerModel,
      }));

      notices.clearNotices();
      activitiesHook.setSendingConversations((prev) => ({ ...prev, [conversationId]: true }));
      activitiesHook.resetConversationLiveState(conversationId);

      let userEventId: string | null = null;
      if (isBranch) {
        const anchorMessageId = isRetry ? retryMessageId : editMessageId;
        if (anchorMessageId) {
          activitiesHook.updateConversationActivities(conversationId, (prev) => {
            const anchorIndex = prev.findIndex(
              (event) => event.messageId === anchorMessageId || (event.kind === 'user' && event.id === anchorMessageId),
            );
            if (anchorIndex < 0) {
              return prev;
            }

            const next = prev.slice(0, anchorIndex + 1);
            if (isEdit) {
              const anchor = next[anchorIndex];
              if (anchor) {
                next[anchorIndex] = {
                  ...anchor,
                  body: text || '(Images attached)',
                  images: messageImages.map((img) => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
                  userTurn: {
                    model: selectedComposerModel,
                    thinkingLevel: selectedThinkingLevel,
                  },
                };
              }
            }
            return next;
          });
        }
      } else {
        userEventId = activitiesHook.pushActivity({
          kind: 'user',
          title: 'User prompt',
          body: text || '(Images attached)',
          userTurn: {
            model: selectedComposerModel,
            thinkingLevel: selectedThinkingLevel,
          },
          images: messageImages.map((img) => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
        }, conversationId);
      }
      activitiesHook.pushActivity({ kind: 'lifecycle', title: 'Turn started' }, conversationId);
      if (clearComposer) {
        composer.setMessageInput('');
        composer.setComposerImages([]);
      }
      if (isEdit) {
        composer.setEditingMessageByConversation((prev) => {
          if (!(conversationId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
      }
      const requestedStreamID = crypto.randomUUID();
      activitiesHook.activeStreamsRef.current[conversationId] = {
        streamId: requestedStreamID,
        conversationId,
        cancel: async () => { },
        dispose: () => { },
      };

      const stream = await openReplyStream(
        {
          streamId: requestedStreamID,
          baseUrl: backendUrl,
          conversationId,
          message: text,
          retryMessageId: isRetry ? retryMessageId : undefined,
          editMessageId: isEdit ? editMessageId : undefined,
          model: selectedComposerModel,
          thinkingLevel: selectedThinkingLevel,
          images: messageImages.length > 0 ? messageImages.map((img) => ({
            mime_type: img.mimeType,
            data: img.data,
          })) : undefined,
        },
        (packet) => {
          activitiesHook.handleStreamPacket(packet, conversationId);
        },
      ).catch((error: unknown) => {
        activitiesHook.pushActivity({
          kind: 'error',
          title: 'Unable to start stream',
          body: error instanceof Error ? error.message : 'Unknown stream error',
        }, conversationId);
        activitiesHook.finalizeTurn(true, conversationId);
        return null;
      });

      if (!stream) {
        return;
      }

      activitiesHook.activeStreamsRef.current[conversationId] = {
        ...stream,
        conversationId,
      };

      if (!isBranch && userEventId) {
        void conversationsHook.refreshCheckpointsForConversation(conversationId).then((checkpointsList) => {
          const latestCheckpoint = checkpointsList[0];
          if (!latestCheckpoint) {
            return;
          }
          activitiesHook.mutateActivity(userEventId!, (event) => ({
            ...event,
            checkpointId: event.checkpointId || latestCheckpoint.id,
          }));
        });
      }
    },
    [
      backendUrl,
      notices,
      modelSettings,
      conversationsHook,
      activitiesHook,
      composer,
    ],
  );

  const retryFromMessage = useCallback(async (messageId: string): Promise<void> => {
    const targetMessageId = messageId.trim();
    if (!targetMessageId || !selectedConversationId || isSending) {
      return;
    }
    composer.setEditingMessageByConversation((prev) => {
      if (!(selectedConversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[selectedConversationId];
      return next;
    });
    await sendMessageText('', [], false, true, { retryMessageId: targetMessageId });
  }, [isSending, selectedConversationId, sendMessageText, composer]);

  const editMessageInComposer = useCallback((messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]): void => {
    const targetMessageId = messageId.trim();
    if (!targetMessageId || !selectedConversationId) {
      return;
    }

    composer.setEditingMessageByConversation((prev) => ({ ...prev, [selectedConversationId]: targetMessageId }));
    composer.setMessageInput(text);
    composer.setComposerImages(
      images.map((img) => ({
        id: crypto.randomUUID(),
        mimeType: img.mimeType,
        dataUrl: img.dataUrl,
        data: dataUrlToBase64(img.dataUrl),
      })),
    );
  }, [selectedConversationId, composer]);

  const steerQueuedMessage = useCallback(async (id: string) => {
    if (!selectedConversationId) {
      return;
    }
    const msg = composer.queuedMessagesMap[selectedConversationId]?.find((m) => m.id === id);
    if (!msg) return;

    composer.removeQueuedMessage(id);

    const stream = activitiesHook.activeStreamsRef.current[selectedConversationId];
    if (stream) {
      await stream.cancel();
      stream.dispose();
      delete activitiesHook.activeStreamsRef.current[selectedConversationId];
      activitiesHook.pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested for steering' }, selectedConversationId);
    }

    activitiesHook.setSendingConversations((prev) => ({ ...prev, [selectedConversationId]: false }));
    await sendMessageText(msg.text, msg.images, false, true);
  }, [composer, selectedConversationId, activitiesHook, sendMessageText]);

  const sendMessage = useCallback(async (options?: { worktreePath?: string }): Promise<void> => {
    if (composer.editingMessageId) {
      await sendMessageText(composer.messageInput, composer.composerImages, true, false, { editMessageId: composer.editingMessageId, worktreePath: options?.worktreePath });
      return;
    }
    await sendMessageText(composer.messageInput, composer.composerImages, true, false, { worktreePath: options?.worktreePath });
  }, [composer.composerImages, composer.editingMessageId, composer.messageInput, sendMessageText]);

  // Clear editing state if the target message is no longer in activities
  useEffect(() => {
    if (!selectedConversationId || !composer.editingMessageId) {
      return;
    }
    const exists = activitiesHook.activities.some((event) => (event.messageId || event.id) === composer.editingMessageId);
    if (exists) {
      return;
    }
    composer.setEditingMessageByConversation((prev) => {
      if (!(selectedConversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[selectedConversationId];
      return next;
    });
  }, [activitiesHook.activities, composer.editingMessageId, selectedConversationId, composer]);

  // Auto-process queue when not sending
  useEffect(() => {
    const hasActiveSelectedStream = !!(selectedConversationId && activitiesHook.activeStreamsRef.current[selectedConversationId]);
    if (!isSending && !hasActiveSelectedStream && composer.queuedMessages.length > 0 && selectedConversationId) {
      const nextMsg = composer.queuedMessages[0];
      composer.setQueuedMessagesMap(prevMap => {
        const prev = prevMap[selectedConversationId] || [];
        return { ...prevMap, [selectedConversationId]: prev.slice(1) };
      });
      void sendMessageText(nextMsg.text, nextMsg.images, false);
    }
  }, [isSending, composer.queuedMessages, selectedConversationId, sendMessageText, activitiesHook.activeStreamsRef, composer]);

  const applyToolResponseSuggestion = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    composer.setMessageInput(trimmed);
  }, [composer]);

  const sendToolResponseSuggestion = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const hasActiveSelectedStream = !!(selectedConversationId && activitiesHook.activeStreamsRef.current[selectedConversationId]);
    const isSelectedConversationSending = !!(selectedConversationId && activitiesHook.sendingConversations[selectedConversationId]);

    if (hasActiveSelectedStream || isSelectedConversationSending) {
      composer.enqueueConversationMessage(selectedConversationId, trimmed, []);
      return;
    }

    await sendMessageText(trimmed, [], false);
  }, [composer, selectedConversationId, sendMessageText, activitiesHook]);

  const cancelStream = useCallback(async (): Promise<void> => {
    const stream = activitiesHook.activeStreamsRef.current[selectedConversationId];
    if (!stream) {
      return;
    }

    await stream.cancel();
    activitiesHook.pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested' }, selectedConversationId);
  }, [activitiesHook, selectedConversationId]);

  // Reconnect to active stream on conversation select
  useEffect(() => {
    if (!selectedConversationId || activitiesHook.activeStreamsRef.current[selectedConversationId]) {
      return;
    }

    let disposed = false;
    void (async () => {
      const active = await getActiveReplyStream({
        baseUrl: backendUrl,
        conversationId: selectedConversationId,
      });
      if (disposed || !active.ok || !active.streamId || activitiesHook.activeStreamsRef.current[selectedConversationId]) {
        return;
      }

      const attached = attachReplyStream(active.streamId, (packet) => {
        activitiesHook.handleStreamPacket(packet, selectedConversationId);
      });

      activitiesHook.activeStreamsRef.current[selectedConversationId] = {
        ...attached,
        conversationId: selectedConversationId,
      };
      activitiesHook.setSendingConversations((prev) => ({ ...prev, [selectedConversationId]: true }));
      activitiesHook.pushActivity({
        kind: 'lifecycle',
        title: 'Reconnected to active run',
        body: `stream ${shortID(active.streamId)}`,
      }, selectedConversationId);
    })();

    return () => {
      disposed = true;
    };
  }, [backendUrl, activitiesHook, selectedConversationId]);

  // ── Return LoopDesktopController ───────────────────────

  const awaitingApprovalConversations = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const approval of commandApprovals.pendingCommandApprovals) {
      result[approval.conversationId] = true;
    }
    return result;
  }, [commandApprovals.pendingCommandApprovals]);

  return {
    backendUrl,
    setBackendUrl,

    sshTunnelConfig: sshTunnel.sshTunnelConfig,
    setSshTunnelConfig: sshTunnel.setSshTunnelConfig,
    sshTunnelStatus: sshTunnel.sshTunnelStatus,
    sshTunnelError: sshTunnel.sshTunnelError,
    connectTunnel: sshTunnel.connectTunnel,
    disconnectTunnel: sshTunnel.disconnectTunnel,

    workspaces: workspacesHook.workspaces,
    selectedWorkspaceId: workspacesHook.selectedWorkspaceId,
    selectedWorkspace: workspacesHook.selectedWorkspace,
    workspacePath: workspacesHook.workspacePath,
    setWorkspacePath: workspacesHook.setWorkspacePath,
    workspaceName: workspacesHook.workspaceName,
    setWorkspaceName: workspacesHook.setWorkspaceName,
    isLoadingWorkspaces: workspacesHook.isLoadingWorkspaces,

    conversations: conversationsHook.conversations,
    conversationsByWorkspace: conversationsHook.conversationsByWorkspace,
    hasMoreConversationsByWorkspace: conversationsHook.hasMoreConversationsByWorkspace,
    selectedConversationId,
    selectedConversation: conversationsHook.selectedConversation,
    checkpoints: conversationsHook.checkpoints,

    activities: activitiesHook.visibleActivities,
    feedScrollRef: activitiesHook.feedScrollRef,

    queuedMessages: composer.queuedMessages,
    queueMessage: composer.queueMessage,
    removeQueuedMessage: composer.removeQueuedMessage,
    reorderQueuedMessage: composer.reorderQueuedMessage,
    steerQueuedMessage,
    messageInput: composer.messageInput,
    setMessageInput: composer.setMessageInput,
    composerImages: composer.composerImages,
    setComposerImages: composer.setComposerImages,
    canCompose: workspacesHook.selectedWorkspaceId !== '',
    isSending,
    sendingConversations: activitiesHook.sendingConversations,
    awaitingApprovalConversations,
    notices: notices.notices,
    pendingCommandApproval: commandApprovals.pendingCommandApproval,
    pendingCommandApprovalCount: commandApprovals.pendingApprovalsForSelectedConversation.length,
    isResolvingCommandApproval: commandApprovals.isResolvingCommandApproval,
    isRestoringCheckpoint: conversationsHook.isRestoringCheckpoint,
    isLoadingSelectedConversation: conversationsHook.isLoadingSelectedConversation,
    pushNotice: notices.pushNotice,
    dismissNotice: notices.dismissNotice,
    resolveCommandApproval: commandApprovals.resolveCommandApproval,
    hideLifecycle: activitiesHook.hideLifecycle,
    setHideLifecycle: activitiesHook.setHideLifecycle,
    showMascot: activitiesHook.showMascot,
    setShowMascot: activitiesHook.setShowMascot,
    thinkingLevel: modelSettings.thinkingLevel,
    setThinkingLevel: modelSettings.setThinkingLevel,
    composerModel: modelSettings.composerModel,
    setComposerModel: modelSettings.setComposerModel,
    currentStatus: activitiesHook.currentStatus,
    setCurrentStatus: activitiesHook.setCurrentStatus,

    refreshWorkspaces: workspacesHook.refreshWorkspaces,
    refreshConversations: conversationsHook.refreshConversations,
    refreshCheckpoints: conversationsHook.refreshCheckpoints,
    pickFolder: workspacesHook.pickFolder,
    createWorkspace: workspacesHook.createWorkspace,
    pickAndCreateWorkspace: workspacesHook.pickAndCreateWorkspace,
    deleteWorkspace: workspacesHook.deleteWorkspace,
    selectWorkspace: (workspaceId: string) => {
      workspacesHook.selectWorkspace(workspaceId);
      setSelectedConversationId('');
    },
    selectConversation: conversationsHook.selectConversation,
    loadMoreConversations: conversationsHook.loadMoreConversations,
    newConversation: conversationsHook.newConversation,
    deleteConversation: conversationsHook.deleteConversation,
    renameConversation: conversationsHook.renameConversation,

    sendMessage,
    cancelStream,
    createCheckpoint: conversationsHook.createCheckpoint,
    restoreCheckpoint: conversationsHook.restoreCheckpoint,
    applyPatchToWorkspace: conversationsHook.applyPatchToWorkspace,
    undoLatestCheckpoint: conversationsHook.undoLatestCheckpoint,
    applyToolResponseSuggestion,
    sendToolResponseSuggestion,
    retryFromMessage,
    editMessageInComposer,
  };
}
