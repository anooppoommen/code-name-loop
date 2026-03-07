import { motion } from 'framer-motion';
import { X, Server, Key, User, Play, Square, AlertCircle } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { SshTunnelConfig, SshTunnelStatus } from '../hooks/useLoopDesktop.types';

interface ConnectionSettingsProps {
    onClose: () => void;
    sshTunnelConfig: SshTunnelConfig;
    setSshTunnelConfig: Dispatch<SetStateAction<SshTunnelConfig>>;
    sshTunnelStatus: SshTunnelStatus;
    sshTunnelError: string | null;
    connectTunnel: (config: SshTunnelConfig) => Promise<void>;
    disconnectTunnel: () => Promise<void>;
}

export function ConnectionSettings({
    onClose,
    sshTunnelConfig,
    setSshTunnelConfig,
    sshTunnelStatus,
    sshTunnelError,
    connectTunnel,
    disconnectTunnel,
}: ConnectionSettingsProps) {

    const handleChange = (field: keyof typeof sshTunnelConfig, value: string | number) => {
        setSshTunnelConfig((prev) => ({ ...prev, [field]: value }));
    };

    // const handlePickKey = async () => {
    //     const folder = await chooseFolder();
    //     if (folder) {
    //         handleChange('privateKeyPath', folder); // In Electron, chooseFolder currently picks directories. In a real app we'd pick a file, but for now we'll allow manually editing it too.
    //     }
    // };

    const handleConnect = () => {
        void connectTunnel(sshTunnelConfig);
    };

    const handleDisconnect = () => {
        void disconnectTunnel();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 text-sm text-neutral-200">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-neutral-900 shadow-2xl"
            >
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 bg-neutral-900/50">
                    <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-neutral-400" />
                        <span className="font-semibold text-neutral-100">Connection Settings</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-md p-1 hover:bg-white/10 text-neutral-400 hover:text-neutral-100 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    {/* Status Indicator */}
                    <div className="flex items-center justify-between bg-black/30 p-3 rounded-lg border border-white/5">
                        <div className="flex items-center gap-3">
                            <div className="relative flex h-3 w-3">
                                <span
                                    className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${sshTunnelStatus === 'connected'
                                            ? 'bg-emerald-500 animate-ping'
                                            : sshTunnelStatus === 'connecting'
                                                ? 'bg-amber-500 animate-ping'
                                                : sshTunnelStatus === 'error'
                                                    ? 'bg-red-500'
                                                    : 'bg-neutral-500'
                                        }`}
                                />
                                <span
                                    className={`relative inline-flex h-3 w-3 rounded-full ${sshTunnelStatus === 'connected'
                                            ? 'bg-emerald-500'
                                            : sshTunnelStatus === 'connecting'
                                                ? 'bg-amber-500'
                                                : sshTunnelStatus === 'error'
                                                    ? 'bg-red-500'
                                                    : 'bg-neutral-500'
                                        }`}
                                />
                            </div>
                            <span className="font-medium text-neutral-300 capitalize">{sshTunnelStatus}</span>
                        </div>
                        {sshTunnelStatus === 'connected' ? (
                            <button
                                onClick={handleDisconnect}
                                className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-500/20 transition-colors"
                            >
                                <Square className="h-3 w-3 fill-current" /> Disconnect
                            </button>
                        ) : (
                            <button
                                onClick={handleConnect}
                                disabled={sshTunnelStatus === 'connecting'}
                                className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                            >
                                <Play className="h-3 w-3 fill-current" />
                                {sshTunnelStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                            </button>
                        )}
                    </div>

                    {sshTunnelError && (
                        <div className="flex items-start gap-2 text-red-400 text-xs bg-red-500/10 p-2.5 rounded-lg border border-red-500/20">
                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                            <p className="break-all">{sshTunnelError}</p>
                        </div>
                    )}

                    <div className="space-y-3">
                        <div className="flex gap-3">
                            <div className="flex-1 space-y-1">
                                <label className="text-xs font-medium text-neutral-400">Remote Host</label>
                                <input
                                    type="text"
                                    value={sshTunnelConfig.host}
                                    onChange={(e) => handleChange('host', e.target.value)}
                                    disabled={sshTunnelStatus === 'connected' || sshTunnelStatus === 'connecting'}
                                    placeholder="e.g. 192.168.1.100"
                                    className="w-full rounded-md border border-white/10 bg-black/50 px-3 py-1.5 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                                />
                            </div>
                            <div className="w-24 space-y-1">
                                <label className="text-xs font-medium text-neutral-400">SSH Port</label>
                                <input
                                    type="number"
                                    value={sshTunnelConfig.port}
                                    onChange={(e) => handleChange('port', Number(e.target.value))}
                                    disabled={sshTunnelStatus === 'connected' || sshTunnelStatus === 'connecting'}
                                    className="w-full rounded-md border border-white/10 bg-black/50 px-3 py-1.5 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                                    min="1"
                                    max="65535"
                                />
                            </div>
                        </div>

                        <div className="space-y-1">
                            <label className="text-xs font-medium text-neutral-400">Username</label>
                            <div className="relative">
                                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                                <input
                                    type="text"
                                    value={sshTunnelConfig.username}
                                    onChange={(e) => handleChange('username', e.target.value)}
                                    disabled={sshTunnelStatus === 'connected' || sshTunnelStatus === 'connecting'}
                                    placeholder="e.g. root"
                                    className="w-full rounded-md border border-white/10 bg-black/50 pl-9 pr-3 py-1.5 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                                />
                            </div>
                        </div>

                        <div className="space-y-1">
                            <label className="text-xs font-medium text-neutral-400">Private Key Path</label>
                            <div className="relative flex gap-2">
                                <div className="relative flex-1">
                                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                                    <input
                                        type="text"
                                        value={sshTunnelConfig.privateKeyPath}
                                        onChange={(e) => handleChange('privateKeyPath', e.target.value)}
                                        disabled={sshTunnelStatus === 'connected' || sshTunnelStatus === 'connecting'}
                                        placeholder="/path/to/id_rsa"
                                        className="w-full rounded-md border border-white/10 bg-black/50 pl-9 pr-3 py-1.5 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                                    />
                                </div>
                            </div>
                            <p className="text-[10px] text-neutral-500 mt-1">
                                Enter the absolute path to your SSH private key file.
                            </p>
                        </div>

                        <div className="space-y-1 pt-2 border-t border-white/5">
                            <label className="text-xs font-medium text-neutral-400">Loop Server Target Port (Remote)</label>
                            <input
                                type="number"
                                value={sshTunnelConfig.remotePort}
                                onChange={(e) => handleChange('remotePort', Number(e.target.value))}
                                disabled={sshTunnelStatus === 'connected' || sshTunnelStatus === 'connecting'}
                                className="w-full rounded-md border border-white/10 bg-black/50 px-3 py-1.5 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                                min="1"
                                max="65535"
                            />
                            <p className="text-[10px] text-neutral-500 mt-1">
                                The port that the Loop API server is listening on internally on the remote host (usually 8080).
                            </p>
                        </div>

                    </div>
                </div>
            </motion.div>
        </div>
    );
}
