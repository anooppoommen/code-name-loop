import { AlertTriangle, Check, ChevronDown, Loader2, Copy, FolderSearch, FileSearch, FileText } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useMemo, useState } from 'react';
import type { FileToolPayload } from './types';

const GEIST_MONO_STACK = '"Geist Mono","Geist",ui-monospace,SFMono-Regular,Menlo,monospace';

function getToolIcon(toolName: string) {
  if (toolName.includes('list_dir')) return <FolderSearch size={14} className="text-blue-400" />;
  if (toolName.includes('grep_files')) return <FileSearch size={14} className="text-emerald-400" />;
  return <FileText size={14} className="text-amber-400" />;
}

function formatArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName.includes('list_dir')) {
    return `path: ${args.dir_path || '.'}`;
  }
  if (toolName.includes('grep_files')) {
    const pattern = args.pattern ? `"${args.pattern}"` : '';
    const path = args.path ? ` in ${args.path}` : '';
    return `pattern: ${pattern}${path}`;
  }
  if (toolName.includes('read_file')) {
    const offset = args.offset ? `, offset: ${args.offset}` : '';
    const limit = args.limit ? `, limit: ${args.limit}` : '';
    return `file: ${args.file_path || 'unknown'}${offset}${limit}`;
  }
  return JSON.stringify(args);
}

export const FileToolCard = memo(function FileToolCard({ payload }: { payload: FileToolPayload }) {
  const [expanded, setExpanded] = useState(true);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const handleCopyOutput = () => {
    navigator.clipboard.writeText(payload.output || payload.error);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 2000);
  };

  const hasOutput = payload.output.trim().length > 0;
  const hasErrorDetail = payload.status === 'error' && payload.error.trim().length > 0;
  const hasDetails = hasOutput || hasErrorDetail;
  const statusLabel = useMemo(() => {
    if (payload.status === 'success') return 'Success';
    if (payload.status === 'error') return 'Error';
    return 'Running';
  }, [payload.status]);
  const executedAtLabel = useMemo(() => {
    if (!payload.executedAt) return '';
    const timestamp = new Date(payload.executedAt);
    if (Number.isNaN(timestamp.getTime())) return '';
    return timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [payload.executedAt]);

  const argsDisplay = formatArgs(payload.toolName, payload.args);

  return (
    <div className="mt-2 overflow-hidden rounded-xl bg-neutral-800/90">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-700/50">
        <div className="group relative flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2">
            {getToolIcon(payload.toolName)}
            <span
              className="text-[12px] font-semibold tracking-wide text-neutral-200"
              style={{ fontFamily: GEIST_MONO_STACK }}
            >
              {payload.toolName.split(':').pop() || payload.toolName}
            </span>
          </div>
          <div className="h-4 w-px bg-neutral-700 mx-1"></div>
          <div className="relative min-w-0 flex-1">
            <pre
              className="m-0 overflow-x-hidden text-ellipsis whitespace-nowrap pb-0.5 text-[12px] text-neutral-400 scrollbar-hidden group-hover:overflow-x-auto group-hover:text-clip"
              style={{ fontFamily: GEIST_MONO_STACK }}
            >
              <span className="pr-6">{argsDisplay}</span>
            </pre>
            <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-8 bg-gradient-to-l from-neutral-800/90 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasDetails ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-700/50 hover:text-neutral-100"
              onClick={() => setExpanded((prev) => !prev)}
            >
              <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          ) : null}
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
            className="group/output relative overflow-hidden bg-neutral-900/50"
          >
            <button
              type="button"
              className="absolute right-2 top-2 z-10 inline-flex items-center justify-center rounded-md bg-neutral-800/80 p-1.5 text-neutral-400 opacity-0 backdrop-blur transition-all hover:bg-neutral-700 hover:text-neutral-100 group-hover/output:opacity-100"
              title="Copy output"
              onClick={handleCopyOutput}
            >
              {copiedOutput ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>

            {hasOutput ? (
              <pre
                className="max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 text-[11px] leading-relaxed text-neutral-300 scrollbar-thin"
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

      <div className="flex items-center justify-between gap-2 border-t border-neutral-700/50 bg-neutral-800/50 px-4 py-2 text-xs">
        <span className="text-[11px] text-neutral-500">
          {executedAtLabel ? `Executed ${executedAtLabel}` : ''}
        </span>
        {payload.status === 'success' ? (
          <div className="inline-flex items-center gap-1.5 text-[12px] text-neutral-400">
            <Check size={12} className="text-emerald-400/80" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'error' ? (
          <div className="inline-flex items-center gap-1.5 text-[12px] text-neutral-400">
            <AlertTriangle size={12} className="text-red-400/80" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'running' ? (
          <div className="inline-flex items-center gap-1.5 text-[12px] text-neutral-400">
            <Loader2 size={12} className="animate-spin text-blue-400/80" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});
