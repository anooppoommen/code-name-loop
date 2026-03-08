import { create } from 'zustand';

interface SelectionStoreState {
    selectedConversationId: string;
    selectedWorkspaceId: string;
    setSelectedConversationId: (id: string) => void;
    setSelectedWorkspaceId: (id: string) => void;
}

export const useSelectionStore = create<SelectionStoreState>((set) => ({
    selectedConversationId: '',
    selectedWorkspaceId: '',
    setSelectedConversationId: (id) => set({ selectedConversationId: id }),
    setSelectedWorkspaceId: (id) => set({ selectedWorkspaceId: id }),
}));
