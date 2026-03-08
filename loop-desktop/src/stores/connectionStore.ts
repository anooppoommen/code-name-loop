import { create } from 'zustand';

interface ConnectionStoreState {
    backendUrl: string;
    setBackendUrl: (url: string) => void;
}

export const useConnectionStore = create<ConnectionStoreState>((set) => ({
    backendUrl: 'http://localhost:8080',
    setBackendUrl: (url) => set({ backendUrl: url }),
}));
