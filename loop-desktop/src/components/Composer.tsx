import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface ComposerProps {
  messageInput: string;
  onMessageInputChange: (value: string) => void;
  isSending: boolean;
  canCompose: boolean;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}

export function Composer({
  messageInput,
  onMessageInputChange,
  isSending,
  canCompose,
  onSubmit,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendDisabled = !canCompose || !messageInput.trim() || isSending;

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = '0px';
    const nextHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 72), 196);
    textareaRef.current.style.height = `${nextHeight}px`;
  }, [messageInput]);

  return (
    <div className="px-6 pb-6 pt-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (sendDisabled) {
            return;
          }
          void onSubmit();
        }}
        className="no-drag relative flex shrink-0 flex-col rounded-2xl border border-neutral-700/50 bg-neutral-900 p-3 shadow-sm transition-all focus-within:border-blue-500/50 focus-within:bg-neutral-800 focus-within:ring-1 focus-within:ring-blue-500/50"
      >
        <textarea
          ref={textareaRef}
          value={messageInput}
          onChange={(event) => onMessageInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) {
              return;
            }
            event.preventDefault();
            if (sendDisabled) {
              return;
            }
            void onSubmit();
          }}
          className="max-h-[200px] min-h-[48px] w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-relaxed text-neutral-200 outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={canCompose ? 'Ask for follow-up changes...' : 'Select a workspace to start chatting'}
          disabled={!canCompose || isSending}
        />

        <div className="mt-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            {isSending ? (
              <button
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-neutral-600 bg-neutral-800 px-3 text-xs font-medium text-neutral-300 transition hover:bg-neutral-700"
                type="button"
                onClick={() => void onStop()}
              >
                <Square size={12} className="fill-current" />
                <span>Stop</span>
              </button>
            ) : null}
          </div>

          <button
            className="inline-flex h-9 min-w-[36px] items-center justify-center rounded-full bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            type="submit"
            disabled={sendDisabled}
          >
            {messageInput.trim() ? 'Send' : <ArrowUp size={16} />}
          </button>
        </div>
      </form>
    </div>
  );
}
