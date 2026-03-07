import { AlertTriangle, Check, ChevronDown, Loader2, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { CommandToolPayload } from './types';
import { COLLAPSIBLE_SPRING, useThrottledText } from '../activity-feed/ActivityMotion';

const GEIST_MONO_STACK = '"Geist Mono","Geist",ui-monospace,SFMono-Regular,Menlo,monospace';

export const CommandToolCard = memo(function CommandToolCard({ payload }: { payload: CommandToolPayload }) {
  const [expanded, setExpanded] = useState(true);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const throttledLiveOutput = useThrottledText(payload.output, payload.status === 'running' || payload.status === 'waiting');
  const deferredOutput = useDeferredValue(payload.output);
  const liveOutput = useDeferredValue(throttledLiveOutput);
  const isLive = payload.status === 'running' || payload.status === 'waiting';

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

  const activeOutput = isLive ? liveOutput : deferredOutput;
  const hasOutput = activeOutput.trim().length > 0;
  const hasErrorDetail = payload.status === 'error' && payload.error.trim().length > 0;
  const hasDetails = hasOutput || hasErrorDetail;
  const outputPreviewLines = useMemo(() => buildLiveOutputPreviewLines(liveOutput), [liveOutput]);
  const statusLabel = useMemo(() => {
    if (payload.status === 'waiting') {
      return 'Waiting for permission';
    }
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

  useEffect(() => {
    if (isLive) {
      setExpanded(false);
      return;
    }

    if (!hasDetails) {
      setExpanded(false);
      return;
    }

    setExpanded(deferredOutput.length <= 4000);
  }, [deferredOutput.length, hasDetails, isLive]);

  return (
    <div className="mt-2 overflow-hidden rounded-xl bg-loop-700">
      <div className="border-b border-loop-600/50 flex items-center justify-between gap-3 px-4 py-3">
        <div className=" group relative flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <span
              className="text-[11px] font-semibold tracking-wide text-loop-200"
              style={{ fontFamily: GEIST_MONO_STACK }}
            >
              {payload.shellLabel || 'bash'}
            </span>
            <span className="text-[13px] text-loop-300" style={{ fontFamily: GEIST_MONO_STACK }}>
              $
            </span>
          </div>
          <div className="relative min-w-0 flex-1">
            <pre
              className="m-0 overflow-x-hidden text-ellipsis whitespace-nowrap pb-0.5 text-[13px] leading-relaxed text-loop-100 scrollbar-hidden group-hover:overflow-x-auto group-hover:text-clip"
              style={{ fontFamily: GEIST_MONO_STACK }}
            >
              <span className="pr-6">{payload.command || '(no command)'}</span>
            </pre>
            <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-8 bg-gradient-to-l from-loop-700/85 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-loop-300 transition-colors hover:bg-loop-600/50 hover:text-loop-100"
            title="Copy command"
            onClick={handleCopyCommand}
          >
            {copiedCommand ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
          {hasDetails && !isLive ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-loop-300 transition-colors hover:bg-loop-600/50 hover:text-loop-100"
              onClick={() => setExpanded((prev) => !prev)}
            >
              <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          ) : null}
        </div>
      </div>

      {isLive ? (
        hasOutput ? (
          <div className="border-t border-loop-600/50 px-4 py-2">
            <div className="h-[88px] overflow-hidden">
              <pre
                className="m-0 whitespace-pre-wrap text-[11px] leading-[22px] text-loop-300"
                style={{ fontFamily: GEIST_MONO_STACK }}
              >
                {outputPreviewLines.join('\n')}
              </pre>
            </div>
          </div>
        ) : null
      ) : (
        <AnimatePresence initial={false}>
          {expanded && hasDetails ? (
            <motion.div
              key="command-details"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={COLLAPSIBLE_SPRING}
              className="group/output relative overflow-hidden"
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
                  className="max-h-80 overflow-auto whitespace-pre-wrap px-4 pb-2 text-[11px] leading-relaxed text-loop-200 scrollbar-thin"
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
      )}

      <div className="flex items-center justify-between gap-2 bg-loop-700 px-4 pb-3 pt-2 text-xs">
        <span className="text-[11px] text-loop-300">
          {executedAtLabel ? `Executed ${executedAtLabel}` : ''}
        </span>
        {payload.status === 'success' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-loop-200">
            <Check size={13} className="text-emerald-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'error' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-loop-200">
            <AlertTriangle size={13} className="text-red-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'running' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-loop-200">
            <Loader2 size={13} className="animate-spin text-blue-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {payload.status === 'waiting' ? (
          <div className="inline-flex items-center gap-1.5 text-[13px] text-loop-200">
            <Loader2 size={13} className="text-amber-300" />
            <span>{statusLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function buildLiveOutputPreviewLines(output: string): string[] {
  const trimmed = output.trimEnd();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed
    .split(/\r\n|\n|\r/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return lines.slice(-4);
}
