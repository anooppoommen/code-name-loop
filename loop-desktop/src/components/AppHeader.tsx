import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface AppHeaderProps {
  workspaceName: string;
  conversationTitle: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function AppHeader({ workspaceName, conversationTitle, isSidebarOpen, onToggleSidebar }: AppHeaderProps) {
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
            {conversationTitle || 'New thread'}
          </span>
        </div>
      </div>
    </header>
  );
}
