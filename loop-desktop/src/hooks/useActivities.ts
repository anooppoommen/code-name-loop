import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { LoopStreamPacket } from '../electron';
import type { ActivityEvent } from '../types/ui';
import type { ActivityInput } from '../utils/activityTimeline';
import { createHandleStreamPacket, createHandleTurnEvent } from './useLoopDesktop.stream';
import type { ConversationLiveState } from './useLoopDesktop.types';
import { useConversationStore } from '../stores/conversationStore';
import { useEventStore } from '../stores/eventStore';
import { usePatchRevertStore } from '../stores/patchRevertStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useUiPrefsStore } from '../stores/uiPrefsStore';
import { useStreamingStore, activeStreams } from '../stores/streamingStore';
import { useCommandApprovalStore } from '../stores/commandApprovalStore';
import { useNoticeStore } from '../stores/noticeStore';
import { annotateActivitiesWithPendingApprovals } from '../stores/activityStore.helpers';
import {
  clearConversationPipeline,
  getConversationEvents,
  replaceConversationEvents,
  syncConversationPendingApprovals,
  updateConversationEvent,
  upsertConversationEvent,
} from '../stores/activityPipeline';

const EMPTY_ACTIVITY_IDS: string[] = [];

export interface UseActivitiesReturn {
  activities: ActivityEvent[];
  visibleActivities: ActivityEvent[];
  replaceConversationActivities: (conversationId: string, events: ActivityEvent[]) => void;
  updateConversationActivities: (conversationId: string, updater: (events: ActivityEvent[]) => ActivityEvent[]) => void;
  pushActivity: (input: ActivityInput, conversationId?: string) => string;
  mutateActivity: (id: string, transform: (event: ActivityEvent) => ActivityEvent) => void;
  appendStreamingText: (conversationId: string, kind: 'assistant' | 'thought', text: string) => void;
  settleDrafts: (conversationId: string) => void;
  settleThoughtDraft: (conversationId: string) => void;
  finalizeTurn: (closeStream: boolean, conversationId?: string) => void;
  clearConversationView: () => void;
  getConversationLiveState: (conversationId: string) => ConversationLiveState;
  resetConversationLiveState: (conversationId: string) => void;
  feedScrollRef: React.RefObject<HTMLDivElement | null>;
  handleStreamPacketRef: React.RefObject<((packet: LoopStreamPacket, conversationId: string) => void) | null>;
  handleStreamPacket: (packet: LoopStreamPacket, conversationId: string) => void;
  handleTurnEvent: (eventName: string, data: unknown, conversationId: string) => void;
}

export function useActivities(): UseActivitiesReturn {
  // ── Store subscriptions ────────────────────────────────
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const { setSendingConversations } = useStreamingStore();
  const { setCurrentStatus } = useUiPrefsStore();

  // Keep a stable ref to selected conversation ID for use in non-reactive callbacks
  const selectedConversationIdRef = useRef(selectedConversationId);
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const handleStreamPacketRef = useRef<((packet: LoopStreamPacket, conversationId: string) => void) | null>(null);
  const handleTurnEventRef = useRef<((eventName: string, data: unknown, conversationId: string) => void) | null>(null);

  // ── Activity data from stores ──────────────────────────
  const selectedEventIds = useConversationStore(
    useCallback(
      (state) => state.conversations[selectedConversationId]?.orderedEventIds ?? EMPTY_ACTIVITY_IDS,
      [selectedConversationId],
    ),
  );
  const eventsById = useEventStore((state) => state.events);

  const rawActivities = useMemo(() => {
    return selectedEventIds
      .map((id) => eventsById[id])
      .filter((event): event is ActivityEvent => !!event);
  }, [eventsById, selectedEventIds]);


  // Subscribe to the raw array (stable reference). Filter in useMemo to avoid
  // returning a new array every snapshot check (which causes an infinite loop).
  const allPendingCommandApprovals = useCommandApprovalStore((s) => s.pendingCommandApprovals);
  const pendingApprovalsForSelectedConversation = useMemo(
    () => allPendingCommandApprovals.filter((item) => item.conversationId === selectedConversationId),
    [allPendingCommandApprovals, selectedConversationId],
  );

  const activities = useMemo(() => {
    return annotateActivitiesWithPendingApprovals(rawActivities, pendingApprovalsForSelectedConversation);
  }, [pendingApprovalsForSelectedConversation, rawActivities]);

  const hideLifecycle = useUiPrefsStore((s) => s.hideLifecycle);
  const visibleActivities = useMemo(() => {
    if (!hideLifecycle) {
      return activities;
    }
    return activities.filter((event) => event.kind !== 'lifecycle');
  }, [activities, hideLifecycle]);

  // ── Annotation sync effect ─────────────────────────────
  useEffect(() => {
    if (!selectedConversationId) {
      return;
    }
    syncConversationPendingApprovals(selectedConversationId, pendingApprovalsForSelectedConversation);
  }, [pendingApprovalsForSelectedConversation, rawActivities, selectedConversationId]);

  // ── Core activity operations ───────────────────────────
  const getConversationLiveState = useCallback((conversationId: string): ConversationLiveState => {
    return useConversationStore.getState().getLiveState(conversationId);
  }, []);

  const resetConversationLiveState = useCallback((conversationId: string): void => {
    if (!conversationId) return;
    useConversationStore.getState().resetLiveState(conversationId);
  }, []);

  const updateConversationLiveState = useCallback((
    conversationId: string,
    stateOrUpdater:
      | Partial<ConversationLiveState>
      | ((prev: ConversationLiveState) => Partial<ConversationLiveState>),
  ): void => {
    if (!conversationId) return;
    useConversationStore.getState().updateLiveState(conversationId, stateOrUpdater);
  }, []);

  const replaceConversationActivities = useCallback((conversationId: string, events: ActivityEvent[]): void => {
    if (!conversationId) return;
    replaceConversationEvents(conversationId, events);
  }, []);

  const updateConversationActivities = useCallback(
    (conversationId: string, updater: (events: ActivityEvent[]) => ActivityEvent[]): void => {
      if (!conversationId) return;
      const currentEvents = getConversationEvents(conversationId);
      replaceConversationActivities(conversationId, updater(currentEvents));
    },
    [replaceConversationActivities],
  );

  const pushActivity = useCallback((input: ActivityInput, conversationId?: string): string => {
    const targetConversationId = conversationId ?? selectedConversationIdRef.current;
    if (!targetConversationId) return '';

    const sequenceNo = useConversationStore.getState().reserveSequenceNo(targetConversationId);
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      conversationId: targetConversationId,
      sequenceNo,
      kind: input.kind,
      title: input.title,
      body: input.body,
      userTurn: input.userTurn,
      checkpointId: input.checkpointId,
      checkpointReason: input.checkpointReason,
      baseCheckpointId: input.baseCheckpointId,
      patchId: input.patchId,
      filePaths: input.filePaths,
      tool: input.tool,
      images: input.images,
      timestamp: Date.now(),
      streaming: input.streaming,
    };

    upsertConversationEvent(event);
    return event.id;
  }, [selectedConversationIdRef]);

  const mutateActivity = useCallback((id: string, transform: (event: ActivityEvent) => ActivityEvent): void => {
    const currentEvent = useEventStore.getState().events[id];
    if (!currentEvent) return;
    updateConversationEvent(id, transform);
  }, []);

  const appendStreamingText = useCallback(
    (conversationId: string, kind: 'assistant' | 'thought', text: string): void => {
      if (!text) return;

      const liveState = getConversationLiveState(conversationId);
      const existing = kind === 'assistant' ? liveState.draftAssistantId : liveState.draftThoughtId;
      if (!existing) {
        const draftId = pushActivity(
          { kind, title: kind === 'assistant' ? 'Assistant response' : 'Model thought', body: text, streaming: true },
          conversationId,
        );
        updateConversationLiveState(conversationId, {
          draftAssistantId: kind === 'assistant' ? draftId : liveState.draftAssistantId,
          draftThoughtId: kind === 'thought' ? draftId : liveState.draftThoughtId,
        });
        return;
      }

      mutateActivity(existing, (event) => ({
        ...event,
        body: `${event.body ?? ''}${text}`,
        streaming: true,
      }));
    },
    [getConversationLiveState, mutateActivity, pushActivity, updateConversationLiveState],
  );

  const settleDrafts = useCallback((conversationId: string): void => {
    if (!conversationId) return;
    const liveState = getConversationLiveState(conversationId);
    const draftIds = [liveState.draftAssistantId, liveState.draftThoughtId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    for (const draftId of draftIds) {
      mutateActivity(draftId, (event) => ({ ...event, streaming: false }));
    }
    updateConversationLiveState(conversationId, {
      draftAssistantId: null,
      draftThoughtId: null,
    });
  }, [getConversationLiveState, mutateActivity, updateConversationLiveState]);

  const settleThoughtDraft = useCallback((conversationId: string): void => {
    if (!conversationId) return;
    const liveState = getConversationLiveState(conversationId);
    if (!liveState.draftThoughtId) return;
    mutateActivity(liveState.draftThoughtId, (event) => ({ ...event, streaming: false }));
    updateConversationLiveState(conversationId, { draftThoughtId: null });
  }, [getConversationLiveState, mutateActivity, updateConversationLiveState]);

  const finalizeTurn = useCallback(
    (closeStream: boolean, conversationId?: string): void => {
      const targetConversationId = conversationId ?? selectedConversationIdRef.current;
      if (targetConversationId && (conversationId === undefined || targetConversationId === selectedConversationIdRef.current)) {
        settleDrafts(targetConversationId);
      }

      if (targetConversationId) {
        updateConversationLiveState(targetConversationId, {
          lastStatus: '',
          openToolEventIDs: {},
          retryStatusEventID: null,
        });
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
        const stream = activeStreams[conversationId];
        if (stream) {
          stream.dispose();
          delete activeStreams[conversationId];
        }
      }
    },
    [selectedConversationIdRef, settleDrafts, updateConversationLiveState, setSendingConversations, setCurrentStatus],
  );

  const clearConversationView = useCallback((): void => {
    const conversationId = selectedConversationIdRef.current;
    if (!conversationId) {
      setCurrentStatus('');
      return;
    }
    clearConversationPipeline(conversationId);
    usePatchRevertStore.getState().clearConversation(conversationId);
    setCurrentStatus('');
  }, [selectedConversationIdRef, setCurrentStatus]);

  // ── Cleanup streams on unmount ─────────────────────────
  useEffect(() => {
    return () => {
      for (const key of Object.keys(activeStreams)) {
        activeStreams[key]?.dispose();
        delete activeStreams[key];
      }
    };
  }, []);

  // ── Wire up stream/turn event handlers ────────────────
  useEffect(() => {
    handleTurnEventRef.current = createHandleTurnEvent({
      appendStreamingText,
      finalizeTurn,
      getConversationLiveState,
      mutateActivity,
      pushActivity,
      settleThoughtDraft,
      setCurrentStatus,
      updateConversationLiveState,
    });
  }, [
    appendStreamingText,
    finalizeTurn,
    getConversationLiveState,
    mutateActivity,
    pushActivity,
    settleThoughtDraft,
    setCurrentStatus,
    updateConversationLiveState,
  ]);

  const handleTurnEvent = useCallback((eventName: string, data: unknown, conversationId: string): void => {
    handleTurnEventRef.current?.(eventName, data, conversationId);
  }, []);

  useEffect(() => {
    const enqueueCommandApproval = useCommandApprovalStore.getState().enqueueCommandApproval;
    const pushNotice = useNoticeStore.getState().pushNotice;

    handleStreamPacketRef.current = createHandleStreamPacket({
      enqueueCommandApproval,
      finalizeTurn,
      getActiveStreamId: (conversationId: string) => activeStreams[conversationId]?.streamId,
      handleTurnEvent,
      pushActivity,
      pushNotice,
      getSelectedConversationId: () => selectedConversationIdRef.current,
      updateConversationLiveState,
    });
  }, [
    finalizeTurn,
    handleTurnEvent,
    pushActivity,
    selectedConversationIdRef,
    updateConversationLiveState,
  ]);

  const handleStreamPacket = useCallback((packet: LoopStreamPacket, conversationId: string): void => {
    handleStreamPacketRef.current?.(packet, conversationId);
  }, []);

  return {
    activities,
    visibleActivities,
    replaceConversationActivities,
    updateConversationActivities,
    pushActivity,
    mutateActivity,
    appendStreamingText,
    settleDrafts,
    settleThoughtDraft,
    finalizeTurn,
    clearConversationView,
    getConversationLiveState,
    resetConversationLiveState,
    feedScrollRef,
    handleStreamPacketRef,
    handleStreamPacket,
    handleTurnEvent,
  };
}
