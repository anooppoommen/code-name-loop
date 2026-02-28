import { CheckCircle2, LoaderCircle, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface AppHeaderProps {
  workspaceName: string;
  conversationTitle: string;
  isSending: boolean;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function AppHeader({ workspaceName, conversationTitle, isSending, isSidebarOpen, onToggleSidebar }: AppHeaderProps) {
  return (
    <header className={`drag-region flex items-center justify-between h-[40px] bg-transparent shrink-0 transition-spacing duration-200 pr-4 ${isSidebarOpen ? 'pl-4' : 'pl-[72px]'}`}>
      <div className="flex items-center gap-2 pointer-events-auto">
        <button
          onClick={onToggleSidebar}
          className="no-drag flex items-center justify-center rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-700/50 hover:text-neutral-200"
          title={isSidebarOpen ? "Collapse Sidebar" : "Open Sidebar"}
        >
          {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <div className="flex items-center gap-1.5 overflow-hidden text-[12px] text-neutral-400 font-medium ml-1">
          <span className="max-w-[140px] truncate">{workspaceName}</span>
          <span className="opacity-50">/</span>
          <span className="max-w-[200px] truncate text-neutral-300">
            {conversationTitle || 'No active thread'}
          </span>
        </div>
      </div>

      <div className="no-drag flex items-center pointer-events-auto">
        <div
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur-md transition-colors ${isSending
            ? 'bg-blue-500/10 text-blue-400 ring-1 ring-inset ring-blue-500/20'
            : 'bg-neutral-800/50 text-neutral-400 ring-1 ring-inset ring-neutral-700/50'
            }`}
        >
          {isSending ? (
            <>
              <LoaderCircle size={14} className="animate-spin" />
              <span>Running...</span>
            </>
          ) : (
            <>
              <CheckCircle2 size={14} />
              <span>Ready</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
