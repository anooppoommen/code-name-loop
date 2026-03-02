import { useCallback, useState } from 'react';
import type { NoticeTone, NoticeToast } from './useLoopDesktop.types';

export interface UseNoticesReturn {
    notices: NoticeToast[];
    pushNotice: (tone: NoticeTone, message: string) => void;
    dismissNotice: (id: string) => void;
    clearNotices: () => void;
}

export function useNotices(): UseNoticesReturn {
    const [notices, setNotices] = useState<NoticeToast[]>([]);

    const pushNotice = useCallback((tone: NoticeTone, message: string): void => {
        setNotices((prev) => [...prev.slice(-3), { id: crypto.randomUUID(), tone, message }]);
    }, []);

    const dismissNotice = useCallback((id: string): void => {
        setNotices((prev) => prev.filter((notice) => notice.id !== id));
    }, []);

    const clearNotices = useCallback((): void => {
        setNotices([]);
    }, []);

    return { notices, pushNotice, dismissNotice, clearNotices };
}
