import { create } from 'zustand';
import type { NoticeTone, NoticeToast } from '../hooks/useLoopDesktop.types';

interface NoticeStoreState {
    notices: NoticeToast[];
    pushNotice: (tone: NoticeTone, message: string) => void;
    dismissNotice: (id: string) => void;
    clearNotices: () => void;
}

export const useNoticeStore = create<NoticeStoreState>((set) => ({
    notices: [],
    pushNotice: (tone, message) =>
        set((state) => ({
            notices: [
                ...state.notices,
                { id: crypto.randomUUID(), tone, message },
            ],
        })),
    dismissNotice: (id) =>
        set((state) => ({
            notices: state.notices.filter((n) => n.id !== id),
        })),
    clearNotices: () => set({ notices: [] }),
}));
