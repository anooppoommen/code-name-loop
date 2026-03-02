import { useCallback, useEffect, useState } from 'react';
import type { NoticeTone, SshTunnelConfig, SshTunnelStatus } from './useLoopDesktop.types';

export interface UseSshTunnelReturn {
    sshTunnelConfig: SshTunnelConfig;
    setSshTunnelConfig: React.Dispatch<React.SetStateAction<SshTunnelConfig>>;
    sshTunnelStatus: SshTunnelStatus;
    sshTunnelError: string | null;
    connectTunnel: (config: SshTunnelConfig) => Promise<void>;
    disconnectTunnel: () => Promise<void>;
}

export function useSshTunnel(
    pushNotice: (tone: NoticeTone, message: string) => void,
    setBackendUrl: (value: string) => void,
): UseSshTunnelReturn {
    const [sshTunnelConfig, setSshTunnelConfig] = useState<SshTunnelConfig>({
        host: 'localhost',
        port: 22,
        username: '',
        privateKeyPath: '',
        remotePort: 8080,
    });
    const [sshTunnelStatus, setSshTunnelStatus] = useState<SshTunnelStatus>('disconnected');
    const [sshTunnelError, setSshTunnelError] = useState<string | null>(null);

    useEffect(() => {
        if (!window.loopDesktop?.isElectron) {
            return;
        }

        const unsubscribe = window.loopDesktop.sshTunnel.onStatusChange((status) => {
            setSshTunnelStatus(status.status as SshTunnelStatus);
            setSshTunnelError(status.error);

            if (status.status === 'connected' && status.localPort) {
                setBackendUrl(`http://localhost:${status.localPort}`);
                pushNotice('success', 'SSH tunnel connected. Workspaces resynced.');
            } else if (status.status === 'disconnected' || status.status === 'error') {
                setBackendUrl('http://localhost:8080');
                if (status.status === 'error' && status.error) {
                    pushNotice('error', `SSH tunnel error: ${status.error}`);
                }
            }
        });

        // Check initial status
        void window.loopDesktop.sshTunnel.status().then((status) => {
            setSshTunnelStatus(status.status as SshTunnelStatus);
            setSshTunnelError(status.error);
            if (status.status === 'connected' && status.localPort) {
                setBackendUrl(`http://localhost:${status.localPort}`);
            }
        });

        return () => {
            unsubscribe();
        };
    }, [pushNotice, setBackendUrl]);

    const connectTunnel = useCallback(async (config: SshTunnelConfig): Promise<void> => {
        if (!window.loopDesktop?.isElectron) return;
        const res = await window.loopDesktop.sshTunnel.connect(config);
        if (!res.ok) {
            pushNotice('error', `Tunnel connection failed: ${res.error}`);
        }
    }, [pushNotice]);

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
