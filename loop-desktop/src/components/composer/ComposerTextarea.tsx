import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  type ChangeEvent,
  type ClipboardEvent,
  type RefObject,
} from 'react';
import { useComposerDraftStore } from '../../stores/composerDraftStore';

const CAN_USE_FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');

interface ComposerTextareaProps {
  conversationId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  canCompose: boolean;
}

export const ComposerTextarea = memo(function ComposerTextarea({
  conversationId,
  textareaRef,
  onPaste,
  placeholder,
  canCompose,
}: ComposerTextareaProps) {
  const messageInput = useComposerDraftStore((state) => state.composerInputs[conversationId] ?? '');
  const setMessageInput = useComposerDraftStore((state) => state.setMessageInput);

  useEffect(() => {
    if (textareaRef.current && canCompose) {
      textareaRef.current.focus();
    }
  }, [canCompose, conversationId, textareaRef]);

  useLayoutEffect(() => {
    if (CAN_USE_FIELD_SIZING || !textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = '0px';
    const nextHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 48), 130);
    textareaRef.current.style.height = `${nextHeight}px`;
  }, [messageInput, textareaRef]);

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setMessageInput(conversationId, event.target.value);
  }, [conversationId, setMessageInput]);

  return (
    <textarea
      ref={textareaRef}
      value={messageInput}
      onPaste={onPaste}
      onChange={handleChange}
      className="relative z-10 max-h-[132px] min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-loop-200 outline-none placeholder:text-loop-500 disabled:cursor-not-allowed disabled:opacity-50"
      placeholder={placeholder}
      disabled={!canCompose}
      style={CAN_USE_FIELD_SIZING ? { fieldSizing: 'content' } : undefined}
    />
  );
});
