import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { SshTunnelConfig, SshTunnelStatus } from '../hooks/useLoopDesktop.types';

function applyAction<T>(prev: T, action: SetStateAction<T>): T {
    return typeof action === 'function' ? (action as (p: T) => T)(prev) : action;
}

interface SshTunnelStoreState {
    sshTunnelConfig: SshTunnelConfig;
    setSshTunnelConfig: (action: SetStateAction<SshTunnelConfig>) => void;
    sshTunnelStatus: SshTunnelStatus;
    setSshTunnelStatus: (status: SshTunnelStatus) => void;
    sshTunnelError: string | null;
    setSshTunnelError: (error: string | null) => void;
}

export const useSshTunnelStore = create<SshTunnelStoreState>((set, get) => ({
    sshTunnelConfig: {
        host: 'localhost',
        port: 22,
        username: '',
        privateKeyPath: '',
        remotePort: 8080,
    },
    setSshTunnelConfig: (action) =>
        set({ sshTunnelConfig: applyAction(get().sshTunnelConfig, action) }),
    sshTunnelStatus: 'disconnected',
    setSshTunnelStatus: (status) => set({ sshTunnelStatus: status }),
    sshTunnelError: null,
    setSshTunnelError: (error) => set({ sshTunnelError: error }),
}));
