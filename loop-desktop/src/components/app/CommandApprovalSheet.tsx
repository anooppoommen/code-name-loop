import { motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardShortcut } from '../KeyboardShortcut';
import type {
  CommandApprovalDecision,
  PendingCommandApproval,
} from '../../hooks/useLoopDesktop';

const COMMAND_APPROVAL_OPTIONS: Array<{
  decision: CommandApprovalDecision;
  label: string;
  keyHint: string;
}> = [
  { decision: 'deny', label: 'Deny', keyHint: '1' },
  { decision: 'allow_once', label: 'Allow once', keyHint: '2' },
  { decision: 'allow_session', label: 'Allow in session', keyHint: '3' },
];

interface CommandApprovalSheetProps {
  approval: PendingCommandApproval;
  pendingCount: number;
  isResolving: boolean;
  onResolve: (decision: CommandApprovalDecision, message?: string) => void;
}

export function CommandApprovalSheet({
  approval,
  pendingCount,
  isResolving,
  onResolve,
}: CommandApprovalSheetProps) {
  const [activeOptionIndex, setActiveOptionIndex] = useState(1);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setActiveOptionIndex(1);
  }, [approval.id]);

  useEffect(() => {
    const activeButton = optionRefs.current[activeOptionIndex];
    if (activeButton) {
      activeButton.focus({ preventScroll: true });
    }
  }, [activeOptionIndex, approval.id]);

  const moveSelection = useCallback((direction: 1 | -1) => {
    setActiveOptionIndex(
      (current) =>
        (current + direction + COMMAND_APPROVAL_OPTIONS.length) % COMMAND_APPROVAL_OPTIONS.length,
    );
  }, []);

  const resolveDecision = useCallback(
    (decision: CommandApprovalDecision) => {
      onResolve(decision);
    },
    [onResolve],
  );

  const onArrowDown = useCallback((): boolean => {
    moveSelection(1);
    return true;
  }, [moveSelection]);

  const onArrowUp = useCallback((): boolean => {
    moveSelection(-1);
    return true;
  }, [moveSelection]);

  const onArrowRight = useCallback((): boolean => {
    moveSelection(1);
    return true;
  }, [moveSelection]);

  const onArrowLeft = useCallback((): boolean => {
    moveSelection(-1);
    return true;
  }, [moveSelection]);

  const onDigit1 = useCallback((): boolean => {
    setActiveOptionIndex(0);
    return true;
  }, []);

  const onDigit2 = useCallback((): boolean => {
    if (COMMAND_APPROVAL_OPTIONS.length < 2) {
      return false;
    }
    setActiveOptionIndex(1);
    return true;
  }, []);

  const onDigit3 = useCallback((): boolean => {
    if (COMMAND_APPROVAL_OPTIONS.length < 3) {
      return false;
    }
    setActiveOptionIndex(2);
    return true;
  }, []);

  const onEnter = useCallback((): boolean => {
    const selected = COMMAND_APPROVAL_OPTIONS[activeOptionIndex];
    if (!selected) {
      return false;
    }
    resolveDecision(selected.decision);
    return true;
  }, [activeOptionIndex, resolveDecision]);

  return (
    <KeyboardShortcut
      priority={200}
      enabled={!isResolving}
      onArrowDown={onArrowDown}
      onArrowRight={onArrowRight}
      onArrowUp={onArrowUp}
      onArrowLeft={onArrowLeft}
      onDigit1={onDigit1}
      onDigit2={onDigit2}
      onDigit3={onDigit3}
      onEnter={onEnter}
    >
      <motion.div
        initial={{ opacity: 0, y: 26, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.985 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="pointer-events-none absolute inset-x-0 bottom-[calc(100%-24px)] z-10"
      >
        <div className="pointer-events-auto px-4">
          <div className="rounded-xl border border-loop-800/50 bg-loop-800 p-2 shadow-lg shadow-black/55">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[12px] text-loop-300">
                  <span className="font-mono text-loop-200">{approval.toolName}</span> wants to{' '}
                  {['read_file', 'list_dir', 'grep_files', 'apply_patch'].includes(approval.toolName)
                    ? 'access a path outside of the workspace directory'
                    : 'run'}
                  :
                </div>
                <div className="group relative min-w-0">
                  <pre className="m-0 overflow-x-hidden text-ellipsis whitespace-nowrap pb-0.5 font-mono text-[13px] leading-relaxed text-loop-100 scrollbar-hidden group-hover:overflow-x-auto group-hover:text-clip">
                    <span className="pr-6">{approval.command}</span>
                  </pre>
                  <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-loop-900 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              </div>
              {pendingCount > 1 ? (
                <span className="shrink-0 rounded border border-loop-700 bg-loop-950 px-1.5 py-0.5 text-[10px] text-loop-300">
                  {pendingCount} pending
                </span>
              ) : null}
            </div>
            {approval.workdir ? (
              <p className="mt-1 text-[10px] text-loop-500">
                in <span className="font-mono text-loop-400">{approval.workdir}</span>
              </p>
            ) : null}
            <div className="mt-2 flex flex-col gap-1 pb-6" role="radiogroup" aria-label="Command approval options">
              {COMMAND_APPROVAL_OPTIONS.map((option, index) => {
                const isActive = index === activeOptionIndex;

                return (
                  <div key={option.decision} className="flex items-center gap-1">
                    <button
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      tabIndex={isActive ? 0 : -1}
                      disabled={isResolving}
                      className={`flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-loop-800 disabled:cursor-not-allowed disabled:opacity-60 ${
                        isActive ? 'bg-loop-700 text-loop-100' : ''
                      }`}
                      onFocus={() => setActiveOptionIndex(index)}
                      onClick={() => resolveDecision(option.decision)}
                    >
                      <span>{option.label}</span>
                      <span className="rounded bg-loop-600 px-1 py-0.5 text-[10px] text-loop-200">
                        {option.keyHint}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </motion.div>
    </KeyboardShortcut>
  );
}
