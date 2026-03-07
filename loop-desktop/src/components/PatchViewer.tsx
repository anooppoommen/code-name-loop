import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { parsePatchData } from '../utils/patches';
import type { PatchFile } from '../utils/patches';
import { getPatchFileIcon } from './patchViewerFileIcon';

export function PatchViewer({ patchText }: { patchText: string }) {
  const files = useMemo(() => parsePatchData(patchText), [patchText]);

  if (files.length === 0) {
    return (
      <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md px-3 py-2 text-xs leading-relaxed scrollbar-thin bg-loop-800/55 text-loop-300">{patchText}</pre>
    );
  }

  return (
    <div className="flex flex-col gap-2 mt-2">
      {files.map((file, i) => (
        <FilePatchView key={i} file={file} />
      ))}
    </div>
  );
}

export function FilePatchView({ file, statusBadgeLabel }: { file: PatchFile; statusBadgeLabel?: string }) {
  const [expanded, setExpanded] = useState(false);
  const badgeLabel = file.action === 'Move' ? 'Moved' : file.action !== 'Update' ? file.action : null;
  const emptyStateText =
    file.action === 'Move'
      ? 'File moved without text changes.'
      : file.action === 'Delete'
        ? 'File deleted with no textual diff available.'
        : file.action === 'Add'
          ? 'File added with no textual diff available.'
          : 'No textual diff available.';

  return (
    <div className="flex flex-col rounded-lg border border-loop-600/60 bg-loop-800/55 overflow-hidden">
      <button
        type="button"
        className="flex items-center justify-between px-3 py-2 hover:bg-loop-700/55 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-loop-300">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
          {getPatchFileIcon(file.path)}
          <span className="truncate text-[13px] font-medium text-loop-200">
            {file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path}
          </span>
          {badgeLabel ? (
            <span className="text-[10px] uppercase font-bold text-loop-300 ml-1 bg-loop-700 px-1.5 rounded">
              {badgeLabel}
            </span>
          ) : null}
          {statusBadgeLabel ? (
            <span className="text-[10px] uppercase font-bold text-loop-300 ml-1 bg-loop-700/80 border border-loop-500/40 px-1.5 rounded">
              {statusBadgeLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 shrink-0 text-[12px] font-mono">
          <span className="text-green-400">+{file.added}</span>
          <span className="text-red-400">-{file.removed}</span>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="border-t border-loop-600/60 bg-loop-800 overflow-x-auto text-[12px] font-mono whitespace-pre flex flex-col"
          >
            {file.hunks.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-loop-400">{emptyStateText}</div>
            ) : (
            <div className="flex flex-col min-w-max w-full">
          {file.hunks.map((hunk, idx) => (
            <div key={idx} className="flex flex-col">
              <div className="px-3 py-1 bg-blue-500/10 text-blue-200 text-[11px] border-b border-loop-600/60 w-full">
                {hunk.header}
              </div>
              <div className="flex flex-col py-1">
                {hunk.lines.map((line, lIdx) => (
                  <div
                    key={lIdx}
                    className={`flex items-stretch w-full ${line.type === 'add'
                      ? 'bg-green-500/10 text-green-300'
                      : line.type === 'remove'
                        ? 'bg-red-500/10 text-red-300'
                        : 'text-loop-200'
                      }`}
                  >
                    <div
                      className="flex shrink-0 items-center select-none border-r border-loop-600/50 text-[10px] text-loop-400 sticky left-0 z-10 bg-loop-800"
                    >
                      <div className="w-8 text-right pr-1.5">{line.oldLn ?? ' '}</div>
                      <div className="w-8 text-right pr-1.5">{line.newLn ?? ' '}</div>
                      <div className={`w-5 text-center text-[12px] font-bold ${line.type === 'add' ? 'text-green-400' : line.type === 'remove' ? 'text-red-400' : 'text-loop-400'}`}>
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </div>
                    </div>
                    <div className="pl-2 pr-3 whitespace-pre">
                      {(line.text.startsWith('+') || line.text.startsWith('-') || line.text.startsWith(' ')) ? line.text.slice(1) : line.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
            </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
