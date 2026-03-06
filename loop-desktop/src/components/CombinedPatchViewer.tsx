import { useMemo } from 'react';
import { FilePatchView } from './PatchViewer';
import { buildCombinedPatch } from '../utils/patches';

export function CombinedPatchViewer({ patches }: { patches: string[] }) {
  const combinedFiles = useMemo(() => buildCombinedPatch(patches), [patches]);

  if (combinedFiles.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 mt-3 px-2">
      <div className="text-[12px] font-medium text-loop-400 mb-1">Combined changes in this turn</div>
      {combinedFiles.map((file, i) => (
        <FilePatchView key={`${file.previousPath ?? file.path}:${file.path}:${i}`} file={file} />
      ))}
    </div>
  );
}
