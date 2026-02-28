import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LoopStreamPacket } from '../electron';
import { attachReplyStream, chooseFolder, getActiveReplyStream, openReplyStream, requestJson } from '../lib/loopClient';
import type { ActivityEvent, ConversationSummary, WorkspaceSummary } from '../types/ui';
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
}

export function useLoopDesktop(): LoopDesktopController {
  const [backendUrl, setBackendUrl] = useState('http://localhost:8080');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');

  const [activities, setActivities] = useState<ActivityEvent[]>([]);

  const [messageInput, setMessageInput] = useState('');
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [notices, setNotices] = useState<NoticeToast[]>([]);

  const streamRef = useRef<StreamHandle | null>(null);
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

  const finalizeTurn = useCallback(
    (closeStream: boolean): void => {
      settleDrafts();
      setIsSending(false);

      if (closeStream && streamRef.current) {
        streamRef.current.dispose();
        streamRef.current = null;
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
      }),
    );
  }, [backendUrl, selectedWorkspaceId, selectedConversationId, workspacePath]);

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
      return;
    }

    if (!parsed.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(parsed[0].id);
      setWorkspacePath(parsed[0].rootPath);
      setWorkspaceName(parsed[0].name);
    }
  }, [backendUrl, pushNotice, selectedWorkspaceId]);

  const refreshConversationsByWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
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

      if (!rootsOnly.some((conversation) => conversation.id === selectedConversationId)) {
        setSelectedConversationId(rootsOnly[0]?.id ?? '');
      }
    },
    [backendUrl, pushActivity, selectedConversationId],
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
      if (streamRef.current) {
        // Keep active runs alive across renderer reloads; only detach this UI listener.
        streamRef.current.dispose();
        streamRef.current = null;
      }
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

      await refreshConversationsByWorkspace(selectedWorkspaceId);
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
      pushNotice('success', `Deleted conversation "${displayName}".`);
      await refreshConversationsByWorkspace(selectedWorkspaceId);
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

      await refreshConversationsByWorkspace(selectedWorkspaceId);
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
    (eventName: string, data: unknown): void => {
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
        const toolResult = asRecord(getField(eventRecord, ['tool_result']));
        const toolName = getString(toolResult, ['name']) || 'unknown tool';
        const success = getBoolean(toolResult, ['success']);
        const resultText = getString(toolResult, ['result']);
        const errorText = getString(toolResult, ['error']);
        const callID = getString(toolResult, ['call_id']);
        const summary = summarizeToolBody(toolName, resultText, errorText);
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
        finalizeTurn(false);
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
        finalizeTurn(false);
        return;
      }

      if (kind === 'turn_complete') {
        openToolEventIDsRef.current = {};
        finalizeTurn(false);
        return;
      }

      pushActivity({ kind: 'status', title: `Event: ${kind}` });
    },
    [appendStreamingText, finalizeTurn, mutateActivity, pushActivity],
  );

  const handleStreamPacket = useCallback(
    (packet: LoopStreamPacket): void => {
      if (!streamRef.current || packet.streamId !== streamRef.current.streamId) {
        return;
      }

      const isViewingStreamConversation = streamRef.current.conversationId === selectedConversationIdRef.current;

      if (packet.type === 'event') {
        if (!isViewingStreamConversation) {
          return;
        }
        handleTurnEvent(packet.eventName ?? 'message', packet.data);
        return;
      }

      if (packet.type === 'error') {
        if (isViewingStreamConversation) {
          pushActivity({ kind: 'error', title: 'Stream transport error', body: packet.error ?? '' });
        }
        openToolEventIDsRef.current = {};
        finalizeTurn(true);
        return;
      }

      if (packet.type === 'aborted') {
        if (isViewingStreamConversation && packet.error) {
          pushActivity({ kind: 'lifecycle', title: 'Turn canceled', body: packet.error });
        }
        openToolEventIDsRef.current = {};
        finalizeTurn(true);
        return;
      }

      if (packet.type === 'done') {
        openToolEventIDsRef.current = {};
        finalizeTurn(true);
      }
    },
    [finalizeTurn, handleTurnEvent, pushActivity],
  );

  const sendMessage = useCallback(async (): Promise<void> => {
    const text = messageInput.trim();
    if (!text || isSending) {
      return;
    }

    const conversationId = await ensureConversationId(text);
    if (!conversationId) {
      return;
    }

    clearNotices();
    setIsSending(true);
    lastStatusRef.current = '';
    draftAssistantIdRef.current = null;
    draftThoughtIdRef.current = null;
    openToolEventIDsRef.current = {};

    pushActivity({ kind: 'user', title: 'User prompt', body: text });
    pushActivity({ kind: 'lifecycle', title: 'Turn started' });
    setMessageInput('');
    const requestedStreamID = crypto.randomUUID();
    streamRef.current = {
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
      },
      (packet) => {
        handleStreamPacket(packet);
      },
    ).catch((error: unknown) => {
      pushActivity({
        kind: 'error',
        title: 'Unable to start stream',
        body: error instanceof Error ? error.message : 'Unknown stream error',
      });
      finalizeTurn(true);
      return null;
    });

    if (!stream) {
      return;
    }

    streamRef.current = {
      ...stream,
      conversationId,
    };
  }, [backendUrl, clearNotices, ensureConversationId, finalizeTurn, handleStreamPacket, isSending, messageInput, pushActivity]);

  const cancelStream = useCallback(async (): Promise<void> => {
    if (!streamRef.current) {
      return;
    }

    await streamRef.current.cancel();
    pushActivity({ kind: 'lifecycle', title: 'Turn cancel requested' });
  }, [pushActivity]);

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
    const conversationId = await createConversation('New thread');
    if (!conversationId) {
      return;
    }
    setSelectedConversationId(conversationId);
    clearNotices();
  }, [clearConversationView, clearNotices, createConversation]);

  const refreshConversations = useCallback(async (): Promise<void> => {
    if (!selectedWorkspaceId) {
      return;
    }
    await refreshConversationsByWorkspace(selectedWorkspaceId);
  }, [refreshConversationsByWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedConversationId || streamRef.current) {
      return;
    }

    let disposed = false;
    void (async () => {
      const active = await getActiveReplyStream({
        baseUrl: backendUrl,
        conversationId: selectedConversationId,
      });
      if (disposed || !active.ok || !active.streamId || streamRef.current) {
        return;
      }

      const attached = attachReplyStream(active.streamId, (packet) => {
        handleStreamPacket(packet);
      });

      streamRef.current = {
        ...attached,
        conversationId: selectedConversationId,
      };
      setIsSending(true);
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

    activities,
    feedScrollRef,

    messageInput,
    setMessageInput,
    canCompose: selectedWorkspaceId !== '',
    isSending,
    notices,
    dismissNotice,

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
  };
}
