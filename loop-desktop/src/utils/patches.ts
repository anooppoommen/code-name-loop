export type PatchAction = 'Update' | 'Add' | 'Delete' | 'Move';

export interface PatchFile {
  action: PatchAction;
  path: string;
  previousPath?: string;
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

interface VirtualLine {
  text: string;
  state: 'context' | 'add' | 'remove';
  initialized: boolean;
}

interface FileAccumulator {
  currentPath: string;
  previousPath?: string;
  firstAction: PatchAction;
  lastAction: PatchAction;
  sawMove: boolean;
  virtualFile: VirtualFile;
}

class VirtualFile {
  lines: VirtualLine[] = [];

  getLineIndex(targetCurrentLn: number): number {
    let current = 1;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].state !== 'remove') {
        if (current === targetCurrentLn) {
          return i;
        }
        current++;
      }
    }

    while (current <= targetCurrentLn) {
      this.lines.push({ text: ' ', state: 'context', initialized: false });
      if (current === targetCurrentLn) {
        return this.lines.length - 1;
      }
      current++;
    }

    return this.lines.length - 1;
  }
}

export function parsePatchData(patchText: string): PatchFile[] {
  const lines = patchText.split('\n');
  const files: PatchFile[] = [];
  let currentFile: PatchFile | null = null;
  let currentHunk: (PatchHunk & { oldStart: number; newStart: number }) | null = null;
  let fallbackOldStart = 1;
  let fallbackNewStart = 1;

  const beginHunk = (header: string, oldStart: number, newStart: number) => {
    if (!currentFile) {
      return null;
    }

    currentHunk = {
      header,
      lines: [],
      oldStart,
      newStart,
    };
    currentFile.hunks.push(currentHunk);
    fallbackOldStart = oldStart;
    fallbackNewStart = newStart;
    return currentHunk;
  };

  const ensureHunkForContent = () => {
    if (!currentFile) {
      return null;
    }
    if (currentHunk) {
      return currentHunk;
    }
    if (currentFile.action === 'Add') {
      return beginHunk('@@', 0, 1);
    }
    return beginHunk('@@', fallbackOldStart, fallbackNewStart);
  };

  for (const line of lines) {
    if (line.startsWith('*** ')) {
      const fileMatch = line.match(/\*\*\* (Update|Add|Delete) File:\s+(.*)/);
      if (fileMatch) {
        currentFile = {
          action: fileMatch[1] as PatchAction,
          path: fileMatch[2],
          added: 0,
          removed: 0,
          hunks: [],
        };
        files.push(currentFile);
        currentHunk = null;
        fallbackOldStart = 1;
        fallbackNewStart = 1;
        continue;
      }

      if (line.startsWith('*** Move to:') && currentFile) {
        currentFile.previousPath = currentFile.path;
        currentFile.path = line.replace('*** Move to:', '').trim();
        continue;
      }

      if (line.trim() === '*** End Patch') {
        break;
      }

      continue;
    }

    if (line.startsWith('@@') && currentFile) {
      const match = line.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
      const oldStart = match ? parseInt(match[1], 10) : fallbackOldStart;
      const newStart = match ? parseInt(match[2], 10) : fallbackNewStart;
      beginHunk(line, oldStart, newStart);
      continue;
    }

    const targetHunk = currentHunk || (line ? ensureHunkForContent() : null);
    if (!targetHunk || !currentFile) {
      continue;
    }

    if (line.startsWith('+')) {
      currentFile.added++;
      targetHunk.lines.push({ type: 'add', text: line, newLn: targetHunk.newStart++ });
    } else if (line.startsWith('-')) {
      currentFile.removed++;
      targetHunk.lines.push({ type: 'remove', text: line, oldLn: targetHunk.oldStart++ });
    } else if (line.startsWith('\\')) {
      targetHunk.lines.push({
        type: 'context',
        text: line,
      });
    } else {
      targetHunk.lines.push({
        type: 'context',
        text: line,
        oldLn: targetHunk.oldStart++,
        newLn: targetHunk.newStart++,
      });
    }

    fallbackOldStart = targetHunk.oldStart;
    fallbackNewStart = targetHunk.newStart;
  }

  return files;
}

function applyPatchToVirtualFile(vfile: VirtualFile, filePatch: PatchFile): void {
  for (const hunk of filePatch.hunks) {
    let vIdx = -1;
    for (const line of hunk.lines) {
      if (line.oldLn !== undefined) {
        vIdx = vfile.getLineIndex(line.oldLn);
        break;
      }
    }

    if (vIdx === -1) {
      if (hunk.lines.length > 0 && hunk.lines[0].newLn !== undefined) {
        vIdx = vfile.getLineIndex(hunk.lines[0].newLn);
      } else {
        vIdx = vfile.lines.length;
      }
    }

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        while (vIdx < vfile.lines.length && vfile.lines[vIdx].state === 'remove') {
          vIdx++;
        }
        while (vIdx >= vfile.lines.length) {
          vfile.lines.push({ text: ' ', state: 'context', initialized: false });
        }
        if (vfile.lines[vIdx].state === 'context') {
          vfile.lines[vIdx].text = line.text;
          vfile.lines[vIdx].initialized = true;
        }
        vIdx++;
        continue;
      }

      if (line.type === 'remove') {
        while (vIdx < vfile.lines.length && vfile.lines[vIdx].state === 'remove') {
          vIdx++;
        }
        while (vIdx >= vfile.lines.length) {
          vfile.lines.push({ text: ' ', state: 'context', initialized: false });
        }
        if (vfile.lines[vIdx].state === 'add') {
          vfile.lines.splice(vIdx, 1);
        } else {
          vfile.lines[vIdx].state = 'remove';
          if (line.text.length > 0 && line.text !== ' ') {
            vfile.lines[vIdx].text = line.text;
          }
          vfile.lines[vIdx].initialized = true;
          vIdx++;
        }
        continue;
      }

      vfile.lines.splice(vIdx, 0, {
        text: line.text,
        state: 'add',
        initialized: true,
      });
      vIdx++;
    }
  }
}

function resolveAccumulator(
  states: Map<string, FileAccumulator>,
  file: PatchFile,
): FileAccumulator {
  const priorPath = file.previousPath;
  const existing =
    (priorPath ? states.get(priorPath) : undefined) ??
    states.get(file.path);

  if (existing) {
    if (priorPath && priorPath !== file.path) {
      states.delete(priorPath);
      existing.previousPath ??= priorPath;
      existing.sawMove = true;
      existing.currentPath = file.path;
      states.set(file.path, existing);
    }
    existing.lastAction = file.action;
    return existing;
  }

  const created: FileAccumulator = {
    currentPath: file.path,
    previousPath: priorPath,
    firstAction: file.action,
    lastAction: file.action,
    sawMove: Boolean(priorPath && priorPath !== file.path),
    virtualFile: new VirtualFile(),
  };
  states.set(file.path, created);
  return created;
}

function computeDisplayedAction(
  state: FileAccumulator,
  addedCount: number,
  removedCount: number,
): PatchAction | null {
  const hasNetTextChange = addedCount > 0 || removedCount > 0;

  if (!state.sawMove && !hasNetTextChange && state.firstAction === 'Add' && state.lastAction === 'Delete') {
    return null;
  }

  if (state.lastAction === 'Delete') {
    return 'Delete';
  }
  if (state.firstAction === 'Add') {
    return 'Add';
  }
  if (state.sawMove) {
    return 'Move';
  }
  if (!hasNetTextChange) {
    return null;
  }
  return 'Update';
}

export function buildCombinedPatch(patches: string[]): PatchFile[] {
  const states = new Map<string, FileAccumulator>();

  for (const patchText of patches) {
    const files = parsePatchData(patchText);
    for (const file of files) {
      const state = resolveAccumulator(states, file);
      if (file.action === 'Delete' && file.hunks.length === 0) {
        state.virtualFile.lines = [];
        continue;
      }
      applyPatchToVirtualFile(state.virtualFile, file);
    }
  }

  const result: PatchFile[] = [];

  for (const state of states.values()) {
    let oldCounter = 1;
    let newCounter = 1;
    const computed = state.virtualFile.lines.map((line) => {
      let oldLn: number | undefined;
      let newLn: number | undefined;
      if (line.state === 'context') {
        oldLn = oldCounter++;
        newLn = newCounter++;
      } else if (line.state === 'remove') {
        oldLn = oldCounter++;
      } else {
        newLn = newCounter++;
      }
      return { ...line, oldLn, newLn };
    });

    const changed: number[] = [];
    let addedCount = 0;
    let removedCount = 0;
    for (let i = 0; i < computed.length; i++) {
      if (computed[i].state === 'add') {
        addedCount++;
      }
      if (computed[i].state === 'remove') {
        removedCount++;
      }
      if (computed[i].state === 'add' || computed[i].state === 'remove') {
        changed.push(i);
      }
    }

    const action = computeDisplayedAction(state, addedCount, removedCount);
    if (!action) {
      continue;
    }

    const ranges: { start: number; end: number }[] = [];
    for (const idx of changed) {
      const rStart = Math.max(0, idx - 3);
      const rEnd = Math.min(computed.length - 1, idx + 3);
      if (ranges.length > 0 && ranges[ranges.length - 1].end >= rStart - 1) {
        ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, rEnd);
      } else {
        ranges.push({ start: rStart, end: rEnd });
      }
    }

    const hunks: PatchHunk[] = [];
    for (const range of ranges) {
      let { start, end } = range;
      while (start < end && computed[start].state === 'context' && !computed[start].initialized) {
        start++;
      }
      while (end > start && computed[end].state === 'context' && !computed[end].initialized) {
        end--;
      }

      const hunkLines: PatchLine[] = [];
      let oldStart = 0;
      let newStart = 0;
      let oldLinesCount = 0;
      let newLinesCount = 0;

      for (let i = start; i <= end; i++) {
        const line = computed[i];
        if (line.state === 'context' || line.state === 'remove') {
          if (oldStart === 0 && line.oldLn !== undefined) {
            oldStart = line.oldLn;
          }
          oldLinesCount++;
        }
        if (line.state === 'context' || line.state === 'add') {
          if (newStart === 0 && line.newLn !== undefined) {
            newStart = line.newLn;
          }
          newLinesCount++;
        }

        hunkLines.push({
          type: line.state,
          text: line.text,
          oldLn: line.oldLn,
          newLn: line.newLn,
        });
      }

      if (oldStart === 0) {
        oldStart = 1;
      }
      if (newStart === 0) {
        newStart = 1;
      }

      hunks.push({
        header: `@@ -${oldStart},${oldLinesCount} +${newStart},${newLinesCount} @@`,
        lines: hunkLines,
      });
    }

    result.push({
      action,
      path: state.currentPath,
      previousPath: state.sawMove ? state.previousPath : undefined,
      added: addedCount,
      removed: removedCount,
      hunks,
    });
  }

  return result;
}
