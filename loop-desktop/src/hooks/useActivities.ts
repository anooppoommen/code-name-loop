import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoopStreamPacket } from '../electron';
import type { ActivityEvent } from '../types/ui';
import type { ActivityInput } from '../utils/activityTimeline';
import { annotateActivitiesWithPendingApprovals } from './useLoopDesktop.helpers';
import { createHandleStreamPacket, createHandleTurnEvent } from './useLoopDesktop.stream';
import type { ConversationLiveState, NoticeTone, PendingCommandApproval, StreamHandle } from './useLoopDesktop.types';

export interface UseActivitiesReturn {
    activities: ActivityEvent[];
    setActivities: React.Dispatch<React.SetStateAction<ActivityEvent[]>>;
    visibleActivities: ActivityEvent[];
    pushActivity: (input: ActivityInput) => string;
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
    selectedConversationIdRef: React.RefObject<string>,
    enqueueCommandApproval: (approval: PendingCommandApproval) => void,
    pushNotice: (tone: NoticeTone, message: string) => void,
    pendingApprovalsForSelectedConversation: PendingCommandApproval[],
): UseActivitiesReturn {
    const [activities, setActivities] = useState<ActivityEvent[]>([]);
    const [hideLifecycle, setHideLifecycle] = useState(true);
    const [showMascot, setShowMascot] = useState(false);
    const [currentStatus, setCurrentStatus] = useState<string>('');
    const [sendingConversations, setSendingConversations] = useState<Record<string, boolean>>({});

    const activeStreamsRef = useRef<Record<string, StreamHandle>>({});
    const feedScrollRef = useRef<HTMLDivElement | null>(null);
    const conversationLiveStateRef = useRef<Record<string, ConversationLiveState>>({});
    const handleStreamPacketRef = useRef<((packet: LoopStreamPacket, conversationId: string) => void) | null>(null);
    const sendingConversationsRef = useRef<Record<string, boolean>>({});

    useEffect(() => {
        sendingConversationsRef.current = sendingConversations;
    }, [sendingConversations]);

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
        [getConversationLiveState, selectedConversationIdRef, settleDrafts],
    );

    const clearConversationView = useCallback((): void => {
        setActivities([]);
        resetConversationLiveState(selectedConversationIdRef.current);
        setCurrentStatus('');
    }, [resetConversationLiveState, selectedConversationIdRef]);

    const visibleActivities = useMemo(() => {
        if (!hideLifecycle) return activities;
        return activities.filter((a) => a.kind !== 'lifecycle');
    }, [activities, hideLifecycle]);

    // Annotate activities with pending approvals
    useEffect(() => {
        setActivities((prev) => annotateActivitiesWithPendingApprovals(prev, pendingApprovalsForSelectedConversation));
    }, [pendingApprovalsForSelectedConversation]);

    // Cleanup streams on unmount
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

    // Stream event handlers
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
        [enqueueCommandApproval, finalizeTurn, getConversationLiveState, handleTurnEvent, pushActivity, pushNotice, selectedConversationIdRef],
    );

    useEffect(() => {
        handleStreamPacketRef.current = handleStreamPacket;
    }, [handleStreamPacket]);

    return {
        activities,
        setActivities,
        visibleActivities,
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
