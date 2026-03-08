import { memo } from 'react';
import { ArrowUp } from 'lucide-react';

interface ComposerActionsProps {
  isSending: boolean;
  hasContent: boolean;
  actionDisabled: boolean;
  onStop: () => void;
}

export const ComposerActions = memo(function ComposerActions({
  isSending,
  hasContent,
  actionDisabled,
  onStop,
}: ComposerActionsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {isSending ? (
        <button
          className="inline-flex h-7 min-w-[32px] items-center justify-center gap-1.5 rounded-full bg-loop-700 px-2.5 text-[11px] font-semibold text-loop-300 shadow-sm transition hover:bg-loop-600 hover:text-white"
          type="button"
          onClick={onStop}
        >
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <span>Stop</span>
        </button>
      ) : null}
      <button
        className="inline-flex h-7 min-w-[32px] items-center justify-center gap-1.5 rounded-full bg-blue-600 px-2.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-loop-800 disabled:text-loop-500"
        type="submit"
        disabled={actionDisabled}
      >
        {isSending ? (
          'Queue'
        ) : hasContent ? (
          'Send'
        ) : (
          <ArrowUp size={13} />
        )}
      </button>
    </div>
  );
});
