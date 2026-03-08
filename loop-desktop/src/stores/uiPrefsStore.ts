import { create } from 'zustand';

interface UiPrefsStoreState {
    hideLifecycle: boolean;
    setHideLifecycle: (v: boolean) => void;
    showMascot: boolean;
    setShowMascot: (v: boolean) => void;
    reactScanEnabled: boolean;
    setReactScanEnabled: (v: boolean) => void;
    currentStatus: string;
    setCurrentStatus: (v: string) => void;
}

export const useUiPrefsStore = create<UiPrefsStoreState>((set) => ({
    hideLifecycle: true,
    setHideLifecycle: (v) => set({ hideLifecycle: v }),
    showMascot: false,
    setShowMascot: (v) => set({ showMascot: v }),
    reactScanEnabled: false,
    setReactScanEnabled: (v) => set({ reactScanEnabled: v }),
    currentStatus: '',
    setCurrentStatus: (v) => set({ currentStatus: v }),
}));
