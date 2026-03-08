import { create } from 'zustand';
import { requestJson } from '../lib/loopClient';
import { asRecord, stringifyResponseError } from '../utils/parsers';
import { parsePendingCommandApprovalRecord, rowsFromUnknown } from '../hooks/useLoopDesktop.helpers';
import type { CommandApprovalDecision, PendingCommandApproval } from '../hooks/useLoopDesktop.types';
import { useConnectionStore } from './connectionStore';
import { useSelectionStore } from './selectionStore';
import { useNoticeStore } from './noticeStore';


interface CommandApprovalStoreState {
    pendingCommandApprovals: PendingCommandApproval[];
    isResolvingCommandApproval: boolean;

    enqueueCommandApproval: (approval: PendingCommandApproval) => void;
    setPendingCommandApprovals: (
        updater: PendingCommandApproval[] | ((prev: PendingCommandApproval[]) => PendingCommandApproval[]),
    ) => void;
    syncPendingApprovalsForConversation: (conversationId: string) => Promise<void>;
    resolveCommandApproval: (decision: CommandApprovalDecision, message?: string) => Promise<void>;

    // Selectors
    getPendingForConversation: (conversationId: string) => PendingCommandApproval[];
    getPendingApproval: (conversationId: string) => PendingCommandApproval | null;
}

export const useCommandApprovalStore = create<CommandApprovalStoreState>((set, get) => ({
    pendingCommandApprovals: [],
    isResolvingCommandApproval: false,

    enqueueCommandApproval: (approval) =>
        set((state) => {
            if (state.pendingCommandApprovals.some((item) => item.id === approval.id)) {
                return state;
            }
            return { pendingCommandApprovals: [...state.pendingCommandApprovals, approval] };
        }),

    setPendingCommandApprovals: (updater) =>
        set((state) => ({
            pendingCommandApprovals:
                typeof updater === 'function'
                    ? updater(state.pendingCommandApprovals)
                    : updater,
        })),

    syncPendingApprovalsForConversation: async (conversationId) => {
        if (!conversationId) return;

        const backendUrl = useConnectionStore.getState().backendUrl;

        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/command-approvals?conversation_id=${encodeURIComponent(conversationId)}`,
            method: 'GET',
        });
        if (!response.ok) return;

        const fetched = rowsFromUnknown(response.data)
            .map((item) => parsePendingCommandApprovalRecord(asRecord(item), conversationId))
            .filter((item): item is PendingCommandApproval => item !== null);

        set((state) => {
            const others = state.pendingCommandApprovals.filter(
                (item) => item.conversationId !== conversationId,
            );
            if (fetched.length === 0) return { pendingCommandApprovals: others };
            const deduped = new Map<string, PendingCommandApproval>();
            for (const item of fetched) deduped.set(item.id, item);
            return { pendingCommandApprovals: [...others, ...Array.from(deduped.values())] };
        });
    },

    resolveCommandApproval: async (decision, message) => {
        const state = get();
        const selectedConversationId = useSelectionStore.getState().selectedConversationId;
        const pendingCommandApproval = state.getPendingApproval(selectedConversationId);

        if (!pendingCommandApproval || state.isResolvingCommandApproval) return;

        const backendUrl = useConnectionStore.getState().backendUrl;
        const pushNotice = useNoticeStore.getState().pushNotice;
        const trimmedMessage = (message ?? '').trim();

        set({ isResolvingCommandApproval: true });
        const response = await requestJson<unknown>({
            baseUrl: backendUrl,
            endpointPath: `/command-approvals/${encodeURIComponent(pendingCommandApproval.id)}/decision`,
            method: 'POST',
            body: { decision, message: trimmedMessage },
        });
        set({ isResolvingCommandApproval: false });

        if (!response.ok) {
            if (response.status === 404) {
                set((s) => ({
                    pendingCommandApprovals: s.pendingCommandApprovals.filter(
                        (item) => item.id !== pendingCommandApproval.id,
                    ),
                }));
                pushNotice('info', 'Command approval request expired.');
                return;
            }
            pushNotice(
                'error',
                `Failed to resolve command approval: ${stringifyResponseError(response.data, response.error)}`,
            );
            return;
        }

        set((s) => ({
            pendingCommandApprovals: s.pendingCommandApprovals.filter(
                (item) => item.id !== pendingCommandApproval.id,
            ),
        }));
    },

    getPendingForConversation: (conversationId) =>
        get().pendingCommandApprovals.filter((item) => item.conversationId === conversationId),

    getPendingApproval: (conversationId) =>
        get().pendingCommandApprovals.find((item) => item.conversationId === conversationId) ?? null,
}));
