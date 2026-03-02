import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoopStreamPacket } from '../electron';
import { attachReplyStream, chooseFolder, getActiveReplyStream, openReplyStream, requestJson } from '../lib/loopClient';
import type {
  ActivityEvent,
  CheckpointSummary,
  ComposerModel,
  ConversationSummary,
  ThinkingLevel,
  WorkspaceSummary,
} from '../types/ui';
import {
  type ActivityInput,
  historyRowsToActivities,
} from '../utils/activityTimeline';
import {
  asRecord,
  buildConversationTitle,
  getString,
  lastPathSegment,
  parseCheckpoint,
  parseConversation,
  parseWorkspace,
  shortID,
  stringifyResponseError,
} from '../utils/parsers';
import { DEFAULT_COMPOSER_MODEL, DEFAULT_THINKING_LEVEL, STORAGE_KEY } from './useLoopDesktop.constants';
import {
  annotateActivitiesWithPendingApprovals,
  normalizeComposerModel,
  normalizeThinkingLevel,
  normalizeThinkingLevelForModel,
  parsePendingCommandApprovalRecord,
  rowsFromUnknown,
} from './useLoopDesktop.helpers';
import { createHandleStreamPacket, createHandleTurnEvent } from './useLoopDesktop.stream';
import type {
  CommandApprovalDecision,
  ComposerImage,
  ConversationLiveState,
  LoopDesktopController,
  NoticeTone,
  NoticeToast,
  PendingCommandApproval,
  QueuedMessage,
  SshTunnelConfig,
  SshTunnelStatus,
  StreamHandle,
} from './useLoopDesktop.types';

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

  const [sshTunnelConfig, setSshTunnelConfig] = useState<SshTunnelConfig>({
    host: 'localhost',
    port: 22,
    username: '',
    privateKeyPath: '',
    remotePort: 8080,
  });
  const [sshTunnelStatus, setSshTunnelStatus] = useState<SshTunnelStatus>('disconnected');
  const [sshTunnelError, setSshTunnelError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');

  const [hideLifecycle, setHideLifecycle] = useState(true);
  const [showMascot, setShowMascot] = useState(false);
  const [draftThinkingLevel, setDraftThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [thinkingLevelsByConversation, setThinkingLevelsByConversation] = useState<Record<string, ThinkingLevel>>({});
  const [draftComposerModel, setDraftComposerModel] = useState<ComposerModel>(DEFAULT_COMPOSER_MODEL);
  const [composerModelsByConversation, setComposerModelsByConversation] = useState<Record<string, ComposerModel>>({});
  const [conversationsByWorkspace, setConversationsByWorkspace] = useState<Record<string, ConversationSummary[]>>({});
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [checkpointsByConversation, setCheckpointsByConversation] = useState<Record<string, CheckpointSummary[]>>({});

  const [activities, setActivities] = useState<ActivityEvent[]>([]);

  const [composerInputs, setComposerInputs] = useState<Record<string, string>>({});
  const [composerImagesMap, setComposerImagesMap] = useState<Record<string, ComposerImage[]>>({});
  const [editingMessageByConversation, setEditingMessageByConversation] = useState<Record<string, string>>({});
  const [queuedMessagesMap, setQueuedMessagesMap] = useState<Record<string, QueuedMessage[]>>({});

  const editingMessageId = editingMessageByConversation[selectedConversationId] || '';

  const messageInput = composerInputs[selectedConversationId] || '';
  const setMessageInput = useCallback((value: React.SetStateAction<string>) => {
    setComposerInputs(prevMap => {
      const prev = prevMap[selectedConversationId] || '';
      const next = typeof value === 'function' ? (value as (prevState: string) => string)(prev) : value;
      return { ...prevMap, [selectedConversationId]: next };
    });
  }, [selectedConversationId]);

  const composerImages = useMemo(
    () => composerImagesMap[selectedConversationId] || [],
    [composerImagesMap, selectedConversationId]
  );
  const setComposerImages = useCallback((value: React.SetStateAction<ComposerImage[]>) => {
    setComposerImagesMap(prevMap => {
      const prev = prevMap[selectedConversationId] || [];
      const next = typeof value === 'function' ? (value as (prevState: ComposerImage[]) => ComposerImage[])(prev) : value;
      return { ...prevMap, [selectedConversationId]: next };
    });
  }, [selectedConversationId]);

  const queuedMessages = useMemo(
    () => queuedMessagesMap[selectedConversationId] || [],
    [queuedMessagesMap, selectedConversationId]
  );

  const enqueueConversationMessage = useCallback(
    (conversationId: string, messageText: string, messageImages: ComposerImage[]): boolean => {
      const text = messageText.trim();
      if (!conversationId || (!text && messageImages.length === 0)) {
        return false;
      }

      setQueuedMessagesMap((prevMap) => {
        const prev = prevMap[conversationId] || [];
        return {
          ...prevMap,
          [conversationId]: [...prev, { id: crypto.randomUUID(), text, images: messageImages }],
        };
      });
      return true;
    },
    [],
  );

  const queueMessage = useCallback(() => {
    const queued = enqueueConversationMessage(selectedConversationId, messageInput, composerImages);
    if (!queued) {
      return;
    }
    setMessageInput('');
    setComposerImages([]);
  }, [composerImages, enqueueConversationMessage, messageInput, selectedConversationId, setComposerImages, setMessageInput]);

  const removeQueuedMessage = useCallback((id: string) => {
    setQueuedMessagesMap(prevMap => {
      const prev = prevMap[selectedConversationId] || [];
      return { ...prevMap, [selectedConversationId]: prev.filter(m => m.id !== id) };
    });
  }, [selectedConversationId]);

  const reorderQueuedMessage = useCallback((id: string, direction: 'up' | 'down') => {
    setQueuedMessagesMap(prevMap => {
      const prev = prevMap[selectedConversationId] || [];
      const idx = prev.findIndex(m => m.id === id);
      if (idx < 0) return prevMap;

      const next = [...prev];
      if (direction === 'up' && idx > 0) {
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      } else if (direction === 'down' && idx < prev.length - 1) {
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      }
      return { ...prevMap, [selectedConversationId]: next };
    });
  }, [selectedConversationId]);

  // Auto-process queue when not sending

  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);
  const [sendingConversations, setSendingConversations] = useState<Record<string, boolean>>({});
  const isSending = !!sendingConversations[selectedConversationId];
  const [currentStatus, setCurrentStatus] = useState<string>('');
  const [notices, setNotices] = useState<NoticeToast[]>([]);
  const [pendingCommandApprovals, setPendingCommandApprovals] = useState<PendingCommandApproval[]>([]);
  const [isResolvingCommandApproval, setIsResolvingCommandApproval] = useState(false);
  const [isRestoringCheckpoint, setIsRestoringCheckpoint] = useState(false);
  const pendingApprovalsForSelectedConversation = useMemo(
    () => pendingCommandApprovals.filter((item) => item.conversationId === selectedConversationId),
    [pendingCommandApprovals, selectedConversationId],
  );
  const pendingCommandApproval = pendingApprovalsForSelectedConversation[0] ?? null;

  const activeStreamsRef = useRef<Record<string, StreamHandle>>({});
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationLiveStateRef = useRef<Record<string, ConversationLiveState>>({});
  const handleStreamPacketRef = useRef<((packet: LoopStreamPacket, conversationId: string) => void) | null>(null);
  const selectedConversationIdRef = useRef('');
  const sendingConversationsRef = useRef<Record<string, boolean>>({});
  const pendingCommandApprovalsRef = useRef<PendingCommandApproval[]>([]);

  const getConversationLiveState = useCallback((conversationId: string): ConversationLiveState => {
    const existing = conversationLiveStateRef.current[conversationId];
    if (existing) {
      return existing;
    }
    const fresh: ConversationLiveState = {
      draftAssistantId: null,
      draftThoughtId: null,
      lastStatus: '',
      openToolEventIDs: {},
      retryStatusEventID: null,
    };
    conversationLiveStateRef.current[conversationId] = fresh;
    return fresh;
  }, []);

  const resetConversationLiveState = useCallback((conversationId: string): void => {
    if (!conversationId) {
      return;
    }
    conversationLiveStateRef.current[conversationId] = {
      draftAssistantId: null,
      draftThoughtId: null,
      lastStatus: '',
      openToolEventIDs: {},
      retryStatusEventID: null,
    };
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const conversations = useMemo(
    () => conversationsByWorkspace[selectedWorkspaceId] ?? [],
    [conversationsByWorkspace, selectedWorkspaceId],
  );

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  const checkpoints = useMemo(
    () => checkpointsByConversation[selectedConversationId] ?? [],
    [checkpointsByConversation, selectedConversationId],
  );

  const composerModel = useMemo<ComposerModel>(() => {
    if (!selectedConversationId) {
      return draftComposerModel;
    }
    return composerModelsByConversation[selectedConversationId] ?? DEFAULT_COMPOSER_MODEL;
  }, [composerModelsByConversation, draftComposerModel, selectedConversationId]);

  const thinkingLevel = useMemo<ThinkingLevel>(() => {
    if (!selectedConversationId) {
      return normalizeThinkingLevelForModel(draftThinkingLevel, composerModel);
    }
    const stored = thinkingLevelsByConversation[selectedConversationId] ?? DEFAULT_THINKING_LEVEL;
    return normalizeThinkingLevelForModel(stored, composerModel);
  }, [composerModel, draftThinkingLevel, selectedConversationId, thinkingLevelsByConversation]);

  const setThinkingLevel = useCallback(
    (value: ThinkingLevel): void => {
      const normalized = normalizeThinkingLevelForModel(value, composerModel);
      if (!selectedConversationId) {
        setDraftThinkingLevel(normalized);
        return;
      }
      setThinkingLevelsByConversation((prev) => ({
        ...prev,
        [selectedConversationId]: normalized,
      }));
    },
    [composerModel, selectedConversationId],
  );

  const setComposerModel = useCallback(
    (value: ComposerModel): void => {
      const normalized = normalizeComposerModel(value);
      if (!selectedConversationId) {
        setDraftComposerModel(normalized);
        setDraftThinkingLevel((prev) => normalizeThinkingLevelForModel(prev, normalized));
        return;
      }
      setComposerModelsByConversation((prev) => ({
        ...prev,
        [selectedConversationId]: normalized,
      }));
      setThinkingLevelsByConversation((prev) => {
        const current = prev[selectedConversationId] ?? DEFAULT_THINKING_LEVEL;
        const adjusted = normalizeThinkingLevelForModel(current, normalized);
        if (current === adjusted && selectedConversationId in prev) {
          return prev;
        }
        return {
          ...prev,
          [selectedConversationId]: adjusted,
        };
      });
    },
    [selectedConversationId],
  );

  const pushNotice = useCallback((tone: NoticeTone, message: string): void => {
    setNotices((prev) => [...prev.slice(-3), { id: crypto.randomUUID(), tone, message }]);
  }, []);

  const dismissNotice = useCallback((id: string): void => {
    setNotices((prev) => prev.filter((notice) => notice.id !== id));
  }, []);

  const clearNotices = useCallback((): void => {
    setNotices([]);
  }, []);

  const enqueueCommandApproval = useCallback((approval: PendingCommandApproval): void => {
    setPendingCommandApprovals((prev) => {
      if (prev.some((item) => item.id === approval.id)) {
        return prev;
      }
      return [...prev, approval];
    });
  }, []);

  const syncPendingApprovalsForConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (!conversationId) {
        return;
      }

      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/command-approvals?conversation_id=${encodeURIComponent(conversationId)}`,
        method: 'GET',
      });
      if (!response.ok) {
        return;
      }

      const fetched = rowsFromUnknown(response.data)
        .map((item) => parsePendingCommandApprovalRecord(asRecord(item), conversationId))
        .filter((item): item is PendingCommandApproval => item !== null);

      setPendingCommandApprovals((prev) => {
        const others = prev.filter((item) => item.conversationId !== conversationId);
        if (fetched.length === 0) {
          return others;
        }
        const deduped = new Map<string, PendingCommandApproval>();
        for (const item of fetched) {
          deduped.set(item.id, item);
        }
        return [...others, ...Array.from(deduped.values())];
      });
    },
    [backendUrl],
  );

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    sendingConversationsRef.current = sendingConversations;
  }, [sendingConversations]);

  useEffect(() => {
    pendingCommandApprovalsRef.current = pendingCommandApprovals;
  }, [pendingCommandApprovals]);

  useEffect(() => {
    if (!selectedConversationId) {
      return;
    }
    void syncPendingApprovalsForConversation(selectedConversationId);
  }, [selectedConversationId, syncPendingApprovalsForConversation]);

  useEffect(() => {
    setActivities((prev) => annotateActivitiesWithPendingApprovals(prev, pendingApprovalsForSelectedConversation));
  }, [pendingApprovalsForSelectedConversation]);

  const pushActivity = useCallback((input: ActivityInput): string => {
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      userTurn: input.userTurn,
      tool: input.tool,
      images: input.images,
      timestamp: Date.now(),
      streaming: input.streaming,
    };

    setActivities((prev) => {
      const merged = [...prev, event];
      if (merged.length > 420) {
        return merged.slice(merged.length - 420);
      }
      return merged;
    });

    return event.id;
  }, []);

  const mutateActivity = useCallback((id: string, transform: (event: ActivityEvent) => ActivityEvent): void => {
    setActivities((prev) => prev.map((event) => (event.id === id ? transform(event) : event)));
  }, []);

  const appendStreamingText = useCallback(
    (conversationId: string, kind: 'assistant' | 'thought', text: string): void => {
      if (!text) {
        return;
      }

      const liveState = getConversationLiveState(conversationId);
      const existing = kind === 'assistant' ? liveState.draftAssistantId : liveState.draftThoughtId;
      if (!existing) {
        const draftID = pushActivity({
          kind,
          title: kind === 'assistant' ? 'Assistant response' : 'Model thought',
          body: text,
          streaming: true,
        });
        if (kind === 'assistant') {
          liveState.draftAssistantId = draftID;
        } else {
          liveState.draftThoughtId = draftID;
        }
        return;
      }

      mutateActivity(existing, (event) => ({
        ...event,
        body: `${event.body ?? ''}${text}`,
        streaming: true,
      }));
    },
    [getConversationLiveState, mutateActivity, pushActivity],
  );

  const settleDrafts = useCallback((conversationId: string): void => {
    if (!conversationId) {
      return;
    }
    const liveState = getConversationLiveState(conversationId);
    const draftIDs = [liveState.draftAssistantId, liveState.draftThoughtId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );

    if (draftIDs.length > 0) {
      setActivities((prev) =>
        prev.map((event) => {
          if (!draftIDs.includes(event.id)) {
            return event;
          }
          return { ...event, streaming: false };
        }),
      );
    }

    liveState.draftAssistantId = null;
    liveState.draftThoughtId = null;
  }, [getConversationLiveState]);

  const settleThoughtDraft = useCallback((conversationId: string): void => {
    if (!conversationId) {
      return;
    }
    const liveState = getConversationLiveState(conversationId);
    const draftID = liveState.draftThoughtId;
    if (!draftID) {
      return;
    }

    mutateActivity(draftID, (event) => ({ ...event, streaming: false }));
    liveState.draftThoughtId = null;
  }, [getConversationLiveState, mutateActivity]);

  const finalizeTurn = useCallback(
    (closeStream: boolean, conversationId?: string): void => {
      const targetConversationId = conversationId ?? selectedConversationIdRef.current;
      if (targetConversationId && (conversationId === undefined || targetConversationId === selectedConversationIdRef.current)) {
        settleDrafts(targetConversationId);
      }

      if (targetConversationId) {
        const liveState = getConversationLiveState(targetConversationId);
        liveState.lastStatus = '';
        liveState.openToolEventIDs = {};
        liveState.retryStatusEventID = null;
      }

      if (conversationId) {
        if (closeStream) {
          setSendingConversations((prev) => ({ ...prev, [conversationId]: false }));
        }
      } else if (closeStream) {
        setSendingConversations({});
      }
      if (!conversationId || conversationId === selectedConversationIdRef.current) {
        setCurrentStatus('');
      }

      if (closeStream && conversationId) {
        const stream = activeStreamsRef.current[conversationId];
        if (stream) {
          stream.dispose();
          delete activeStreamsRef.current[conversationId];
        }
      }
    },
    [getConversationLiveState, settleDrafts],
  );

  const clearConversationView = useCallback((): void => {
    setActivities([]);
    resetConversationLiveState(selectedConversationIdRef.current);
    setCurrentStatus('');
  }, [resetConversationLiveState]);

  const visibleActivities = useMemo(() => {
    if (!hideLifecycle) return activities;
    return activities.filter((a) => a.kind !== 'lifecycle');
  }, [activities, hideLifecycle]);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as {
        backendUrl?: string;
        selectedWorkspaceId?: string;
        selectedConversationId?: string;
        workspacePath?: string;
        hideLifecycle?: boolean;
        showMascot?: boolean;
        draftThinkingLevel?: ThinkingLevel;
        thinkingLevelsByConversation?: Record<string, unknown>;
        draftComposerModel?: ComposerModel;
        composerModelsByConversation?: Record<string, unknown>;
        sshTunnelConfig?: SshTunnelConfig;
      };

      if (parsed.backendUrl) {
        setBackendUrl(parsed.backendUrl);
      }
      if (parsed.selectedWorkspaceId) {
        setSelectedWorkspaceId(parsed.selectedWorkspaceId);
      }
      if (parsed.selectedConversationId) {
        setSelectedConversationId(parsed.selectedConversationId);
      }
      if (parsed.workspacePath) {
        setWorkspacePath(parsed.workspacePath);
      }
      if (typeof parsed.hideLifecycle === 'boolean') {
        setHideLifecycle(parsed.hideLifecycle);
      }
      if (typeof parsed.showMascot === 'boolean') {
        setShowMascot(parsed.showMascot);
      }
      if (parsed.draftThinkingLevel) {
        setDraftThinkingLevel(normalizeThinkingLevel(parsed.draftThinkingLevel));
      }
      if (parsed.thinkingLevelsByConversation && typeof parsed.thinkingLevelsByConversation === 'object') {
        const normalized: Record<string, ThinkingLevel> = {};
        for (const [conversationID, level] of Object.entries(parsed.thinkingLevelsByConversation)) {
          if (!conversationID) {
            continue;
          }
          normalized[conversationID] = normalizeThinkingLevel(level);
        }
        setThinkingLevelsByConversation(normalized);
      }
      if (parsed.draftComposerModel) {
        setDraftComposerModel(normalizeComposerModel(parsed.draftComposerModel));
      }
      if (parsed.composerModelsByConversation && typeof parsed.composerModelsByConversation === 'object') {
        const normalized: Record<string, ComposerModel> = {};
        for (const [conversationID, model] of Object.entries(parsed.composerModelsByConversation)) {
          if (!conversationID) {
            continue;
          }
          normalized[conversationID] = normalizeComposerModel(model);
        }
        setComposerModelsByConversation(normalized);
      }
      if (parsed.sshTunnelConfig) {
        setSshTunnelConfig((prev) => ({ ...prev, ...parsed.sshTunnelConfig }));
      }
    } catch {
      // Ignore invalid local storage state.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        backendUrl,
        selectedWorkspaceId,
        selectedConversationId,
        workspacePath,
        hideLifecycle,
        showMascot,
        draftThinkingLevel,
        thinkingLevelsByConversation,
        draftComposerModel,
        composerModelsByConversation,
        sshTunnelConfig,
      }),
    );
  }, [
    backendUrl,
    selectedWorkspaceId,
    selectedConversationId,
    workspacePath,
    hideLifecycle,
    showMascot,
    draftThinkingLevel,
    thinkingLevelsByConversation,
    draftComposerModel,
    composerModelsByConversation,
    sshTunnelConfig,
  ]);

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    setIsLoadingWorkspaces(true);
    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: '/workspaces',
      method: 'GET',
    });
    setIsLoadingWorkspaces(false);

    if (!response.ok) {
      pushNotice('error', `Unable to load workspaces: ${response.error ?? 'Unknown error'}`);
      return;
    }

    const rows = rowsFromUnknown(response.data);
    const parsed = rows
      .map((item) => parseWorkspace(item))
      .filter((item): item is WorkspaceSummary => item !== null);

    setWorkspaces(parsed);

    if (parsed.length === 0) {
      setSelectedWorkspaceId('');
      setConversationsByWorkspace({});
      setSelectedConversationId('');
      setThinkingLevelsByConversation({});
      setComposerModelsByConversation({});
      return;
    }

    setConversationsByWorkspace((prev) => {
      const next: Record<string, ConversationSummary[]> = {};
      for (const workspace of parsed) {
        if (prev[workspace.id]) {
          next[workspace.id] = prev[workspace.id];
        }
      }
      return next;
    });

    if (!parsed.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(parsed[0].id);
      setWorkspacePath(parsed[0].rootPath);
      setWorkspaceName(parsed[0].name);
    }
  }, [backendUrl, pushNotice, selectedWorkspaceId]);

  const refreshConversationsByWorkspace = useCallback(
    async (workspaceId: string, preserveEmpty = false): Promise<void> => {
      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/workspaces/${workspaceId}/conversations`,
        method: 'GET',
      });

      if (!response.ok) {
        pushActivity({
          kind: 'error',
          title: 'Unable to load conversations',
          body: response.error ?? 'Unknown error',
        });
        return;
      }

      const rows = rowsFromUnknown(response.data);
      const parsed = rows
        .map((item) => parseConversation(item))
        .filter((item): item is ConversationSummary => item !== null);
      const rootsOnly = parsed.filter((conversation) => !conversation.isThread).sort((a, b) => {
        const timeA = new Date(a.updatedAt).getTime();
        const timeB = new Date(b.updatedAt).getTime();
        return timeB - timeA;
      });

      setConversationsByWorkspace((prev) => ({ ...prev, [workspaceId]: rootsOnly }));

      // Restore active streams for any root conversation that is currently running
      for (const conv of rootsOnly) {
        if (!activeStreamsRef.current[conv.id]) {
          void (async () => {
            const active = await getActiveReplyStream({
              baseUrl: backendUrl,
              conversationId: conv.id,
            });
            if (active.ok && active.streamId && !activeStreamsRef.current[conv.id]) {
              const attached = attachReplyStream(active.streamId, (packet) => {
                handleStreamPacketRef.current?.(packet, conv.id);
              });
              activeStreamsRef.current[conv.id] = { ...attached, conversationId: conv.id };
              setSendingConversations((prev) => ({ ...prev, [conv.id]: true }));
            }
          })();
        }
      }

      const currentSelectedId = selectedConversationIdRef.current;

      if (preserveEmpty && currentSelectedId === '') {
        // Do nothing, keep it empty
      } else if (!rootsOnly.some((conversation) => conversation.id === currentSelectedId)) {
        setSelectedConversationId(rootsOnly[0]?.id ?? '');
      }
    },
    [backendUrl, pushActivity],
  );

  const refreshCheckpointsForConversation = useCallback(
    async (conversationId: string): Promise<CheckpointSummary[]> => {
      if (!conversationId) {
        return [];
      }
      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/conversations/${conversationId}/checkpoints?limit=60`,
        method: 'GET',
      });
      if (!response.ok) {
        return [];
      }

      const rows = rowsFromUnknown(response.data);
      const parsed = rows
        .map((item) => parseCheckpoint(item))
        .filter((item): item is CheckpointSummary => item !== null);

      setCheckpointsByConversation((prev) => ({ ...prev, [conversationId]: parsed }));
      return parsed;
    },
    [backendUrl],
  );

  const loadConversationHistory = useCallback(
    async (conversationId: string): Promise<void> => {
      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/conversations/${conversationId}/timeline`,
        method: 'GET',
      });

      if (!response.ok) {
        pushNotice('error', `Unable to load conversation history: ${response.error ?? 'Unknown error'}`);
        return;
      }

      const rows = rowsFromUnknown(response.data);
      if (rows.length === 0 && response.data && !Array.isArray(response.data)) {
        const payload = asRecord(response.data);
        const status = getString(payload, ['status']);
        const message = getString(payload, ['message']);
        if (status === 'success' && message.includes('Hello, world')) {
          const restartMsg = 'Conversation history endpoint not active on backend. Restart Loop API server to load history.';
          pushNotice('info', restartMsg);
          pushActivity({
            kind: 'error',
            title: 'History unavailable',
            body: restartMsg,
          });
          return;
        }
      }

      if (selectedConversationIdRef.current !== conversationId) {
        return;
      }
      const hasActiveStream = !!activeStreamsRef.current[conversationId];
      const isConversationSending = !!sendingConversationsRef.current[conversationId];
      if (rows.length === 0 && (hasActiveStream || isConversationSending)) {
        return;
      }

      setActivities(
        annotateActivitiesWithPendingApprovals(
          historyRowsToActivities(rows),
          pendingCommandApprovalsRef.current.filter((item) => item.conversationId === conversationId),
        ),
      );
      clearNotices();
      resetConversationLiveState(conversationId);
      setCurrentStatus('');
    },
    [backendUrl, clearNotices, pushActivity, pushNotice, resetConversationLiveState],
  );

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setSelectedConversationId('');
      return;
    }
    void refreshConversationsByWorkspace(selectedWorkspaceId, true);
  }, [refreshConversationsByWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedConversationId) {
      clearConversationView();
      return;
    }
    void loadConversationHistory(selectedConversationId);
  }, [clearConversationView, loadConversationHistory, selectedConversationId]);

  useEffect(() => {
    return () => {
      for (const key in activeStreamsRef.current) {
        const stream = activeStreamsRef.current[key];
        if (stream) {
          stream.dispose();
        }
      }
      activeStreamsRef.current = {};
      conversationLiveStateRef.current = {};
    };
  }, []);

  const pickFolder = useCallback(async (): Promise<void> => {
    const folder = await chooseFolder();
    if (!folder) {
      return;
    }

    setWorkspacePath(folder);
    if (!workspaceName.trim()) {
      setWorkspaceName(lastPathSegment(folder));
    }
  }, [workspaceName]);

  const createWorkspace = useCallback(async (): Promise<void> => {
    const trimmedPath = workspacePath.trim();
    if (!trimmedPath) {
      pushNotice('info', 'Select a workspace folder before creating the workspace.');
      return;
    }

    const id = `ws-${crypto.randomUUID()}`;
    const name = workspaceName.trim() || lastPathSegment(trimmedPath);

    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: '/workspaces',
      method: 'POST',
      body: {
        ID: id,
        Name: name,
        RootPath: trimmedPath,
        CanonicalRootPath: trimmedPath,
        PathGrants: [],
        ConversationRoots: [],
      },
    });

    if (!response.ok) {
      pushNotice('error', `Failed to create workspace: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    pushNotice('success', `Workspace "${name}" created.`);
    await refreshWorkspaces();
    setSelectedWorkspaceId(id);
  }, [backendUrl, pushNotice, refreshWorkspaces, workspaceName, workspacePath]);

  const pickAndCreateWorkspace = useCallback(async (): Promise<void> => {
    const folder = await chooseFolder();
    if (!folder) {
      return;
    }

    const id = `ws-${crypto.randomUUID()}`;
    const name = lastPathSegment(folder);

    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: '/workspaces',
      method: 'POST',
      body: {
        ID: id,
        Name: name,
        RootPath: folder,
        CanonicalRootPath: folder,
        PathGrants: [],
        ConversationRoots: [],
      },
    });

    if (!response.ok) {
      pushNotice('error', `Failed to create workspace: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    pushNotice('success', `Workspace "${name}" created.`);
    await refreshWorkspaces();
    setSelectedWorkspaceId(id);
  }, [backendUrl, pushNotice, refreshWorkspaces]);

  const deleteWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (!workspaceId) {
      return;
    }

    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: `/workspaces/${encodeURIComponent(workspaceId)}`,
      method: 'DELETE',
    });

    if (!response.ok) {
      pushNotice('error', `Failed to delete workspace: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    pushNotice('success', 'Workspace deleted.');

    // Clear selection if we just deleted it
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId('');
      setWorkspacePath('');
      setWorkspaceName('');
      setSelectedConversationId('');
      clearConversationView();
    }

    await refreshWorkspaces();
  }, [backendUrl, clearConversationView, pushNotice, refreshWorkspaces, selectedWorkspaceId]);

  const createConversation = useCallback(
    async (seedText: string): Promise<string | null> => {
      if (!selectedWorkspaceId) {
        pushNotice('info', 'Pick or create a workspace first.');
        return null;
      }

      const conversationId = `conv-${crypto.randomUUID()}`;
      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: '/conversations',
        method: 'POST',
        body: {
          ID: conversationId,
          WorkspaceID: selectedWorkspaceId,
          Title: buildConversationTitle(seedText),
        },
      });

      if (!response.ok) {
        pushNotice('error', `Failed to create conversation: ${stringifyResponseError(response.data, response.error)}`);
        return null;
      }

      await refreshConversationsByWorkspace(selectedWorkspaceId, true);
      return conversationId;
    },
    [backendUrl, pushNotice, refreshConversationsByWorkspace, selectedWorkspaceId],
  );

  const deleteConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (!selectedWorkspaceId) {
        return;
      }

      const targetConversation = conversations.find((conversation) => conversation.id === conversationId);
      const displayName = targetConversation?.title || shortID(conversationId);
      const confirmed = window.confirm(`Delete conversation "${displayName}"? This will also remove nested thread history.`);
      if (!confirmed) {
        return;
      }

      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/conversations/${conversationId}`,
        method: 'DELETE',
      });

      if (!response.ok) {
        pushNotice('error', `Failed to delete conversation: ${stringifyResponseError(response.data, response.error)}`);
        return;
      }

      const wasSelected = selectedConversationId === conversationId;
      if (wasSelected) {
        setSelectedConversationId('');
        clearConversationView();
      }

      setConversationsByWorkspace((prev) => ({
        ...prev,
        [selectedWorkspaceId]: (prev[selectedWorkspaceId] ?? []).filter((conversation) => conversation.id !== conversationId),
      }));
      setThinkingLevelsByConversation((prev) => {
        if (!(conversationId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
      setCheckpointsByConversation((prev) => {
        if (!(conversationId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
      setEditingMessageByConversation((prev) => {
        if (!(conversationId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
      pushNotice('success', `Deleted conversation "${displayName}".`);
      await refreshConversationsByWorkspace(selectedWorkspaceId, selectedConversationId === '' && !wasSelected);
    },
    [
      backendUrl,
      clearConversationView,
      conversations,
      pushNotice,
      refreshConversationsByWorkspace,
      selectedConversationId,
      selectedWorkspaceId,
    ],
  );

  const renameConversation = useCallback(
    async (conversationId: string, newTitle: string): Promise<void> => {
      const trimmedTitle = newTitle.trim();
      if (!selectedWorkspaceId || !trimmedTitle || !conversationId) {
        return;
      }

      const response = await requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/conversations/${conversationId}`,
        method: 'PATCH',
        body: { title: trimmedTitle },
      });

      if (!response.ok) {
        pushNotice('error', `Failed to rename conversation: ${stringifyResponseError(response.data, response.error)}`);
        return;
      }

      // Optimistic update
      setConversationsByWorkspace((prev) => ({
        ...prev,
        [selectedWorkspaceId]: (prev[selectedWorkspaceId] ?? []).map((conversation) =>
          conversation.id === conversationId ? { ...conversation, title: trimmedTitle } : conversation
        ),
      }));

      await refreshConversationsByWorkspace(selectedWorkspaceId, true);
    },
    [backendUrl, pushNotice, refreshConversationsByWorkspace, selectedWorkspaceId],
  );

  const ensureConversationId = useCallback(
    async (seedText: string): Promise<string | null> => {
      if (selectedConversationId) {
        return selectedConversationId;
      }

      const conversationId = await createConversation(seedText);
      if (!conversationId) {
        return null;
      }

      setSelectedConversationId(conversationId);
      return conversationId;
    },
    [createConversation, selectedConversationId],
  );

  const handleTurnEvent = useMemo(
    () =>
      createHandleTurnEvent({
        appendStreamingText,
        finalizeTurn,
        getConversationLiveState,
        mutateActivity,
        pushActivity,
        settleThoughtDraft,
        setCurrentStatus,
      }),
    [appendStreamingText, finalizeTurn, getConversationLiveState, mutateActivity, pushActivity, settleThoughtDraft, setCurrentStatus],
  );

  const handleStreamPacket = useMemo(
    () =>
      createHandleStreamPacket({
        enqueueCommandApproval,
        finalizeTurn,
        getActiveStreamId: (conversationId: string) => activeStreamsRef.current[conversationId]?.streamId,
        getConversationLiveState,
        handleTurnEvent,
        pushActivity,
        pushNotice,
        getSelectedConversationId: () => selectedConversationIdRef.current,
      }),
    [enqueueCommandApproval, finalizeTurn, getConversationLiveState, handleTurnEvent, pushActivity, pushNotice],
  );

  useEffect(() => {
    handleStreamPacketRef.current = handleStreamPacket;
  }, [handleStreamPacket]);

  const sendMessageText = useCallback(
    async (
      messageText: string,
      messageImages: ComposerImage[],
      clearComposer: boolean,
      forceSend = false,
      options?: { retryMessageId?: string; editMessageId?: string },
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
      const hasActiveSelectedStream = !!(selectedConversationId && activeStreamsRef.current[selectedConversationId]);
      const isSelectedConversationSending = !!(selectedConversationId && sendingConversations[selectedConversationId]);
      if (((!isBranch && !hasContent) || (isEdit && !hasContent)) || ((hasActiveSelectedStream || isSelectedConversationSending) && !forceSend)) {
        return;
      }
      const selectedComposerModel = normalizeComposerModel(composerModel);
      const selectedThinkingLevel = normalizeThinkingLevelForModel(thinkingLevel, selectedComposerModel);

      let conversationId = selectedConversationId;
      if (!isBranch) {
        const ensuredConversationId = await ensureConversationId(text);
        if (!ensuredConversationId) {
          return;
        }
        conversationId = ensuredConversationId;
      }
      if (!conversationId) {
        return;
      }
      setThinkingLevelsByConversation((prev) => ({
        ...prev,
        [conversationId]: selectedThinkingLevel,
      }));
      setComposerModelsByConversation((prev) => ({
        ...prev,
        [conversationId]: selectedComposerModel,
      }));

      clearNotices();
      setSendingConversations((prev) => ({ ...prev, [conversationId]: true }));
      resetConversationLiveState(conversationId);

      let userEventId: string | null = null;
      if (isBranch) {
        const anchorMessageId = isRetry ? retryMessageId : editMessageId;
        if (anchorMessageId) {
          setActivities((prev) => {
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
        userEventId = pushActivity({
          kind: 'user',
          title: 'User prompt',
          body: text || '(Images attached)',
          userTurn: {
            model: selectedComposerModel,
            thinkingLevel: selectedThinkingLevel,
          },
          images: messageImages.map((img) => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
        });
      }
      pushActivity({ kind: 'lifecycle', title: 'Turn started' });
      if (clearComposer) {
        setMessageInput('');
        setComposerImages([]);
      }
      if (isEdit) {
        setEditingMessageByConversation((prev) => {
          if (!(conversationId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
      }
      const requestedStreamID = crypto.randomUUID();
      activeStreamsRef.current[conversationId] = {
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
          handleStreamPacket(packet, conversationId);
        },
      ).catch((error: unknown) => {
        pushActivity({
          kind: 'error',
          title: 'Unable to start stream',
          body: error instanceof Error ? error.message : 'Unknown stream error',
        });
        finalizeTurn(true, conversationId);
        return null;
      });

      if (!stream) {
        return;
      }

      activeStreamsRef.current[conversationId] = {
        ...stream,
        conversationId,
      };

      if (!isBranch && userEventId) {
        // Attach the latest checkpoint to the just-sent user message row.
        void refreshCheckpointsForConversation(conversationId).then((checkpointsList) => {
          const latestCheckpoint = checkpointsList[0];
          if (!latestCheckpoint) {
            return;
          }
          mutateActivity(userEventId!, (event) => ({
            ...event,
            checkpointId: event.checkpointId || latestCheckpoint.id,
          }));
        });
      }
    },
    [
      backendUrl,
      clearNotices,
      composerModel,
      ensureConversationId,
      finalizeTurn,
      handleStreamPacket,
      mutateActivity,
      pushActivity,
      refreshCheckpointsForConversation,
      resetConversationLiveState,
      selectedConversationId,
      sendingConversations,
      setActivities,
      setComposerImages,
      setMessageInput,
      thinkingLevel,
    ],
  );

  const retryFromMessage = useCallback(async (messageId: string): Promise<void> => {
    const targetMessageId = messageId.trim();
    if (!targetMessageId || !selectedConversationId || isSending) {
      return;
    }
    setEditingMessageByConversation((prev) => {
      if (!(selectedConversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[selectedConversationId];
      return next;
    });
    await sendMessageText('', [], false, true, { retryMessageId: targetMessageId });
  }, [isSending, selectedConversationId, sendMessageText]);

  const editMessageInComposer = useCallback((messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]): void => {
    const targetMessageId = messageId.trim();
    if (!targetMessageId || !selectedConversationId) {
      return;
    }

    setEditingMessageByConversation((prev) => ({ ...prev, [selectedConversationId]: targetMessageId }));
    setMessageInput(text);
    setComposerImages(
      images.map((img) => ({
        id: crypto.randomUUID(),
        mimeType: img.mimeType,
        dataUrl: img.dataUrl,
        data: dataUrlToBase64(img.dataUrl),
      })),
    );
  }, [selectedConversationId, setComposerImages, setMessageInput]);

  const steerQueuedMessage = useCallback(async (id: string) => {
    if (!selectedConversationId) {
      return;
    }
    const msg = queuedMessagesMap[selectedConversationId]?.find((m) => m.id === id);
    if (!msg) return;

    removeQueuedMessage(id);

    const stream = activeStreamsRef.current[selectedConversationId];
    if (stream) {
      await stream.cancel();
      stream.dispose();
      delete activeStreamsRef.current[selectedConversationId];
      pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested for steering' });
    }

    setSendingConversations((prev) => ({ ...prev, [selectedConversationId]: false }));
    await sendMessageText(msg.text, msg.images, false, true);
  }, [queuedMessagesMap, selectedConversationId, removeQueuedMessage, pushActivity, sendMessageText]);

  const sendMessage = useCallback(async (): Promise<void> => {
    if (editingMessageId) {
      await sendMessageText(messageInput, composerImages, true, false, { editMessageId: editingMessageId });
      return;
    }
    await sendMessageText(messageInput, composerImages, true);
  }, [composerImages, editingMessageId, messageInput, sendMessageText]);

  useEffect(() => {
    if (!selectedConversationId || !editingMessageId) {
      return;
    }
    const exists = activities.some((event) => (event.messageId || event.id) === editingMessageId);
    if (exists) {
      return;
    }
    setEditingMessageByConversation((prev) => {
      if (!(selectedConversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[selectedConversationId];
      return next;
    });
  }, [activities, editingMessageId, selectedConversationId]);

  useEffect(() => {
    const hasActiveSelectedStream = !!(selectedConversationId && activeStreamsRef.current[selectedConversationId]);
    if (!isSending && !hasActiveSelectedStream && queuedMessages.length > 0 && selectedConversationId) {
      const nextMsg = queuedMessages[0];
      setQueuedMessagesMap(prevMap => {
        const prev = prevMap[selectedConversationId] || [];
        return { ...prevMap, [selectedConversationId]: prev.slice(1) };
      });
      void sendMessageText(nextMsg.text, nextMsg.images, false);
    }
  }, [isSending, queuedMessages, selectedConversationId, sendMessageText]);

  const applyToolResponseSuggestion = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setMessageInput(trimmed);
  }, [setMessageInput]);

  const sendToolResponseSuggestion = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const hasActiveSelectedStream = !!(selectedConversationId && activeStreamsRef.current[selectedConversationId]);
    const isSelectedConversationSending = !!(selectedConversationId && sendingConversations[selectedConversationId]);

    if (hasActiveSelectedStream || isSelectedConversationSending) {
      enqueueConversationMessage(selectedConversationId, trimmed, []);
      return;
    }

    await sendMessageText(trimmed, [], false);
  }, [enqueueConversationMessage, selectedConversationId, sendMessageText, sendingConversations]);

  const cancelStream = useCallback(async (): Promise<void> => {
    const stream = activeStreamsRef.current[selectedConversationId];
    if (!stream) {
      return;
    }

    await stream.cancel();
    pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested' });
  }, [pushActivity, selectedConversationId]);

  const createCheckpoint = useCallback(async (label?: string): Promise<void> => {
    if (!selectedConversationId) {
      return;
    }

    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: `/conversations/${encodeURIComponent(selectedConversationId)}/checkpoints`,
      method: 'POST',
      body: label?.trim() ? { label: label.trim() } : {},
    });

    if (!response.ok) {
      pushNotice('error', `Failed to create checkpoint: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    await refreshCheckpointsForConversation(selectedConversationId);
    pushNotice('success', 'Checkpoint created.');
  }, [backendUrl, pushNotice, refreshCheckpointsForConversation, selectedConversationId]);

  const restoreCheckpoint = useCallback(async (checkpointId: string): Promise<void> => {
    const checkpointID = checkpointId.trim();
    if (!selectedConversationId || !checkpointID || isRestoringCheckpoint || isSending) {
      return;
    }

    setIsRestoringCheckpoint(true);
    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: `/conversations/${encodeURIComponent(selectedConversationId)}/checkpoints/${encodeURIComponent(checkpointID)}/restore`,
      method: 'POST',
    });
    setIsRestoringCheckpoint(false);

    if (!response.ok) {
      pushNotice('error', `Failed to restore checkpoint: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    await Promise.all([
      loadConversationHistory(selectedConversationId),
      refreshCheckpointsForConversation(selectedConversationId),
    ]);
    pushNotice('success', 'Checkpoint restored.');
  }, [
    backendUrl,
    isRestoringCheckpoint,
    isSending,
    loadConversationHistory,
    pushNotice,
    refreshCheckpointsForConversation,
    selectedConversationId,
  ]);

  const undoLatestCheckpoint = useCallback(async (): Promise<void> => {
    if (!selectedConversationId || isRestoringCheckpoint || isSending) {
      return;
    }

    setIsRestoringCheckpoint(true);
    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: `/conversations/${encodeURIComponent(selectedConversationId)}/undo`,
      method: 'POST',
    });
    setIsRestoringCheckpoint(false);

    if (!response.ok) {
      pushNotice('error', `Failed to undo: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    await Promise.all([
      loadConversationHistory(selectedConversationId),
      refreshCheckpointsForConversation(selectedConversationId),
    ]);
    pushNotice('success', 'Undo completed.');
  }, [
    backendUrl,
    isRestoringCheckpoint,
    isSending,
    loadConversationHistory,
    pushNotice,
    refreshCheckpointsForConversation,
    selectedConversationId,
  ]);

  const resolveCommandApproval = useCallback(async (decision: CommandApprovalDecision, message?: string): Promise<void> => {
    if (!pendingCommandApproval || isResolvingCommandApproval) {
      return;
    }

    const trimmedMessage = (message || '').trim();
    setIsResolvingCommandApproval(true);
    const response = await requestJson<unknown>({
      baseUrl: backendUrl,
      endpointPath: `/command-approvals/${encodeURIComponent(pendingCommandApproval.id)}/decision`,
      method: 'POST',
      body: { decision, message: trimmedMessage },
    });
    setIsResolvingCommandApproval(false);

    if (!response.ok) {
      if (response.status === 404) {
        setPendingCommandApprovals((prev) => prev.filter((item) => item.id !== pendingCommandApproval.id));
        pushNotice('info', 'Command approval request expired.');
        return;
      }
      pushNotice('error', `Failed to resolve command approval: ${stringifyResponseError(response.data, response.error)}`);
      return;
    }

    setPendingCommandApprovals((prev) => prev.filter((item) => item.id !== pendingCommandApproval.id));
  }, [backendUrl, isResolvingCommandApproval, pendingCommandApproval, pushNotice]);

  const selectWorkspace = useCallback(
    (workspaceId: string): void => {
      setSelectedWorkspaceId(workspaceId);
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (workspace) {
        setWorkspacePath(workspace.rootPath);
        setWorkspaceName(workspace.name);
      }
      setSelectedConversationId('');
      clearConversationView();
    },
    [clearConversationView, workspaces],
  );

  const selectConversation = useCallback((conversationId: string): void => {
    setSelectedConversationId(conversationId);
  }, []);

  const newConversation = useCallback(async (): Promise<void> => {
    clearConversationView();
    setSelectedConversationId('');
    clearNotices();
  }, [clearConversationView, clearNotices]);

  const refreshConversations = useCallback(async (): Promise<void> => {
    if (!selectedWorkspaceId) {
      return;
    }
    await refreshConversationsByWorkspace(selectedWorkspaceId, true);
  }, [refreshConversationsByWorkspace, selectedWorkspaceId]);

  const refreshCheckpoints = useCallback(async (): Promise<void> => {
    if (!selectedConversationId) {
      return;
    }
    await refreshCheckpointsForConversation(selectedConversationId);
  }, [refreshCheckpointsForConversation, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId || activeStreamsRef.current[selectedConversationId]) {
      return;
    }

    let disposed = false;
    void (async () => {
      const active = await getActiveReplyStream({
        baseUrl: backendUrl,
        conversationId: selectedConversationId,
      });
      if (disposed || !active.ok || !active.streamId || activeStreamsRef.current[selectedConversationId]) {
        return;
      }

      const attached = attachReplyStream(active.streamId, (packet) => {
        handleStreamPacket(packet, selectedConversationId);
      });

      activeStreamsRef.current[selectedConversationId] = {
        ...attached,
        conversationId: selectedConversationId,
      };
      setSendingConversations((prev) => ({ ...prev, [selectedConversationId]: true }));
      pushActivity({
        kind: 'lifecycle',
        title: 'Reconnected to active run',
        body: `stream ${shortID(active.streamId)}`,
      });
    })();

    return () => {
      disposed = true;
    };
  }, [backendUrl, handleStreamPacket, pushActivity, selectedConversationId]);

  useEffect(() => {
    if (!window.loopDesktop?.isElectron) {
      return;
    }

    const unsubscribe = window.loopDesktop.sshTunnel.onStatusChange((status) => {
      setSshTunnelStatus(status.status as SshTunnelStatus);
      setSshTunnelError(status.error);

      if (status.status === 'connected' && status.localPort) {
        setBackendUrl(`http://localhost:${status.localPort}`);
        pushNotice('success', 'SSH tunnel connected. Workspaces resynced.');
      } else if (status.status === 'disconnected' || status.status === 'error') {
        setBackendUrl('http://localhost:8080');
        if (status.status === 'error' && status.error) {
          pushNotice('error', `SSH tunnel error: ${status.error}`);
        }
      }
    });

    // Check initial status
    void window.loopDesktop.sshTunnel.status().then((status) => {
      setSshTunnelStatus(status.status as SshTunnelStatus);
      setSshTunnelError(status.error);
      if (status.status === 'connected' && status.localPort) {
        setBackendUrl(`http://localhost:${status.localPort}`);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [pushNotice]);

  const connectTunnel = useCallback(async (config: SshTunnelConfig): Promise<void> => {
    if (!window.loopDesktop?.isElectron) return;
    const res = await window.loopDesktop.sshTunnel.connect(config);
    if (!res.ok) {
      pushNotice('error', `Tunnel connection failed: ${res.error}`);
    }
  }, [pushNotice]);

  const disconnectTunnel = useCallback(async (): Promise<void> => {
    if (!window.loopDesktop?.isElectron) return;
    await window.loopDesktop.sshTunnel.disconnect();
  }, []);

  return {
    backendUrl,
    setBackendUrl,

    sshTunnelConfig,
    setSshTunnelConfig,
    sshTunnelStatus,
    sshTunnelError,
    connectTunnel,
    disconnectTunnel,

    workspaces,
    selectedWorkspaceId,
    selectedWorkspace,
    workspacePath,
    setWorkspacePath,
    workspaceName,
    setWorkspaceName,
    isLoadingWorkspaces,

    conversations,
    conversationsByWorkspace,
    selectedConversationId,
    selectedConversation,
    checkpoints,

    activities: visibleActivities,
    feedScrollRef,

    queuedMessages,
    queueMessage,
    removeQueuedMessage,
    reorderQueuedMessage,
    steerQueuedMessage,
    messageInput,
    setMessageInput,
    composerImages,
    setComposerImages,
    canCompose: selectedWorkspaceId !== '',
    isSending,
    sendingConversations,
    notices,
    pendingCommandApproval,
    pendingCommandApprovalCount: pendingApprovalsForSelectedConversation.length,
    isResolvingCommandApproval,
    isRestoringCheckpoint,
    dismissNotice,
    resolveCommandApproval,
    hideLifecycle,
    setHideLifecycle,
    showMascot,
    setShowMascot,
    thinkingLevel,
    setThinkingLevel,
    composerModel,
    setComposerModel,
    currentStatus,
    setCurrentStatus,

    refreshWorkspaces,
    refreshConversations,
    refreshCheckpoints,
    pickFolder,
    createWorkspace,
    pickAndCreateWorkspace,
    deleteWorkspace,
    selectWorkspace,
    selectConversation,
    newConversation,
    deleteConversation,
    renameConversation,

    sendMessage,
    cancelStream,
    createCheckpoint,
    restoreCheckpoint,
    undoLatestCheckpoint,
    applyToolResponseSuggestion,
    sendToolResponseSuggestion,
    retryFromMessage,
    editMessageInComposer,
  };
}
