import { AlertTriangle, Check, ChevronDown, Loader2, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useState } from 'react';
import type { FileToolPayload } from './types';

const GEIST_MONO_STACK = '"Geist Mono","Geist",ui-monospace,SFMono-Regular,Menlo,monospace';

function truncatePath(path: string): string {
  if (!path) return '';
  const parts = path.split(/[/\\]/);
  if (parts.length > 3) {
    return `${parts[0]}/.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return path;
}

interface ToolInfo {
  action: string;
  path: string;
  fullPath: string;
  extras: string;
}

function getToolInfo(toolName: string, args: Record<string, unknown>): ToolInfo {
  if (toolName.includes('list_dir')) {
    const dirPath = (args.dir_path as string) || '.';
    return {
      action: 'list dir',
      path: truncatePath(dirPath),
      fullPath: dirPath,
      extras: args.depth ? `depth ${args.depth}` : ''
    };
  }
  if (toolName.includes('grep_files')) {
    const targetPath = (args.path as string) || '.';
    return {
      action: 'grep files',
      path: truncatePath(targetPath),
      fullPath: targetPath,
      extras: args.pattern ? `pattern: "${args.pattern}"` : ''
    };
  }
  if (toolName.includes('read_file')) {
    const filePath = (args.file_path as string) || 'unknown';
    let extras = '';
    if (args.offset && args.limit) {
      const from = Number(args.offset);
      const to = from + Number(args.limit) - 1;
      extras = `lines ${from} to ${to}`;
    } else if (args.offset) {
      extras = `line ${args.offset}+`;
    }
    return {
      action: 'read file',
      path: truncatePath(filePath),
      fullPath: filePath,
      extras
    };
  }
  
  return {
    action: toolName.split(':').pop() || toolName,
    path: '',
    fullPath: '',
    extras: JSON.stringify(args)
  };
}

export const FileToolCard = memo(function FileToolCard({ payload }: { payload: FileToolPayload }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  const handleCopyOutput = () => {
    navigator.clipboard.writeText(payload.output || payload.error);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 2000);
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    const fullPath = getToolInfo(payload.toolName, payload.args).fullPath;
    if (!fullPath) return;
    navigator.clipboard.writeText(fullPath);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const hasOutput = payload.output.trim().length > 0;
  const hasErrorDetail = payload.status === 'error' && payload.error.trim().length > 0;
  const hasDetails = hasOutput || hasErrorDetail;

  const info = getToolInfo(payload.toolName, payload.args);

  return (
    <div className="mt-1">
      <div 
        className="group relative flex items-center justify-between gap-3 py-1.5 cursor-pointer select-none transition-opacity duration-200 hover:opacity-80"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="text-[13px] font-semibold tracking-wide text-blue-400 whitespace-nowrap" style={{ fontFamily: GEIST_MONO_STACK }}>
            {info.action}
          </span>
          
          {info.path && (
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[12px] text-loop-200 truncate font-mono" title={info.fullPath}>
                {info.path}
              </span>
              <button
                onClick={handleCopyPath}
                className="shrink-0 p-1 text-loop-400 hover:text-loop-100 hover:bg-loop-600/50 rounded transition-colors ml-1"
                title="Copy path"
              >
                {copiedPath ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              </button>
            </div>
          )}
          
          {info.extras && (
            <span className="text-[11px] text-loop-400 whitespace-nowrap ml-auto pr-2" style={{ fontFamily: GEIST_MONO_STACK }}>
              {info.extras}
            </span>
          )}
        </div>
        
        <div className="flex shrink-0 items-center gap-2 pl-2">
          {payload.status === 'success' && <div title="Success"><Check size={14} className="text-emerald-400/80" /></div>}
          {payload.status === 'error' && <div title="Error"><AlertTriangle size={14} className="text-red-400/80" /></div>}
          {payload.status === 'running' && <div title="Running"><Loader2 size={14} className="animate-spin text-blue-400/80" /></div>}
          
          {hasDetails && (
            <ChevronDown size={14} className={`text-loop-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && hasDetails ? (
          <motion.div
            key="tool-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="group/output relative overflow-hidden rounded-lg border border-loop-800/90 bg-loop-900/35 mt-2"
          >
            <button
              type="button"
              className="absolute right-2 top-2 z-10 inline-flex items-center justify-center rounded-md bg-loop-700/80 p-1.5 text-loop-300 opacity-0 backdrop-blur transition-all hover:bg-loop-600 hover:text-loop-100 group-hover/output:opacity-100"
              title="Copy output"
              onClick={handleCopyOutput}
            >
              {copiedOutput ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>

            {hasOutput ? (
              <pre
                className="max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 text-[11px] leading-relaxed text-loop-200 scrollbar-thin"
                style={{ fontFamily: GEIST_MONO_STACK }}
              >
                {payload.output}
              </pre>
            ) : null}

            {hasErrorDetail ? (
              <div className="px-4 py-3 text-[12px] leading-relaxed text-red-300">
                {payload.error}
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
});
