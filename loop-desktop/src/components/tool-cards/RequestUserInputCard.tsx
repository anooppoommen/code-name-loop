import { memo, useCallback, useState } from 'react';
import type { RequestUserInputPayload, ToolReplyActions } from './types';
import { buildRequestUserInputReply } from './toolPayloadParsers';

interface RequestUserInputCardProps extends ToolReplyActions {
  payload: RequestUserInputPayload;
}

export const RequestUserInputCard = memo(function RequestUserInputCard({
  payload,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
}: RequestUserInputCardProps) {
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, number>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const hasSelection = Object.keys(selectedByQuestion).length > 0;
  const replyText = hasSelection ? buildRequestUserInputReply(payload.questions, selectedByQuestion) : '';
  const sendDisabled = !canCompose || isSubmitting || !hasSelection;

  const handleSend = useCallback(() => {
    if (sendDisabled || !replyText) {
      return;
    }
    setIsSubmitting(true);
    void onSendToolReply(replyText)
      .catch(() => undefined)
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [onSendToolReply, replyText, sendDisabled]);

  return (
    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">User Input Required</p>
        <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
          {payload.questions.length} question{payload.questions.length === 1 ? '' : 's'}
        </span>
      </div>
      {payload.reason ? (
        <p className="mt-1 text-xs leading-relaxed text-amber-100/90">{payload.reason}</p>
      ) : null}

      <div className="mt-3 space-y-3">
        {payload.questions.map((question) => (
          <div key={question.id} className="rounded-md border border-neutral-700/80 bg-neutral-950/40 p-2.5">
            <div className="mb-1 flex items-center gap-2">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">{question.header}</span>
              <span className="font-mono text-[10px] text-neutral-500">{question.id}</span>
            </div>
            <p className="mb-2 text-xs text-neutral-100">{question.question}</p>
            <div className="space-y-1.5">
              {question.options.map((option, index) => {
                const selected = selectedByQuestion[question.id] === index;
                return (
                  <button
                    key={`${question.id}:${index}`}
                    type="button"
                    className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? 'border-blue-500/80 bg-blue-500/15 text-blue-100'
                        : 'border-neutral-700 bg-neutral-900/60 text-neutral-200 hover:border-neutral-500'
                    }`}
                    onClick={() => setSelectedByQuestion((prev) => ({ ...prev, [question.id]: index }))}
                  >
                    <div className="font-semibold">{option.label}</div>
                    <div className="mt-0.5 text-[11px] text-neutral-400">{option.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-neutral-600 px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!canCompose || !hasSelection}
          onClick={() => {
            if (!replyText) {
              return;
            }
            onUseToolReply(replyText);
          }}
        >
          Insert Selected Reply
        </button>
        <button
          type="button"
          className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
          disabled={sendDisabled}
          onClick={handleSend}
        >
          {isSubmitting ? (isSending ? 'Queueing...' : 'Sending...') : (isSending ? 'Queue Selected Reply' : 'Send Selected Reply')}
        </button>
      </div>
      {payload.nextStep ? (
        <p className="mt-2 text-[11px] text-neutral-400">{payload.nextStep}</p>
      ) : null}
    </div>
  );
});
