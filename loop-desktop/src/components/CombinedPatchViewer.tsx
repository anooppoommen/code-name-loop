import { useMemo, useState } from 'react';
import { Undo2, X } from 'lucide-react';
import { FilePatchView } from './PatchViewer';
import type { ApplyPatchResult } from '../hooks/useConversations';
import { usePatchRevertStore } from '../stores/patchRevertStore';
import { buildCombinedPatch } from '../utils/patches';
import type { PatchFile } from '../utils/patches';

const EMPTY_PATHS: string[] = [];

function actionDescription(action: 'Update' | 'Add' | 'Delete' | 'Move'): string {
  switch (action) {
    case 'Add':
      return 'Added file';
    case 'Delete':
      return 'Deleted file';
    case 'Move':
      return 'Moved file';
    default:
      return 'Updated file';
  }
}

export function CombinedPatchViewer({
  patchKey,
  patchId,
  patches,
  checkpointId,
  revertedPaths,
  conversationId,
  applyPatchToWorkspace,
}: {
  patchKey: string;
  patchId?: string;
  patches: string[];
  checkpointId?: string;
  revertedPaths?: string[];
  conversationId: string;
  applyPatchToWorkspace: (
    conversationId: string,
    files: PatchFile[],
    message: string,
    baseCheckpointId?: string,
    patchId?: string,
  ) => Promise<ApplyPatchResult | null>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const optimisticEntry = usePatchRevertStore((state) => state.byPatchKey[patchKey]);
  const optimisticRevertedPaths = optimisticEntry?.paths ?? EMPTY_PATHS;
  const markOptimisticReverted = usePatchRevertStore((state) => state.markOptimistic);

  const combinedFiles = useMemo(() => buildCombinedPatch(patches), [patches]);
  const revertedPathSet = useMemo(
    () => new Set([...(revertedPaths ?? []), ...optimisticRevertedPaths]),
    [optimisticRevertedPaths, revertedPaths],
  );
  const unavailableDeletedPaths = useMemo(
    () => new Set(combinedFiles.filter((file) => file.action === 'Delete' && !checkpointId).map((file) => file.path)),
    [checkpointId, combinedFiles],
  );
  const selectableFiles = useMemo(
    () => combinedFiles.filter((file) => !unavailableDeletedPaths.has(file.path) && !revertedPathSet.has(file.path)),
    [combinedFiles, unavailableDeletedPaths, revertedPathSet],
  );

  if (combinedFiles.length === 0) {
    return null;
  }

  const handleOpenModal = () => {
    setSelectedFiles(new Set(selectableFiles.map((file) => file.path)));
    setModalOpen(true);
  };

  const toggleFile = (path: string) => {
    if (unavailableDeletedPaths.has(path) || revertedPathSet.has(path)) return;
    const next = new Set(selectedFiles);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedFiles(next);
  };

  const handleUndo = async () => {
    const filesToUndo = combinedFiles.filter(
      (file) => selectedFiles.has(file.path) && !unavailableDeletedPaths.has(file.path) && !revertedPathSet.has(file.path),
    );
    if (filesToUndo.length === 0) return;

    const fileNames = filesToUndo.map(f => `\`${f.path}\``).join(', ');
    const prompt = `System: The user manually reverted changes to the following files from a previous step:\n\n${fileNames}`;

    setModalOpen(false);
    const result = await applyPatchToWorkspace(conversationId, filesToUndo, prompt, checkpointId, patchId);
    const returnedPaths = result?.workspaceChange?.file_paths ?? filesToUndo.map((file) => file.path);
    if (returnedPaths.length > 0) {
      markOptimisticReverted(patchKey, returnedPaths);
    }
  };

  return (
    <div className="flex flex-col gap-2 mt-3 px-2">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[12px] font-medium text-loop-400">Combined changes in this turn</div>
        <button 
          onClick={handleOpenModal}
          disabled={selectableFiles.length === 0}
          className="flex items-center gap-1.5 text-[11px] font-medium text-loop-300 hover:text-white px-2 py-1 rounded bg-loop-700/40 hover:bg-loop-600/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-loop-300 disabled:hover:bg-loop-700/40"
          title={selectableFiles.length === 0
            ? (combinedFiles.some((file) => revertedPathSet.has(file.path))
              ? 'This change set has already been reverted.'
              : 'This change set cannot be reverted because the source checkpoint is unavailable.')
            : 'Undo selected changes from this step'}
        >
          <Undo2 size={12} />
          Undo Changes
        </button>
      </div>

      {combinedFiles.map((file, i) => (
        <FilePatchView
          key={`${file.previousPath ?? file.path}:${file.path}:${i}`}
          file={file}
          statusBadgeLabel={revertedPathSet.has(file.path) ? 'Undone' : undefined}
        />
      ))}

      {modalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-loop-800 border border-loop-600/80 rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden text-sm">
            <div className="px-4 py-3 border-b border-loop-600 flex justify-between items-center font-medium text-loop-100">
              Revert Changes
              <button onClick={() => setModalOpen(false)} className="text-loop-400 hover:text-white"><X size={16} /></button>
            </div>
            <div className="p-4 text-loop-300 text-[13px] leading-relaxed bg-loop-900/30">
              Select the files you want to revert. Updates and moves reverse the recorded hunks. Reverting an added file removes the entire current file. Reverting a deleted file restores the version captured before this turn and may overwrite any file now at that path.
            </div>
            <div className="px-4 py-2 flex flex-col gap-1.5 max-h-60 overflow-y-auto scrollbar-thin">
              {combinedFiles.map(f => (
                 <label
                   key={f.path}
                   className={`flex items-center gap-3 text-[13px] px-2 py-1.5 rounded transition-colors border border-transparent ${
                     unavailableDeletedPaths.has(f.path)
                       ? 'cursor-not-allowed text-loop-500 bg-loop-900/30'
                       : revertedPathSet.has(f.path)
                         ? 'cursor-not-allowed text-loop-500 bg-loop-900/30'
                       : 'cursor-pointer text-loop-200 hover:bg-loop-700/40 hover:border-loop-600/40'
                   }`}
                 >
                   <input 
                     type="checkbox" 
                     disabled={unavailableDeletedPaths.has(f.path) || revertedPathSet.has(f.path)}
                     checked={selectedFiles.has(f.path)} 
                     onChange={() => toggleFile(f.path)}
                     className="accent-blue-500 w-4 h-4 cursor-pointer"
                   />
                   <div className="min-w-0 flex-1">
                     <div className="truncate font-medium">{f.path}</div>
                     <div className="text-[11px] text-loop-400">
                       {unavailableDeletedPaths.has(f.path)
                         ? 'Deleted file restore is unavailable because the source checkpoint is missing.'
                         : revertedPathSet.has(f.path)
                           ? 'Already reverted from this step.'
                         : actionDescription(f.action)}
                     </div>
                   </div>
                 </label>
              ))}
            </div>
            <div className="p-4 border-t border-loop-600/80 flex justify-end gap-2 bg-loop-800/80">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded font-medium text-loop-300 hover:bg-loop-700/80 hover:text-white transition-colors text-[13px]">Cancel</button>
              <button onClick={handleUndo} disabled={selectedFiles.size === 0} className="px-4 py-2 rounded font-medium bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/20 hover:border-red-500/40 transition-all text-[13px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                <Undo2 size={14} />
                Undo Selected
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
