import { AlertTriangle, Check, ChevronDown, Loader2, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useMemo, useState } from 'react';
import type { CommandToolPayload } from './types';

const GEIST_MONO_STACK = '"Geist Mono","Geist",ui-monospace,SFMono-Regular,Menlo,monospace';

export const CommandToolCard = memo(function CommandToolCard({ payload }: { payload: CommandToolPayload }) {
  const [expanded, setExpanded] = useState(true);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(payload.command);
    setCopiedCommand(true);
    setTimeout(() => setCopiedCommand(false), 2000);
  };

  const handleCopyOutput = () => {
    navigator.clipboard.writeText(payload.output || payload.error);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 2000);
  };

  const hasOutput = payload.output.trim().length > 0;
  const hasErrorDetail = payload.status === 'error' && payload.error.trim().length > 0;
  const hasDetails = hasOutput || hasErrorDetail;
  const statusLabel = useMemo(() => {
    if (payload.status === 'success') {
      return 'Success';
    }
    if (payload.status === 'error') {
      return 'Error';
    }
    return 'Running';
  }, [payload.status]);
  const executedAtLabel = useMemo(() => {
    if (!payload.executedAt) {
      return '';
    }
    const timestamp = new Date(payload.executedAt);
    if (Number.isNaN(timestamp.getTime())) {
      return '';
    }
    return timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }, [payload.executedAt]);

  return (
    <div className="mt-2 overflow-hidden rounded-xl bg-neutral-800/90">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="group relative flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <span
              className="text-[11px] font-semibold tracking-wide text-neutral-300"
              style={{ fontFamily: GEIST_MONO_STACK }}
            >
              {payload.shellLabel || 'bash'}
            </span>
            <span className="text-[13px] text-neutral-400" style={{ fontFamily: GEIST_MONO_STACK }}>
              $
            </span>
          </div>
          <div className="relative min-w-0 flex-1">
            <pre
              className="m-0 overflow-x-hidden text-ellipsis whitespace-nowrap pb-0.5 text-[13px] leading-relaxed text-neutral-100 scrollbar-hidden group-hover:overflow-x-auto group-hover:text-clip"
              style={{ fontFamily: GEIST_MONO_STACK }}
            >
              <span className="pr-6">{payload.command || '(no command)'}</span>
            </pre>
            <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-8 bg-gradient-to-l from-neutral-800/90 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-700/50 hover:text-neutral-100"
            title="Copy command"
            onClick={handleCopyCommand}
          >
            {copiedCommand ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
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
            key="command-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="group/output relative overflow-hidden"
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
                className="max-h-80 overflow-auto whitespace-pre-wrap px-4 pb-2 text-[11px] leading-relaxed text-neutral-300 scrollbar-thin"
                style={{ fontFamily: GEIST_MONO_STACK }}
              >
                {payload.output}
              </pre>
            ) : null}

            {hasErrorDetail ? (
              <div className="px-4 pb-2 text-[12px] leading-relaxed text-red-300">
                {payload.error}
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex items-center justify-between gap-2 border-t border-neutral-500/40 px-4 pb-3 pt-2 text-xs">
        <span className="text-[11px] text-neutral-400">
          {executedAtLabel ? `Executed ${executedAtLabel}` : ''}
        </span>
        {payload.status === 'success' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-neutral-300">
            <Check size={13} className="text-emerald-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'error' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-neutral-300">
            <AlertTriangle size={13} className="text-red-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'running' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-neutral-300">
            <Loader2 size={13} className="animate-spin text-blue-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});
