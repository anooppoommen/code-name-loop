import { useState } from 'react';
import { ChevronDown, ChevronUp, Settings2 } from 'lucide-react';

interface SidebarSettingsProps {
  backendUrl: string;
  onBackendUrlChange: (value: string) => void;
  hideLifecycle: boolean;
  onHideLifecycleChange: (value: boolean) => void;
  showMascot: boolean;
  onShowMascotChange: (value: boolean) => void;
}

export function SidebarSettings({
  backendUrl,
  onBackendUrlChange,
  hideLifecycle,
  onHideLifecycleChange,
  showMascot,
  onShowMascotChange,
}: SidebarSettingsProps) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <section className="mt-auto flex flex-col border-t border-loop-700/60 pt-2">
      <button
        type="button"
        className="group flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-loop-300 transition-colors hover:bg-loop-700 hover:text-loop-200"
        onClick={() => setShowSettings((prev) => !prev)}
      >
        <span className="inline-flex items-center gap-3">
          <Settings2 size={15} className="text-loop-400 group-hover:text-loop-200" />
          Settings
        </span>
        {showSettings ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {showSettings && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-loop-800/50 bg-loop-900 p-3 text-[12px] shadow-sm">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-loop-500">API</label>
            <input
              className="w-full select-text rounded-md border border-loop-700/50 bg-loop-900 px-2 py-1.5 text-loop-300 outline-none transition-colors focus:border-blue-500/50 focus:bg-loop-800 focus:ring-1 focus:ring-blue-500/50"
              value={backendUrl}
              onChange={(event) => onBackendUrlChange(event.target.value)}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pt-1 text-loop-400 transition-colors hover:text-loop-300">
            <input
              type="checkbox"
              checked={hideLifecycle}
              onChange={(e) => onHideLifecycleChange(e.target.checked)}
              className="cursor-pointer rounded border-loop-700 bg-loop-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-loop-900"
            />
            <span className="text-[11px] font-medium uppercase tracking-wider">Hide Lifecycle</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 pt-1 text-loop-400 transition-colors hover:text-loop-300">
            <input
              type="checkbox"
              checked={showMascot}
              onChange={(e) => onShowMascotChange(e.target.checked)}
              className="cursor-pointer rounded border-loop-700 bg-loop-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-loop-900"
            />
            <span className="text-[11px] font-medium uppercase tracking-wider">Show Mascot</span>
          </label>
        </div>
      )}
    </section>
  );
}
