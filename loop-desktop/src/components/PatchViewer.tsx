import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FileJson, FileText, FileImage, File } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export interface PatchFile {
  action: string;
  path: string;
  added: number;
  removed: number;
  hunks: PatchHunk[];
}

export interface PatchHunk {
  header: string;
  lines: PatchLine[];
}

export interface PatchLine {
  type: 'add' | 'remove' | 'context';
  text: string;
  oldLn?: number;
  newLn?: number;
}

function parsePatchData(patchText: string): PatchFile[] {
  const lines = patchText.split('\n');
  const files: PatchFile[] = [];
  let currentFile: PatchFile | null = null;
  let currentHunk: (PatchHunk & { oldStart: number; newStart: number }) | null = null;

  for (const line of lines) {
    if (line.startsWith('*** ')) {
      const match = line.match(/\*\*\* (Update|Add|Delete) File:\s+(.*)/);
      if (match) {
        currentFile = {
          action: match[1],
          path: match[2],
          added: 0,
          removed: 0,
          hunks: [],
        };
        files.push(currentFile);
        currentHunk = null;
      }
      else if (line.trim() === '*** End Patch') {
        break;
      }
    } else if (line.startsWith('@@ ') && currentFile) {
      const match = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      currentHunk = {
        header: line,
        lines: [],
        oldStart: match ? parseInt(match[1], 10) : 1,
        newStart: match ? parseInt(match[2], 10) : 1,
      };
      currentFile.hunks.push(currentHunk);
    } else if (currentHunk) {
      if (line.startsWith('+') && currentFile) {
        currentFile.added++;
        currentHunk.lines.push({ type: 'add', text: line, newLn: currentHunk.newStart++ });
      } else if (line.startsWith('-') && currentFile) {
        currentFile.removed++;
        currentHunk.lines.push({ type: 'remove', text: line, oldLn: currentHunk.oldStart++ });
      } else if (line.startsWith('\\')) {
        currentHunk.lines.push({
          type: 'context',
          text: line,
          oldLn: undefined,
          newLn: undefined,
        });
      } else {
        currentHunk.lines.push({
          type: 'context',
          text: line,
          oldLn: currentHunk.oldStart++,
          newLn: currentHunk.newStart++,
        });
      }
    }
  }
  return files;
}

function getFileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp'].includes(ext)) {
    return <FileCode2 size={14} className="text-blue-400" />;
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileJson size={14} className="text-yellow-400" />;
  }
  if (['md', 'txt', 'csv'].includes(ext)) {
    return <FileText size={14} className="text-neutral-400" />;
  }
  if (['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) {
    return <FileImage size={14} className="text-purple-400" />;
  }
  return <File size={14} className="text-neutral-500" />;
}

export function PatchViewer({ patchText }: { patchText: string }) {
  const files = useMemo(() => parsePatchData(patchText), [patchText]);

  if (files.length === 0) {
    return (
      <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md px-3 py-2 text-xs leading-relaxed scrollbar-thin bg-neutral-900/50 text-neutral-400">{patchText}</pre>
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

function FilePatchView({ file }: { file: PatchFile }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col rounded-lg border border-neutral-700/60 bg-neutral-900/50 overflow-hidden">
      <button
        type="button"
        className="flex items-center justify-between px-3 py-2 hover:bg-neutral-800/50 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-neutral-400">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
          {getFileIcon(file.path)}
          <span className="truncate text-[13px] font-medium text-neutral-200">
            {file.path}
          </span>
          {file.action !== 'Update' && (
            <span className="text-[10px] uppercase font-bold text-neutral-500 ml-1 bg-neutral-800 px-1.5 rounded">
              {file.action}
            </span>
          )}
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
            className="border-t border-neutral-700/60 bg-[#1e1e1e] overflow-x-auto text-[12px] font-mono whitespace-pre flex flex-col"
          >
          {file.hunks.map((hunk, idx) => (
            <div key={idx} className="flex flex-col min-w-max">
              <div className="px-3 py-1 bg-blue-500/10 text-blue-300 text-[11px] border-b border-neutral-700/60 w-full">
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
                        : 'text-neutral-300'
                      }`}
                  >
                    <div
                      className={`flex shrink-0 items-center select-none border-r border-neutral-700/50 text-[10px] text-neutral-500 sticky left-0 z-10 ${
                        line.type === 'add'
                          ? 'bg-[#1e2e24]'
                          : line.type === 'remove'
                            ? 'bg-[#332222]'
                            : 'bg-[#1a1a1a]'
                      }`}
                    >
                      <div className="w-8 text-right pr-1.5">{line.oldLn ?? ' '}</div>
                      <div className="w-8 text-right pr-1.5">{line.newLn ?? ' '}</div>
                      <div className={`w-5 text-center text-[12px] font-bold ${line.type === 'add' ? 'text-green-500' : line.type === 'remove' ? 'text-red-500' : 'text-neutral-500'}`}>
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
