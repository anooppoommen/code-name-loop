import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LoopStreamPacket } from '../electron';
import { attachReplyStream, chooseFolder, getActiveReplyStream, openReplyStream, requestJson } from '../lib/loopClient';
import type { ActivityEvent, ConversationSummary, ThinkingLevel, WorkspaceSummary } from '../types/ui';
import {
  type ActivityInput,
  historyRowsToActivities,
  parseToolCommand,
  parseStatusLine,
  summarizeToolBody,
} from '../utils/activityTimeline';
import {
  asRecord,
  buildConversationTitle,
  extractMessageText,
  getBoolean,
  getField,
  getString,
  lastPathSegment,
  parseConversation,
  parseToolResultPayload,
  parseWorkspace,
  shortID,
  stringifyResponseError,
} from '../utils/parsers';

const STORAGE_KEY = 'loop-desktop-settings-v3';
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
const TERMINAL_TURN_KINDS = new Set(['turn_complete', 'turn_aborted', 'error']);

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value !== 'string') {
    return DEFAULT_THINKING_LEVEL;
  }
  const normalized = value.trim().toLowerCase();
  if (THINKING_LEVELS.includes(normalized as ThinkingLevel)) {
    return normalized as ThinkingLevel;
  }
  return DEFAULT_THINKING_LEVEL;
}

function rowsFromUnknown(payload: unknown): unknown[] {
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

interface StreamHandle {
  streamId: string;
  conversationId: string;
  cancel: () => Promise<void>;
  dispose: () => void;
}

interface ConversationLiveState {
  draftAssistantId: string | null;
  draftThoughtId: string | null;
  lastStatus: string;
  openToolEventIDs: Record<string, string>;
}

export type NoticeTone = 'success' | 'error' | 'info';

export interface QueuedMessage {
  id: string;
  text: string;
  images: ComposerImage[];
}

export interface ComposerImage {
  id: string;
  data: string;
  mimeType: string;
  dataUrl: string;
}

export interface NoticeToast {
  id: string;
  tone: NoticeTone;
  message: string;
}

export interface LoopDesktopController {
  backendUrl: string;
  setBackendUrl: (value: string) => void;

  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  selectedWorkspace: WorkspaceSummary | null;
  workspacePath: string;
  setWorkspacePath: (value: string) => void;
  workspaceName: string;
  setWorkspaceName: (value: string) => void;
  isLoadingWorkspaces: boolean;

  conversations: ConversationSummary[];
  selectedConversationId: string;
  selectedConversation: ConversationSummary | null;

  activities: ActivityEvent[];
  feedScrollRef: RefObject<HTMLDivElement | null>;

  queuedMessages: QueuedMessage[];
  queueMessage: () => void;
  removeQueuedMessage: (id: string) => void;
  reorderQueuedMessage: (id: string, direction: 'up' | 'down') => void;
  steerQueuedMessage: (id: string) => Promise<void>;
  messageInput: string;
  setMessageInput: (value: string) => void;
  composerImages: ComposerImage[];
  setComposerImages: React.Dispatch<React.SetStateAction<ComposerImage[]>>;
  canCompose: boolean;
  isSending: boolean;
  sendingConversations: Record<string, boolean>;
  notices: NoticeToast[];
  hideLifecycle: boolean;
  setHideLifecycle: (value: boolean) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (value: ThinkingLevel) => void;
  currentStatus: string;
  setCurrentStatus: (value: string) => void;

  dismissNotice: (id: string) => void;

  refreshWorkspaces: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  pickFolder: () => Promise<void>;
  createWorkspace: () => Promise<void>;
  pickAndCreateWorkspace: () => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  selectConversation: (conversationId: string) => void;
  newConversation: () => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;

  sendMessage: () => Promise<void>;
  cancelStream: () => Promise<void>;
  applyToolResponseSuggestion: (text: string) => void;
  sendToolResponseSuggestion: (text: string) => Promise<void>;
}

export function useLoopDesktop(): LoopDesktopController {
  const [backendUrl, setBackendUrl] = useState('http://localhost:8080');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');

  const [hideLifecycle, setHideLifecycle] = useState(true);
  const [draftThinkingLevel, setDraftThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [thinkingLevelsByConversation, setThinkingLevelsByConversation] = useState<Record<string, ThinkingLevel>>({});
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');

  const [activities, setActivities] = useState<ActivityEvent[]>([]);

  const [composerInputs, setComposerInputs] = useState<Record<string, string>>({});
  const [composerImagesMap, setComposerImagesMap] = useState<Record<string, ComposerImage[]>>({});
  const [queuedMessagesMap, setQueuedMessagesMap] = useState<Record<string, QueuedMessage[]>>({});

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

  const queueMessage = useCallback(() => {
    const text = messageInput.trim();
    if (!text && composerImages.length === 0) return;
    setQueuedMessagesMap(prevMap => {
      const prev = prevMap[selectedConversationId] || [];
      return {
        ...prevMap,
        [selectedConversationId]: [...prev, { id: crypto.randomUUID(), text, images: composerImages }]
      };
    });
    setMessageInput('');
    setComposerImages([]);
  }, [messageInput, composerImages, selectedConversationId, setMessageInput, setComposerImages]);

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

  const activeStreamsRef = useRef<Record<string, StreamHandle>>({});
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationLiveStateRef = useRef<Record<string, ConversationLiveState>>({});
  const handleStreamPacketRef = useRef<((packet: LoopStreamPacket, conversationId: string) => void) | null>(null);
  const selectedConversationIdRef = useRef('');

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
    };
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  const thinkingLevel = useMemo<ThinkingLevel>(() => {
    if (!selectedConversationId) {
      return draftThinkingLevel;
    }
    return thinkingLevelsByConversation[selectedConversationId] ?? DEFAULT_THINKING_LEVEL;
  }, [draftThinkingLevel, selectedConversationId, thinkingLevelsByConversation]);

  const setThinkingLevel = useCallback(
    (value: ThinkingLevel): void => {
      const normalized = normalizeThinkingLevel(value);
      if (!selectedConversationId) {
        setDraftThinkingLevel(normalized);
        return;
      }
      setThinkingLevelsByConversation((prev) => ({
        ...prev,
        [selectedConversationId]: normalized,
      }));
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

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  const pushActivity = useCallback((input: ActivityInput): string => {
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
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
        draftThinkingLevel?: ThinkingLevel;
        thinkingLevelsByConversation?: Record<string, unknown>;
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
        draftThinkingLevel,
        thinkingLevelsByConversation,
      }),
    );
  }, [
    backendUrl,
    selectedWorkspaceId,
    selectedConversationId,
    workspacePath,
    hideLifecycle,
    draftThinkingLevel,
    thinkingLevelsByConversation,
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
      setConversations([]);
      setSelectedConversationId('');
      setThinkingLevelsByConversation({});
      return;
    }

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

      setConversations(rootsOnly);

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

      setActivities(historyRowsToActivities(rows));
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
      setConversations([]);
      setSelectedConversationId('');
      return;
    }
    void refreshConversationsByWorkspace(selectedWorkspaceId);
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

      setConversations((prev) => prev.filter((conversation) => conversation.id !== conversationId));
      setThinkingLevelsByConversation((prev) => {
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
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, title: trimmedTitle } : conversation
        )
      );

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

  const handleTurnEvent = useCallback(
    (eventName: string, data: unknown, conversationId: string): void => {
      const eventRecord = asRecord(data);
      const kind = getString(eventRecord, ['kind']) || eventName;
      const liveState = getConversationLiveState(conversationId);

      if (kind === 'status') {
        const statusText = getString(asRecord(getField(eventRecord, ['status'])), ['text']);
        if (!statusText) {
          return;
        }
        if (statusText === liveState.lastStatus) {
          return;
        }
        liveState.lastStatus = statusText;
        setCurrentStatus(statusText);

        const parsed = parseStatusLine(statusText);
        if (parsed?.kind === 'lifecycle' && parsed.title.startsWith('Executing ')) {
          // Match history grouping: once tool execution begins, next thought chunk starts a new row.
          settleThoughtDraft(conversationId);
        }
        if (parsed && parsed.kind !== 'tool') {
          pushActivity(parsed);
        }
        return;
      }

      if (kind === 'delta') {
        const deltaRecord = asRecord(getField(eventRecord, ['delta']));
        const text = getString(deltaRecord, ['text']);
        const isThought = getBoolean(deltaRecord, ['is_thought']);
        if (!text) {
          return;
        }

        appendStreamingText(conversationId, isThought ? 'thought' : 'assistant', text);
        return;
      }

      if (kind === 'tool_call_start') {
        // Start a fresh thought segment after this tool boundary.
        settleThoughtDraft(conversationId);

        const toolCall = asRecord(getField(eventRecord, ['tool_call']));
        const toolName = getString(toolCall, ['name']) || 'unknown tool';
        const callID = getString(toolCall, ['call_id']);
        const args = getString(toolCall, ['args']);
        const command = parseToolCommand(toolName, args);
        const parsedArgs = parseToolResultPayload(args);
        const eventID = pushActivity({
          kind: 'tool',
          title: 'Tool call started',
          body: command || args || undefined,
          tool: {
            name: toolName,
            phase: 'start',
            callId: callID || undefined,
            command: command || undefined,
            args: parsedArgs,
          },
        });
        if (callID) {
          liveState.openToolEventIDs[callID] = eventID;
        }
        return;
      }

      if (kind === 'tool_result') {
        // Defensive split for streams that may emit result without a prior start event.
        settleThoughtDraft(conversationId);

        const toolResult = asRecord(getField(eventRecord, ['tool_result']));
        const toolName = getString(toolResult, ['name']) || 'unknown tool';
        const success = getBoolean(toolResult, ['success']);
        const resultText = getString(toolResult, ['result']);
        const errorText = getString(toolResult, ['error']);
        const argsText = getString(toolResult, ['args']);
        const callID = getString(toolResult, ['call_id']);
        const summary = summarizeToolBody(toolName, resultText, errorText);
        const parsedPayload = parseToolResultPayload(resultText);
        const parsedArgs = parseToolResultPayload(argsText);
        const openEventID = callID ? liveState.openToolEventIDs[callID] : '';

        if (openEventID) {
          mutateActivity(openEventID, (event) => ({
            ...event,
            title: success
              ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}`
              : `${toolName} failed`,
            body: summary.body || undefined,
            tool: {
              ...(event.tool ?? { name: toolName, phase: 'start' as const }),
              name: toolName,
              phase: 'result',
              callId: callID || undefined,
              success,
              resultSummary: summary.title,
              error: errorText || undefined,
              args: event.tool?.args ?? parsedArgs,
              payload: parsedPayload,
            },
            streaming: false,
          }));
          delete liveState.openToolEventIDs[callID];
        } else {
          pushActivity({
            kind: 'tool',
            title: success
              ? `${toolName} completed${summary.title ? ` (${summary.title})` : ''}`
              : `${toolName} failed`,
            body: summary.body || undefined,
            tool: {
              name: toolName,
              phase: 'result',
              callId: callID || undefined,
              success,
              resultSummary: summary.title,
              error: errorText || undefined,
              args: parsedArgs,
              payload: parsedPayload,
            },
          });
        }

        const parsedResult = parseToolResultPayload(resultText);
        if (toolName === 'spawn_thread' && parsedResult) {
          const threadID = getString(parsedResult, ['thread_id']);
          if (threadID) {
            const anchorID = getString(parsedResult, ['anchor_message_id']);
            const mode = getString(parsedResult, ['mode']);
            pushActivity({
              kind: 'thread',
              title: `Thread spawned: ${shortID(threadID)}${mode ? ` (${mode})` : ''}`,
              body: anchorID ? `anchor ${shortID(anchorID)}` : undefined,
            });
          }
        }

        if (toolName === 'await_thread' && parsedResult) {
          const threadID = getString(parsedResult, ['thread_id']);
          const status = getString(parsedResult, ['status']);
          if (threadID) {
            pushActivity({
              kind: 'thread',
              title: `Thread awaited: ${shortID(threadID)}`,
              body: status ? `Status: ${status}` : undefined,
            });
          }
        }
        return;
      }

      if (kind === 'message_done') {
        const messageRecord = getField(eventRecord, ['message']);
        const messageText = extractMessageText(messageRecord);
        if (!messageText) {
          return;
        }

        const draftID = liveState.draftAssistantId;
        if (!draftID) {
          liveState.draftAssistantId = pushActivity({
            kind: 'assistant',
            title: 'Assistant response',
            body: messageText,
            streaming: true,
          });
          return;
        }

        mutateActivity(draftID, (event) => ({ ...event, body: messageText, streaming: true }));
        return;
      }

      if (kind === 'error') {
        const errorText = getString(eventRecord, ['error']) || 'Agent returned an error event.';
        pushActivity({ kind: 'error', title: 'Model execution error', body: errorText });
        liveState.openToolEventIDs = {};
        finalizeTurn(false, conversationId);
        return;
      }

      if (kind === 'turn_started') {
        return;
      }

      if (kind === 'turn_aborted') {
        pushActivity({
          kind: 'lifecycle',
          title: 'Turn aborted',
          body: getString(eventRecord, ['error']) || undefined,
        });
        liveState.openToolEventIDs = {};
        finalizeTurn(false, conversationId);
        return;
      }

      if (kind === 'turn_complete') {
        liveState.openToolEventIDs = {};
        finalizeTurn(false, conversationId);
        return;
      }

      pushActivity({ kind: 'status', title: `Event: ${kind}` });
    },
    [appendStreamingText, finalizeTurn, getConversationLiveState, mutateActivity, pushActivity, settleThoughtDraft],
  );

  const handleStreamPacket = useCallback(
    (packet: LoopStreamPacket, conversationId: string): void => {
      const stream = activeStreamsRef.current[conversationId];
      if (!stream || packet.streamId !== stream.streamId) {
        return;
      }

      const isViewingStreamConversation = conversationId === selectedConversationIdRef.current;

      if (packet.type === 'event') {
        const eventRecord = asRecord(packet.data);
        const kind = getString(eventRecord, ['kind']) || packet.eventName || 'message';
        if (!isViewingStreamConversation) {
          // We intentionally skip rendering background activity to avoid mixing
          // timeline rows across conversations, but terminal events must still
          // close background stream state.
          if (TERMINAL_TURN_KINDS.has(kind)) {
            const liveState = getConversationLiveState(conversationId);
            liveState.openToolEventIDs = {};
            finalizeTurn(true, conversationId);
            console.debug(
              `[loop-stream] finalized background conversation=${shortID(conversationId)} kind=${kind}`,
            );
          }
          return;
        }
        handleTurnEvent(packet.eventName ?? 'message', packet.data, conversationId);
        return;
      }

      if (packet.type === 'error') {
        if (isViewingStreamConversation) {
          pushActivity({ kind: 'error', title: 'Stream transport error', body: packet.error ?? '' });
        }
        const liveState = getConversationLiveState(conversationId);
        liveState.openToolEventIDs = {};
        finalizeTurn(true, conversationId);
        return;
      }

      if (packet.type === 'aborted') {
        if (isViewingStreamConversation && packet.error) {
          pushActivity({ kind: 'lifecycle', title: 'Turn canceled', body: packet.error });
        }
        const liveState = getConversationLiveState(conversationId);
        liveState.openToolEventIDs = {};
        finalizeTurn(true, conversationId);
        return;
      }

      if (packet.type === 'done') {
        const liveState = getConversationLiveState(conversationId);
        liveState.openToolEventIDs = {};
        finalizeTurn(true, conversationId);
      }
    },
    [finalizeTurn, getConversationLiveState, handleTurnEvent, pushActivity],
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
    ): Promise<void> => {
      const text = messageText.trim();
      const hasActiveSelectedStream = !!(selectedConversationId && activeStreamsRef.current[selectedConversationId]);
      const isSelectedConversationSending = !!(selectedConversationId && sendingConversations[selectedConversationId]);
      if ((!text && messageImages.length === 0) || ((hasActiveSelectedStream || isSelectedConversationSending) && !forceSend)) {
        return;
      }
      const selectedThinkingLevel = normalizeThinkingLevel(thinkingLevel);

      const conversationId = await ensureConversationId(text);
      if (!conversationId) {
        return;
      }
      setThinkingLevelsByConversation((prev) => ({
        ...prev,
        [conversationId]: selectedThinkingLevel,
      }));

      clearNotices();
      setSendingConversations((prev) => ({ ...prev, [conversationId]: true }));
      resetConversationLiveState(conversationId);

      pushActivity({ 
        kind: 'user', 
        title: 'User prompt', 
        body: text || '(Images attached)',
        images: messageImages.map(img => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
      });
      pushActivity({ kind: 'lifecycle', title: 'Turn started' });
      if (clearComposer) {
        setMessageInput('');
        setComposerImages([]);
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
          thinkingLevel: selectedThinkingLevel,
          images: messageImages.length > 0 ? messageImages.map(img => ({
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
    },
    [
      backendUrl,
      clearNotices,
      ensureConversationId,
      finalizeTurn,
      handleStreamPacket,
      pushActivity,
      resetConversationLiveState,
      selectedConversationId,
      sendingConversations,
      thinkingLevel,
      setComposerImages,
      setMessageInput,
    ],
  );

  const steerQueuedMessage = useCallback(async (id: string) => {
    if (!selectedConversationId) {
      return;
    }
    const msg = queuedMessagesMap[selectedConversationId]?.find(m => m.id === id);
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
    await sendMessageText(messageInput, composerImages, true);
  }, [messageInput, composerImages, sendMessageText]);

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
    if (!text.trim()) {
      return;
    }
    await sendMessageText(text, [], false);
  }, [sendMessageText]);

  const cancelStream = useCallback(async (): Promise<void> => {
    const stream = activeStreamsRef.current[selectedConversationId];
    if (!stream) {
      return;
    }

    await stream.cancel();
    pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested' });
  }, [pushActivity, selectedConversationId]);

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

  return {
    backendUrl,
    setBackendUrl,

    workspaces,
    selectedWorkspaceId,
    selectedWorkspace,
    workspacePath,
    setWorkspacePath,
    workspaceName,
    setWorkspaceName,
    isLoadingWorkspaces,

    conversations,
    selectedConversationId,
    selectedConversation,

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
    dismissNotice,
    hideLifecycle,
    setHideLifecycle,
    thinkingLevel,
    setThinkingLevel,
    currentStatus,
    setCurrentStatus,

    refreshWorkspaces,
    refreshConversations,
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
    applyToolResponseSuggestion,
    sendToolResponseSuggestion,
  };
}
