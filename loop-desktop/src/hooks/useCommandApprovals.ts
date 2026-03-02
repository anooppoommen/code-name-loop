import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestJson } from '../lib/loopClient';
import { asRecord, stringifyResponseError } from '../utils/parsers';
import { rowsFromUnknown, parsePendingCommandApprovalRecord } from './useLoopDesktop.helpers';
import type { CommandApprovalDecision, NoticeTone, PendingCommandApproval } from './useLoopDesktop.types';

export interface UseCommandApprovalsReturn {
    pendingCommandApprovals: PendingCommandApproval[];
    setPendingCommandApprovals: React.Dispatch<React.SetStateAction<PendingCommandApproval[]>>;
    pendingCommandApprovalsRef: React.RefObject<PendingCommandApproval[]>;
    enqueueCommandApproval: (approval: PendingCommandApproval) => void;
    syncPendingApprovalsForConversation: (conversationId: string) => Promise<void>;
    pendingApprovalsForSelectedConversation: PendingCommandApproval[];
    pendingCommandApproval: PendingCommandApproval | null;
    isResolvingCommandApproval: boolean;
    resolveCommandApproval: (decision: CommandApprovalDecision, message?: string) => Promise<void>;
}

export function useCommandApprovals(
    backendUrl: string,
    selectedConversationId: string,
    pushNotice: (tone: NoticeTone, message: string) => void,
): UseCommandApprovalsReturn {
    const [pendingCommandApprovals, setPendingCommandApprovals] = useState<PendingCommandApproval[]>([]);
    const [isResolvingCommandApproval, setIsResolvingCommandApproval] = useState(false);
    const pendingCommandApprovalsRef = useRef<PendingCommandApproval[]>([]);

    const pendingApprovalsForSelectedConversation = useMemo(
        () => pendingCommandApprovals.filter((item) => item.conversationId === selectedConversationId),
        [pendingCommandApprovals, selectedConversationId],
    );
    const pendingCommandApproval = pendingApprovalsForSelectedConversation[0] ?? null;

    useEffect(() => {
        pendingCommandApprovalsRef.current = pendingCommandApprovals;
    }, [pendingCommandApprovals]);

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
        if (!selectedConversationId) {
            return;
        }
        void syncPendingApprovalsForConversation(selectedConversationId);
    }, [selectedConversationId, syncPendingApprovalsForConversation]);

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

    return {
        pendingCommandApprovals,
        setPendingCommandApprovals,
        pendingCommandApprovalsRef,
        enqueueCommandApproval,
        syncPendingApprovalsForConversation,
        pendingApprovalsForSelectedConversation,
        pendingCommandApproval,
        isResolvingCommandApproval,
        resolveCommandApproval,
    };
}
