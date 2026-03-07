import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoopStreamPacket } from '../electron';
import type { ActivityEvent } from '../types/ui';
import type { ActivityInput } from '../utils/activityTimeline';
import { annotateActivitiesWithPendingApprovals } from './useLoopDesktop.helpers';
import { createHandleStreamPacket, createHandleTurnEvent } from './useLoopDesktop.stream';
import type { ConversationLiveState, NoticeTone, PendingCommandApproval, StreamHandle } from './useLoopDesktop.types';
import { useConversationStore } from '../stores/conversationStore';
import { useEventStore } from '../stores/eventStore';
import { usePatchRevertStore } from '../stores/patchRevertStore';

const EMPTY_ACTIVITY_IDS: string[] = [];

function sortEvents(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((left, right) => {
    if (left.sequenceNo !== right.sequenceNo) {
      return left.sequenceNo - right.sequenceNo;
    }
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.id.localeCompare(right.id);
  });
}

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
  currentStatus: string;
  setCurrentStatus: (value: string) => void;
  hideLifecycle: boolean;
  setHideLifecycle: (value: boolean) => void;
  showMascot: boolean;
  setShowMascot: (value: boolean) => void;
  activeStreamsRef: React.RefObject<Record<string, StreamHandle>>;
  sendingConversations: Record<string, boolean>;
  setSendingConversations: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  sendingConversationsRef: React.RefObject<Record<string, boolean>>;
  handleStreamPacketRef: React.RefObject<((packet: LoopStreamPacket, conversationId: string) => void) | null>;
  handleStreamPacket: (packet: LoopStreamPacket, conversationId: string) => void;
  handleTurnEvent: (eventName: string, data: unknown, conversationId: string) => void;
}

export function useActivities(
  selectedConversationId: string,
  selectedConversationIdRef: React.RefObject<string>,
  enqueueCommandApproval: (approval: PendingCommandApproval) => void,
  pushNotice: (tone: NoticeTone, message: string) => void,
  pendingApprovalsForSelectedConversation: PendingCommandApproval[],
): UseActivitiesReturn {
  const [hideLifecycle, setHideLifecycle] = useState(true);
  const [showMascot, setShowMascot] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string>('');
  const [sendingConversations, setSendingConversations] = useState<Record<string, boolean>>({});

  const activeStreamsRef = useRef<Record<string, StreamHandle>>({});
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const handleStreamPacketRef = useRef<((packet: LoopStreamPacket, conversationId: string) => void) | null>(null);
  const handleTurnEventRef = useRef<((eventName: string, data: unknown, conversationId: string) => void) | null>(null);
  const sendingConversationsRef = useRef<Record<string, boolean>>({});

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

  const activities = useMemo(() => {
    return annotateActivitiesWithPendingApprovals(rawActivities, pendingApprovalsForSelectedConversation);
  }, [pendingApprovalsForSelectedConversation, rawActivities]);

  const visibleActivities = useMemo(() => {
    if (!hideLifecycle) {
      return activities;
    }
    return activities.filter((event) => event.kind !== 'lifecycle');
  }, [activities, hideLifecycle]);

  useEffect(() => {
    sendingConversationsRef.current = sendingConversations;
  }, [sendingConversations]);

  useEffect(() => {
    const annotatedActivities = annotateActivitiesWithPendingApprovals(
      rawActivities,
      pendingApprovalsForSelectedConversation,
    );
    const eventStore = useEventStore.getState();

    for (const annotatedEvent of annotatedActivities) {
      const currentEvent = eventStore.events[annotatedEvent.id];
      const currentWaitingApproval = currentEvent?.tool?.waitingApproval ?? false;
      const nextWaitingApproval = annotatedEvent.tool?.waitingApproval ?? false;
      if (currentWaitingApproval === nextWaitingApproval) {
        continue;
      }

      eventStore.updateEvent(annotatedEvent.id, () => annotatedEvent);
    }
  }, [pendingApprovalsForSelectedConversation, rawActivities]);

  const getConversationLiveState = useCallback((conversationId: string): ConversationLiveState => {
    return useConversationStore.getState().getLiveState(conversationId);
  }, []);

  const resetConversationLiveState = useCallback((conversationId: string): void => {
    if (!conversationId) {
      return;
    }
    useConversationStore.getState().resetLiveState(conversationId);
  }, []);

  const updateConversationLiveState = useCallback((
    conversationId: string,
    stateOrUpdater:
      | Partial<ConversationLiveState>
      | ((prev: ConversationLiveState) => Partial<ConversationLiveState>),
  ): void => {
    if (!conversationId) {
      return;
    }
    useConversationStore.getState().updateLiveState(conversationId, stateOrUpdater);
  }, []);

  const replaceConversationActivities = useCallback((conversationId: string, events: ActivityEvent[]): void => {
    if (!conversationId) {
      return;
    }

    const normalizedEvents = sortEvents(
      events.map((event, index) => ({
        ...event,
        conversationId,
        sequenceNo: Number.isFinite(event.sequenceNo) ? event.sequenceNo : index + 1,
      })),
    );
    useConversationStore.getState().replaceConversationEvents(conversationId, normalizedEvents);
  }, []);

  const updateConversationActivities = useCallback(
    (conversationId: string, updater: (events: ActivityEvent[]) => ActivityEvent[]): void => {
      if (!conversationId) {
        return;
      }
      const currentEvents = useConversationStore.getState().getConversationEvents(conversationId);
      replaceConversationActivities(conversationId, updater(currentEvents));
    },
    [replaceConversationActivities],
  );

  const pushActivity = useCallback((input: ActivityInput, conversationId?: string): string => {
    const targetConversationId = conversationId ?? selectedConversationIdRef.current;
    if (!targetConversationId) {
      return '';
    }

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

    useConversationStore.getState().upsertConversationEvent(event);

    return event.id;
  }, [selectedConversationIdRef]);

  const mutateActivity = useCallback((id: string, transform: (event: ActivityEvent) => ActivityEvent): void => {
    const currentEvent = useEventStore.getState().events[id];
    if (!currentEvent) {
      return;
    }

    useEventStore.getState().updateEvent(id, transform);
  }, []);

  const appendStreamingText = useCallback(
    (conversationId: string, kind: 'assistant' | 'thought', text: string): void => {
      if (!text) {
        return;
      }

      const liveState = getConversationLiveState(conversationId);
      const existing = kind === 'assistant' ? liveState.draftAssistantId : liveState.draftThoughtId;
      if (!existing) {
        const draftId = pushActivity(
          {
            kind,
            title: kind === 'assistant' ? 'Assistant response' : 'Model thought',
            body: text,
            streaming: true,
          },
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
    if (!conversationId) {
      return;
    }

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
    if (!conversationId) {
      return;
    }

    const liveState = getConversationLiveState(conversationId);
    if (!liveState.draftThoughtId) {
      return;
    }

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
        const stream = activeStreamsRef.current[conversationId];
        if (stream) {
          stream.dispose();
          delete activeStreamsRef.current[conversationId];
        }
      }
    },
    [selectedConversationIdRef, settleDrafts, updateConversationLiveState],
  );

  const clearConversationView = useCallback((): void => {
    const conversationId = selectedConversationIdRef.current;
    if (!conversationId) {
      setCurrentStatus('');
      return;
    }
    useConversationStore.getState().clearConversation(conversationId);
    usePatchRevertStore.getState().clearConversation(conversationId);
    setCurrentStatus('');
  }, [selectedConversationIdRef]);

  useEffect(() => {
    return () => {
      for (const key of Object.keys(activeStreamsRef.current)) {
        activeStreamsRef.current[key]?.dispose();
      }
      activeStreamsRef.current = {};
    };
  }, []);

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
    handleStreamPacketRef.current = createHandleStreamPacket({
      enqueueCommandApproval,
      finalizeTurn,
      getActiveStreamId: (conversationId: string) => activeStreamsRef.current[conversationId]?.streamId,
      handleTurnEvent,
      pushActivity,
      pushNotice,
      getSelectedConversationId: () => selectedConversationIdRef.current,
      updateConversationLiveState,
    });
  }, [
    enqueueCommandApproval,
    finalizeTurn,
    handleTurnEvent,
    pushActivity,
    pushNotice,
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
    currentStatus,
    setCurrentStatus,
    hideLifecycle,
    setHideLifecycle,
    showMascot,
    setShowMascot,
    activeStreamsRef,
    sendingConversations,
    setSendingConversations,
    sendingConversationsRef,
    handleStreamPacketRef,
    handleStreamPacket,
    handleTurnEvent,
  };
}
