import { PanelLeftClose, PanelLeftOpen, Server, Activity } from 'lucide-react';
import type { SshTunnelStatus } from '../hooks/useLoopDesktop.types';

interface AppHeaderProps {
  workspaceName: string;
  conversationTitle: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  sshTunnelStatus: SshTunnelStatus;
  onOpenConnectionSettings: () => void;
  isProfiling?: boolean;
  onToggleProfiling?: () => void;
}

export function AppHeader({
  workspaceName,
  conversationTitle,
  isSidebarOpen,
  onToggleSidebar,
  sshTunnelStatus,
  onOpenConnectionSettings,
  isProfiling,
  onToggleProfiling,
}: AppHeaderProps) {
  return (
    <header className={`drag-region flex items-center justify-between h-[40px] bg-transparent shrink-0 transition-spacing duration-200 pr-4 ${isSidebarOpen ? 'pl-4' : 'pl-[72px]'}`}>
      <div className="flex items-center gap-2 pointer-events-auto">
        <button
          onClick={onToggleSidebar}
          className="no-drag flex items-center justify-center rounded-md p-1.5 text-loop-400 transition-colors hover:bg-loop-700/50 hover:text-loop-200"
          title={isSidebarOpen ? "Collapse Sidebar" : "Open Sidebar"}
        >
          {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <div className="flex items-center gap-1.5 overflow-hidden text-[12px] text-loop-400 font-medium ml-1">
          <span className="max-w-[140px] truncate">{workspaceName}</span>
          <span className="opacity-50">/</span>
          <span className="max-w-[200px] truncate text-loop-300">
            {conversationTitle || 'New thread'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 pointer-events-auto">
        {onToggleProfiling && (
          <button
            onClick={onToggleProfiling}
            className={`no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              isProfiling ? 'bg-emerald-500/20 text-emerald-500' : 'text-loop-400 hover:bg-loop-700/50'
            }`}
            title={isProfiling ? "Stop Profiling & Download" : "Start Profiling"}
          >
            <Activity className="h-3.5 w-3.5" />
            {isProfiling ? 'Recording...' : 'Profile'}
          </button>
        )}
        <button
          onClick={onOpenConnectionSettings}
          className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors hover:bg-loop-700/50"
          title="Connection Settings"
        >
          <Server className="h-3.5 w-3.5 opacity-70" />
          {sshTunnelStatus === 'connected' ? (
            <span className="text-emerald-500">Connected</span>
          ) : sshTunnelStatus === 'connecting' ? (
            <span className="text-amber-500">Connecting</span>
          ) : (
            <span className="text-loop-400">Local</span>
          )}
        </button>
      </div>
    </header>
  );
}
