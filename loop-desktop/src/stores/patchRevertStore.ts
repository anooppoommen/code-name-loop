import { create } from 'zustand';

interface PatchRevertEntry {
  paths: string[];
  authoritativeSeen: boolean;
}

interface PatchRevertStoreState {
  byPatchKey: Record<string, PatchRevertEntry>;
  markOptimistic: (patchKey: string, paths: string[]) => void;
  syncAuthoritative: (patchKey: string, paths?: string[]) => void;
}

function samePaths(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export const usePatchRevertStore = create<PatchRevertStoreState>((set) => ({
  byPatchKey: {},
  markOptimistic: (patchKey, paths) =>
    set((state) => {
      if (!patchKey || paths.length === 0) {
        return state;
      }
      const current = state.byPatchKey[patchKey];
      const nextPaths = Array.from(new Set([...(current?.paths ?? []), ...paths]));
      if (samePaths(current?.paths, nextPaths)) {
        return state;
      }
      return {
        byPatchKey: {
          ...state.byPatchKey,
          [patchKey]: {
            paths: nextPaths,
            authoritativeSeen: current?.authoritativeSeen ?? false,
          },
        },
      };
    }),
  syncAuthoritative: (patchKey, paths) =>
    set((state) => {
      if (!patchKey) {
        return state;
      }
      const current = state.byPatchKey[patchKey];
      if (paths && paths.length > 0) {
        if (current?.authoritativeSeen && samePaths(current.paths, paths)) {
          return state;
        }
        return {
          byPatchKey: {
            ...state.byPatchKey,
            [patchKey]: {
              paths: [...paths],
              authoritativeSeen: true,
            },
          },
        };
      }
      if (!current?.authoritativeSeen) {
        return state;
      }
      const next = { ...state.byPatchKey };
      delete next[patchKey];
      return { byPatchKey: next };
    }),
}));
