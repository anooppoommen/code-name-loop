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

export type NoticeTone = 'success' | 'error' | 'info';

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

  messageInput: string;
  setMessageInput: (value: string) => void;
  canCompose: boolean;
  isSending: boolean;
  notices: NoticeToast[];
  hideLifecycle: boolean;
  setHideLifecycle: (value: boolean) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (value: ThinkingLevel) => void;

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

  const [messageInput, setMessageInput] = useState('');
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);
  const [sendingConversations, setSendingConversations] = useState<Record<string, boolean>>({});
  const isSending = !!sendingConversations[selectedConversationId];
  const [notices, setNotices] = useState<NoticeToast[]>([]);

  const activeStreamsRef = useRef<Record<string, StreamHandle>>({});
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const draftAssistantIdRef = useRef<string | null>(null);
  const draftThoughtIdRef = useRef<string | null>(null);
  const lastStatusRef = useRef('');
  const openToolEventIDsRef = useRef<Record<string, string>>({});
  const selectedConversationIdRef = useRef('');

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
    (kind: 'assistant' | 'thought', text: string): void => {
      if (!text) {
        return;
      }

      const ref = kind === 'assistant' ? draftAssistantIdRef : draftThoughtIdRef;
      const existing = ref.current;
      if (!existing) {
        ref.current = pushActivity({
          kind,
          title: kind === 'assistant' ? 'Assistant response' : 'Model thought',
          body: text,
          streaming: true,
        });
        return;
      }

      mutateActivity(existing, (event) => ({
        ...event,
        body: `${event.body ?? ''}${text}`,
        streaming: true,
      }));
    },
    [mutateActivity, pushActivity],
  );

  const settleDrafts = useCallback((): void => {
    const draftIDs = [draftAssistantIdRef.current, draftThoughtIdRef.current].filter(
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

    draftAssistantIdRef.current = null;
    draftThoughtIdRef.current = null;
  }, []);

  const settleThoughtDraft = useCallback((): void => {
    const draftID = draftThoughtIdRef.current;
    if (!draftID) {
      return;
    }

    mutateActivity(draftID, (event) => ({ ...event, streaming: false }));
    draftThoughtIdRef.current = null;
  }, [mutateActivity]);

  const finalizeTurn = useCallback(
    (closeStream: boolean, conversationId?: string): void => {
      if (!conversationId || conversationId === selectedConversationIdRef.current) {
        settleDrafts();
      }

      if (conversationId) {
        setSendingConversations((prev) => ({ ...prev, [conversationId]: false }));
      } else {
        setSendingConversations({});
      }

      if (closeStream && conversationId) {
        const stream = activeStreamsRef.current[conversationId];
        if (stream) {
          stream.dispose();
          delete activeStreamsRef.current[conversationId];
        }
      }
    },
    [settleDrafts],
  );

  const clearConversationView = useCallback((): void => {
    setActivities([]);
    draftAssistantIdRef.current = null;
    draftThoughtIdRef.current = null;
    openToolEventIDsRef.current = {};
  }, []);

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
      lastStatusRef.current = '';
      draftAssistantIdRef.current = null;
      draftThoughtIdRef.current = null;
      openToolEventIDsRef.current = {};
    },
    [backendUrl, clearNotices, pushActivity, pushNotice],
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

      if (kind === 'status') {
        const statusText = getString(asRecord(getField(eventRecord, ['status'])), ['text']);
        if (!statusText) {
          return;
        }
        if (statusText === lastStatusRef.current) {
          return;
        }
        lastStatusRef.current = statusText;

        const parsed = parseStatusLine(statusText);
        if (parsed?.kind === 'lifecycle' && parsed.title.startsWith('Executing ')) {
          // Match history grouping: once tool execution begins, next thought chunk starts a new row.
          settleThoughtDraft();
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

        appendStreamingText(isThought ? 'thought' : 'assistant', text);
        return;
      }

      if (kind === 'tool_call_start') {
        // Start a fresh thought segment after this tool boundary.
        settleThoughtDraft();

        const toolCall = asRecord(getField(eventRecord, ['tool_call']));
        const toolName = getString(toolCall, ['name']) || 'unknown tool';
        const callID = getString(toolCall, ['call_id']);
        const args = getString(toolCall, ['args']);
        const command = parseToolCommand(toolName, args);
        const eventID = pushActivity({
          kind: 'tool',
          title: 'Tool call started',
          body: command || args || undefined,
          tool: {
            name: toolName,
            phase: 'start',
            callId: callID || undefined,
            command: command || undefined,
          },
        });
        if (callID) {
          openToolEventIDsRef.current[callID] = eventID;
        }
        return;
      }

      if (kind === 'tool_result') {
        // Defensive split for streams that may emit result without a prior start event.
        settleThoughtDraft();

        const toolResult = asRecord(getField(eventRecord, ['tool_result']));
        const toolName = getString(toolResult, ['name']) || 'unknown tool';
        const success = getBoolean(toolResult, ['success']);
        const resultText = getString(toolResult, ['result']);
        const errorText = getString(toolResult, ['error']);
        const callID = getString(toolResult, ['call_id']);
        const summary = summarizeToolBody(toolName, resultText, errorText);
        const parsedPayload = parseToolResultPayload(resultText);
        const openEventID = callID ? openToolEventIDsRef.current[callID] : '';

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
              payload: parsedPayload,
            },
            streaming: false,
          }));
          delete openToolEventIDsRef.current[callID];
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

        const draftID = draftAssistantIdRef.current;
        if (!draftID) {
          draftAssistantIdRef.current = pushActivity({
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
        openToolEventIDsRef.current = {};
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
        openToolEventIDsRef.current = {};
        finalizeTurn(false, conversationId);
        return;
      }

      if (kind === 'turn_complete') {
        openToolEventIDsRef.current = {};
        finalizeTurn(false, conversationId);
        return;
      }

      pushActivity({ kind: 'status', title: `Event: ${kind}` });
    },
    [appendStreamingText, finalizeTurn, mutateActivity, pushActivity, settleThoughtDraft],
  );

  const handleStreamPacket = useCallback(
    (packet: LoopStreamPacket, conversationId: string): void => {
      const stream = activeStreamsRef.current[conversationId];
      if (!stream || packet.streamId !== stream.streamId) {
        return;
      }

      const isViewingStreamConversation = conversationId === selectedConversationIdRef.current;

      if (packet.type === 'event') {
        if (!isViewingStreamConversation) {
          return;
        }
        handleTurnEvent(packet.eventName ?? 'message', packet.data, conversationId);
        return;
      }

      if (packet.type === 'error') {
        if (isViewingStreamConversation) {
          pushActivity({ kind: 'error', title: 'Stream transport error', body: packet.error ?? '' });
        }
        openToolEventIDsRef.current = {};
        finalizeTurn(true, conversationId);
        return;
      }

      if (packet.type === 'aborted') {
        if (isViewingStreamConversation && packet.error) {
          pushActivity({ kind: 'lifecycle', title: 'Turn canceled', body: packet.error });
        }
        openToolEventIDsRef.current = {};
        finalizeTurn(true, conversationId);
        return;
      }

      if (packet.type === 'done') {
        openToolEventIDsRef.current = {};
        finalizeTurn(true, conversationId);
      }
    },
    [finalizeTurn, handleTurnEvent, pushActivity],
  );

  const sendMessageText = useCallback(
    async (messageText: string, clearComposer: boolean): Promise<void> => {
      const text = messageText.trim();
      if (!text || (selectedConversationId && sendingConversations[selectedConversationId])) {
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
      lastStatusRef.current = '';
      draftAssistantIdRef.current = null;
      draftThoughtIdRef.current = null;
      openToolEventIDsRef.current = {};

      pushActivity({ kind: 'user', title: 'User prompt', body: text });
      pushActivity({ kind: 'lifecycle', title: 'Turn started' });
      if (clearComposer) {
        setMessageInput('');
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
      selectedConversationId,
      sendingConversations,
      thinkingLevel,
    ],
  );

  const sendMessage = useCallback(async (): Promise<void> => {
    await sendMessageText(messageInput, true);
  }, [messageInput, sendMessageText]);

  const applyToolResponseSuggestion = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setMessageInput(trimmed);
  }, []);

  const sendToolResponseSuggestion = useCallback(async (text: string): Promise<void> => {
    if (!text.trim()) {
      return;
    }
    await sendMessageText(text, false);
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

    messageInput,
    setMessageInput,
    canCompose: selectedWorkspaceId !== '',
    isSending,
    notices,
    dismissNotice,
    hideLifecycle,
    setHideLifecycle,
    thinkingLevel,
    setThinkingLevel,

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
