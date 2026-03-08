import { useCallback, useEffect } from 'react';
import type { SshTunnelConfig, SshTunnelStatus } from './useLoopDesktop.types';
import { useSshTunnelStore } from '../stores/sshTunnelStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useNoticeStore } from '../stores/noticeStore';

export interface UseSshTunnelReturn {
    sshTunnelConfig: SshTunnelConfig;
    setSshTunnelConfig: React.Dispatch<React.SetStateAction<SshTunnelConfig>>;
    sshTunnelStatus: SshTunnelStatus;
    sshTunnelError: string | null;
    connectTunnel: (config: SshTunnelConfig) => Promise<void>;
    disconnectTunnel: () => Promise<void>;
}

export function useSshTunnel(): UseSshTunnelReturn {
    const sshTunnelConfig = useSshTunnelStore((s) => s.sshTunnelConfig);
    const setSshTunnelConfig = useSshTunnelStore.getState().setSshTunnelConfig;
    const sshTunnelStatus = useSshTunnelStore((s) => s.sshTunnelStatus);
    const sshTunnelError = useSshTunnelStore((s) => s.sshTunnelError);

    useEffect(() => {
        if (!window.loopDesktop?.isElectron) return;

        const unsubscribe = window.loopDesktop.sshTunnel.onStatusChange((status) => {
            useSshTunnelStore.getState().setSshTunnelStatus(status.status as SshTunnelStatus);
            useSshTunnelStore.getState().setSshTunnelError(status.error);

            if (status.status === 'connected' && status.localPort) {
                useConnectionStore.getState().setBackendUrl(`http://localhost:${status.localPort}`);
                useNoticeStore.getState().pushNotice('success', 'SSH tunnel connected. Workspaces resynced.');
            } else if (status.status === 'disconnected' || status.status === 'error') {
                useConnectionStore.getState().setBackendUrl('http://localhost:8080');
                if (status.status === 'error' && status.error) {
                    useNoticeStore.getState().pushNotice('error', `SSH tunnel error: ${status.error}`);
                }
            }
        });

        // Check initial status
        void window.loopDesktop.sshTunnel.status().then((status) => {
            useSshTunnelStore.getState().setSshTunnelStatus(status.status as SshTunnelStatus);
            useSshTunnelStore.getState().setSshTunnelError(status.error);
            if (status.status === 'connected' && status.localPort) {
                useConnectionStore.getState().setBackendUrl(`http://localhost:${status.localPort}`);
            }
        });

        return () => { unsubscribe(); };
    }, []);

    const connectTunnel = useCallback(async (config: SshTunnelConfig): Promise<void> => {
        if (!window.loopDesktop?.isElectron) return;
        const res = await window.loopDesktop.sshTunnel.connect(config);
        if (!res.ok) {
            useNoticeStore.getState().pushNotice('error', `Tunnel connection failed: ${res.error}`);
        }
    }, []);

    const disconnectTunnel = useCallback(async (): Promise<void> => {
        if (!window.loopDesktop?.isElectron) return;
        await window.loopDesktop.sshTunnel.disconnect();
    }, []);

    return {
        sshTunnelConfig,
        setSshTunnelConfig,
        sshTunnelStatus,
        sshTunnelError,
        connectTunnel,
        disconnectTunnel,
    };
}
