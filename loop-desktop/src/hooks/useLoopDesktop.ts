import { useCallback, useEffect, useRef, useMemo } from 'react';
import { attachReplyStream, getActiveReplyStream, openReplyStream } from '../lib/loopClient';
import type { LoopDesktopController } from './useLoopDesktop.types';
import { normalizeComposerModel, normalizeThinkingLevelForModel } from './useLoopDesktop.helpers';
import type { ComposerImage } from './useLoopDesktop.types';

import { useActivities } from './useActivities';
import { useConversations } from './useConversations';
import { useLocalStorage } from './useLocalStorage';
import { useSshTunnel } from './useSshTunnel';
import { useWorkspaces } from './useWorkspaces';

import { useConnectionStore } from '../stores/connectionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useStreamingStore, activeStreams } from '../stores/streamingStore';
import { useUiPrefsStore } from '../stores/uiPrefsStore';
import { useNoticeStore } from '../stores/noticeStore';
import { useCommandApprovalStore } from '../stores/commandApprovalStore';
import { useModelSettingsStore } from '../stores/modelSettingsStore';
import { useSshTunnelStore } from '../stores/sshTunnelStore';
import { useComposerDraftStore } from '../stores/composerDraftStore';
import { shortID } from '../utils/parsers';

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
  if (commaIndex < 0) return dataUrl.trim();
  return dataUrl.slice(commaIndex + 1).trim();
}

export function useLoopDesktop(): LoopDesktopController {
  // ── Sub-hooks (now zero-argument) ─────────────────────
  const activitiesHook = useActivities();
  const conversationsHook = useConversations();
  const workspacesHook = useWorkspaces();
  const sshTunnel = useSshTunnel();
  useLocalStorage();

  // ── Store subscriptions ────────────────────────────────
  const backendUrl = useConnectionStore((s) => s.backendUrl);
  const setBackendUrl = useConnectionStore.getState().setBackendUrl;
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);

  // Keep a stable ref for use in async callbacks
  const selectedConversationIdRef = useRef(selectedConversationId);
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  const sendingConversations = useStreamingStore((s) => s.sendingConversations);
  const setSendingConversations = useStreamingStore((s) => s.setSendingConversations);
  const isSending = !!sendingConversations[selectedConversationId];

  // ── Granular store subscriptions (avoid whole-store re-renders) ─────────
  const notices = useNoticeStore((s) => s.notices);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const dismissNotice = useNoticeStore((s) => s.dismissNotice);

  const hideLifecycle = useUiPrefsStore((s) => s.hideLifecycle);
  const setHideLifecycle = useUiPrefsStore((s) => s.setHideLifecycle);
  const showMascot = useUiPrefsStore((s) => s.showMascot);
  const setShowMascot = useUiPrefsStore((s) => s.setShowMascot);
  const reactScanEnabled = useUiPrefsStore((s) => s.reactScanEnabled);
  const setReactScanEnabled = useUiPrefsStore((s) => s.setReactScanEnabled);
  const currentStatus = useUiPrefsStore((s) => s.currentStatus);
  const setCurrentStatus = useUiPrefsStore((s) => s.setCurrentStatus);

  const composerModelsByConversation = useModelSettingsStore((s) => s.composerModelsByConversation);
  const draftComposerModel = useModelSettingsStore((s) => s.draftComposerModel);
  const thinkingLevelsByConversation = useModelSettingsStore((s) => s.thinkingLevelsByConversation);
  const draftThinkingLevel = useModelSettingsStore((s) => s.draftThinkingLevel);

  const allPendingApprovals = useCommandApprovalStore((s) => s.pendingCommandApprovals);
  const isResolvingCommandApproval = useCommandApprovalStore((s) => s.isResolvingCommandApproval);
  const resolveCommandApproval = useCommandApprovalStore((s) => s.resolveCommandApproval);

  // ── Derived model/thinking for current conversation ────────────────────
  const composerModel = useMemo(
    () => useModelSettingsStore.getState().getComposerModel(selectedConversationId),
    [selectedConversationId, composerModelsByConversation, draftComposerModel],
  );
  const thinkingLevel = useMemo(
    () => useModelSettingsStore.getState().getThinkingLevel(selectedConversationId),
    [selectedConversationId, thinkingLevelsByConversation, draftThinkingLevel, composerModel],
  );

  // ── Derived pending approval for selected conversation ─────────────────
  const pendingApprovalsForConversation = useMemo(
    () => allPendingApprovals.filter((item) => item.conversationId === selectedConversationId),
    [allPendingApprovals, selectedConversationId],
  );
  const pendingCommandApproval = pendingApprovalsForConversation[0] ?? null;

  // ── Messaging ─────────────────────────────────────────
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

      if (isRetry && isEdit) return;

      const curSelectedConversationId = selectedConversationIdRef.current;
      const hasActiveSelectedStream = !!(curSelectedConversationId && activeStreams[curSelectedConversationId]);
      const isSelectedConversationSending = !!useStreamingStore.getState().sendingConversations[curSelectedConversationId];

      if (((!isBranch && !hasContent) || (isEdit && !hasContent)) || ((hasActiveSelectedStream || isSelectedConversationSending) && !forceSend)) {
        return;
      }

      const { getState: modelState } = useModelSettingsStore;
      const selectedComposerModel = normalizeComposerModel(modelState().getComposerModel(curSelectedConversationId));
      const selectedThinkingLevel = normalizeThinkingLevelForModel(modelState().getThinkingLevel(curSelectedConversationId), selectedComposerModel);

      let conversationId = curSelectedConversationId;
      if (!isBranch) {
        const ensuredConversationId = await conversationsHook.ensureConversationId(text, { worktreePath: options?.worktreePath });
        if (!ensuredConversationId) return;
        conversationId = ensuredConversationId;
      }
      if (!conversationId) return;

      modelState().setThinkingLevelsByConversation((prev) => {
        if (prev[conversationId] === selectedThinkingLevel) return prev;
        return { ...prev, [conversationId]: selectedThinkingLevel };
      });
      modelState().setComposerModelsByConversation((prev) => {
        if (prev[conversationId] === selectedComposerModel) return prev;
        return { ...prev, [conversationId]: selectedComposerModel };
      });

      useNoticeStore.getState().clearNotices();
      setSendingConversations((prev) => ({ ...prev, [conversationId]: true }));
      activitiesHook.resetConversationLiveState(conversationId);

      let userEventId: string | null = null;
      if (isBranch) {
        const anchorMessageId = isRetry ? retryMessageId : editMessageId;
        if (anchorMessageId) {
          activitiesHook.updateConversationActivities(conversationId, (prev) => {
            const anchorIndex = prev.findIndex(
              (event) => event.messageId === anchorMessageId || (event.kind === 'user' && event.id === anchorMessageId),
            );
            if (anchorIndex < 0) return prev;
            const next = prev.slice(0, anchorIndex + 1);
            if (isEdit) {
              const anchor = next[anchorIndex];
              if (anchor) {
                next[anchorIndex] = {
                  ...anchor,
                  body: text || '(Images attached)',
                  images: messageImages.map((img) => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
                  userTurn: { model: selectedComposerModel, thinkingLevel: selectedThinkingLevel },
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
          userTurn: { model: selectedComposerModel, thinkingLevel: selectedThinkingLevel },
          images: messageImages.map((img) => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
        }, conversationId);
      }
      activitiesHook.pushActivity({ kind: 'lifecycle', title: 'Turn started' }, conversationId);
      if (clearComposer) {
        useComposerDraftStore.getState().clearComposerDraft(curSelectedConversationId);
      }
      if (isEdit) {
        useComposerDraftStore.getState().clearEditingMessage(conversationId);
      }

      const requestedStreamID = crypto.randomUUID();
      activeStreams[conversationId] = {
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

      if (!stream) return;

      activeStreams[conversationId] = { ...stream, conversationId };

      if (!isBranch && userEventId) {
        void conversationsHook.refreshCheckpointsForConversation(conversationId).then((checkpointsList) => {
          const latestCheckpoint = checkpointsList[0];
          if (!latestCheckpoint) return;
          activitiesHook.mutateActivity(userEventId!, (event) => ({
            ...event,
            checkpointId: event.checkpointId || latestCheckpoint.id,
          }));
        });
      }
    },
    [backendUrl, conversationsHook, activitiesHook, setSendingConversations],
  );

  const retryFromMessage = useCallback(async (messageId: string): Promise<void> => {
    const targetMessageId = messageId.trim();
    if (!targetMessageId || !selectedConversationId || isSending) return;
    useComposerDraftStore.getState().clearEditingMessage(selectedConversationId);
    await sendMessageText('', [], false, true, { retryMessageId: targetMessageId });
  }, [isSending, selectedConversationId, sendMessageText]);

  const editMessageInComposer = useCallback((messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]): void => {
    const targetMessageId = messageId.trim();
    if (!targetMessageId || !selectedConversationId) return;
    const drafts = useComposerDraftStore.getState();
    drafts.setEditingMessage(selectedConversationId, targetMessageId);
    drafts.setMessageInput(selectedConversationId, text);
    drafts.setComposerImages(selectedConversationId, images.map((img) => ({
      id: crypto.randomUUID(),
      mimeType: img.mimeType,
      dataUrl: img.dataUrl,
      data: dataUrlToBase64(img.dataUrl),
    })));
  }, [selectedConversationId]);

  const steerQueuedMessage = useCallback(async (id: string) => {
    if (!selectedConversationId) return;
    const drafts = useComposerDraftStore.getState();
    const msg = drafts.queuedMessagesMap[selectedConversationId]?.find((message) => message.id === id);
    if (!msg) return;

    drafts.removeQueuedMessage(selectedConversationId, id);
    const stream = activeStreams[selectedConversationId];
    if (stream) {
      await stream.cancel();
      stream.dispose();
      delete activeStreams[selectedConversationId];
      activitiesHook.pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested for steering' }, selectedConversationId);
    }

    setSendingConversations((prev) => ({ ...prev, [selectedConversationId]: false }));
    await sendMessageText(msg.text, msg.images, false, true);
  }, [selectedConversationId, activitiesHook, sendMessageText, setSendingConversations]);

  const sendMessage = useCallback(async (options?: { worktreePath?: string }): Promise<void> => {
    const drafts = useComposerDraftStore.getState();
    const editingMessageId = drafts.editingMessageByConversation[selectedConversationId] || '';
    const messageInput = drafts.composerInputs[selectedConversationId] || '';
    const composerImages = drafts.composerImagesMap[selectedConversationId] || [];

    if (editingMessageId) {
      await sendMessageText(messageInput, composerImages, true, false, { editMessageId: editingMessageId, worktreePath: options?.worktreePath });
      return;
    }
    await sendMessageText(messageInput, composerImages, true, false, { worktreePath: options?.worktreePath });
  }, [selectedConversationId, sendMessageText]);

  const applyToolResponseSuggestion = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    useComposerDraftStore.getState().setMessageInput(selectedConversationId, trimmed);
  }, [selectedConversationId]);

  const sendToolResponseSuggestion = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const hasActiveStream = !!activeStreams[selectedConversationId];
    const isConversationSending = !!useStreamingStore.getState().sendingConversations[selectedConversationId];
    if (hasActiveStream || isConversationSending) {
      useComposerDraftStore.getState().enqueueConversationMessage(selectedConversationId, trimmed, []);
      return;
    }
    await sendMessageText(trimmed, [], false);
  }, [selectedConversationId, sendMessageText]);

  const cancelStream = useCallback(async (): Promise<void> => {
    const stream = activeStreams[selectedConversationId];
    if (!stream) return;
    await stream.cancel();
    activitiesHook.pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested' }, selectedConversationId);
  }, [activitiesHook, selectedConversationId]);

  // ── Clear editing state if target message no longer exists ──
  useEffect(() => {
    if (!selectedConversationId) return;
    const editingMessageId = useComposerDraftStore.getState().editingMessageByConversation[selectedConversationId] || '';
    if (!editingMessageId) return;
    const exists = activitiesHook.activities.some((event) => (event.messageId || event.id) === editingMessageId);
    if (exists) return;
    useComposerDraftStore.getState().clearEditingMessage(selectedConversationId);
  }, [activitiesHook.activities, selectedConversationId]);

  // ── Auto-process queue when not sending ──────────────
  useEffect(() => {
    const hasActiveStream = !!(selectedConversationId && activeStreams[selectedConversationId]);
    const nextMsg = selectedConversationId
      ? useComposerDraftStore.getState().queuedMessagesMap[selectedConversationId]?.[0]
      : null;
    if (!isSending && !hasActiveStream && nextMsg && selectedConversationId) {
      useComposerDraftStore.getState().dequeueQueuedMessage(selectedConversationId);
      void sendMessageText(nextMsg.text, nextMsg.images, false);
    }
  }, [isSending, selectedConversationId, sendMessageText]);

  // ── Reconnect to active stream on conversation select ──
  useEffect(() => {
    if (!selectedConversationId || activeStreams[selectedConversationId]) return;

    let disposed = false;
    void (async () => {
      const active = await getActiveReplyStream({
        baseUrl: backendUrl,
        conversationId: selectedConversationId,
      });
      if (disposed || !active.ok || !active.streamId || activeStreams[selectedConversationId]) return;

      const attached = attachReplyStream(active.streamId, (packet) => {
        activitiesHook.handleStreamPacket(packet, selectedConversationId);
      });
      activeStreams[selectedConversationId] = { ...attached, conversationId: selectedConversationId };
      setSendingConversations((prev) => ({ ...prev, [selectedConversationId]: true }));
      activitiesHook.pushActivity({
        kind: 'lifecycle',
        title: 'Reconnected to active run',
        body: `stream ${shortID(active.streamId)}`,
      }, selectedConversationId);
    })();

    return () => { disposed = true; };
  }, [backendUrl, activitiesHook, selectedConversationId, setSendingConversations]);

  // ── Derived: awaitingApprovalConversations ────────────
  const awaitingApprovalConversations = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const approval of allPendingApprovals) {
      result[approval.conversationId] = true;
    }
    return result;
  }, [allPendingApprovals]);


  // ── Return LoopDesktopController ──────────────────────
  return {
    backendUrl,
    setBackendUrl,

    sshTunnelConfig: sshTunnel.sshTunnelConfig,
    setSshTunnelConfig: sshTunnel.setSshTunnelConfig,
    sshTunnelStatus: useSshTunnelStore((s) => s.sshTunnelStatus),
    sshTunnelError: useSshTunnelStore((s) => s.sshTunnelError),
    connectTunnel: sshTunnel.connectTunnel,
    disconnectTunnel: sshTunnel.disconnectTunnel,

    workspaces: workspacesHook.workspaces,
    selectedWorkspaceId,
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

    steerQueuedMessage,
    canCompose: selectedWorkspaceId !== '',
    isSending,
    sendingConversations,
    awaitingApprovalConversations,
    notices,
    pendingCommandApproval,
    pendingCommandApprovalCount: pendingApprovalsForConversation.length,
    isResolvingCommandApproval,
    isRestoringCheckpoint: conversationsHook.isRestoringCheckpoint,
    isLoadingSelectedConversation: conversationsHook.isLoadingSelectedConversation,
    pushNotice,
    dismissNotice,
    resolveCommandApproval,
    hideLifecycle,
    setHideLifecycle,
    showMascot,
    setShowMascot,
    reactScanEnabled,
    setReactScanEnabled,
    thinkingLevel,
    setThinkingLevel: (value) => {
      const normalizedModel = normalizeComposerModel(useModelSettingsStore.getState().getComposerModel(selectedConversationId));
      const normalized = normalizeThinkingLevelForModel(value, normalizedModel);
      if (!selectedConversationId) {
        useModelSettingsStore.getState().setDraftThinkingLevel(normalized);
        return;
      }
      useModelSettingsStore.getState().setThinkingLevelsByConversation((prev) => {
        if (prev[selectedConversationId] === normalized) return prev;
        return { ...prev, [selectedConversationId]: normalized };
      });
    },
    composerModel,
    setComposerModel: (value) => {
      const normalized = normalizeComposerModel(value);
      if (!selectedConversationId) {
        useModelSettingsStore.getState().setDraftComposerModel(normalized);
        useModelSettingsStore.getState().setDraftThinkingLevel(
          normalizeThinkingLevelForModel(useModelSettingsStore.getState().draftThinkingLevel, normalized),
        );
        return;
      }
      useModelSettingsStore.getState().setComposerModelsByConversation((prev) => {
        if (prev[selectedConversationId] === normalized) return prev;
        return { ...prev, [selectedConversationId]: normalized };
      });
      useModelSettingsStore.getState().setThinkingLevelsByConversation((prev) => {
        const current = prev[selectedConversationId] ?? useModelSettingsStore.getState().draftThinkingLevel;
        const adjusted = normalizeThinkingLevelForModel(current, normalized);
        if (current === adjusted && selectedConversationId in prev) return prev;
        return { ...prev, [selectedConversationId]: adjusted };
      });
    },
    currentStatus,
    setCurrentStatus,

    refreshWorkspaces: workspacesHook.refreshWorkspaces,
    refreshConversations: conversationsHook.refreshConversations,
    refreshCheckpoints: conversationsHook.refreshCheckpoints,
    pickFolder: workspacesHook.pickFolder,
    createWorkspace: workspacesHook.createWorkspace,
    pickAndCreateWorkspace: workspacesHook.pickAndCreateWorkspace,
    deleteWorkspace: workspacesHook.deleteWorkspace,
    selectWorkspace: (workspaceId: string) => {
      workspacesHook.selectWorkspace(workspaceId);
      useSelectionStore.getState().setSelectedConversationId('');
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
