import { memo, useCallback, useRef } from 'react';
import type { ComposerModel, ThinkingLevel } from '../types/ui';
import { KeyboardShortcut } from './KeyboardShortcut';
import { ComposerActions } from './composer/ComposerActions';
import { ComposerImageStrip } from './composer/ComposerImageStrip';
import { ComposerTextarea } from './composer/ComposerTextarea';
import { ComposerToolbar } from './composer/ComposerToolbar';
import { useComposerDraftStore } from '../stores/composerDraftStore';

interface ComposerProps {
  isSending: boolean;
  canCompose: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (value: ThinkingLevel) => void;
  composerModel: ComposerModel;
  onComposerModelChange: (value: ComposerModel) => void;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onQueue?: () => void;
  conversationId: string;
}

export const Composer = memo(function Composer({
  isSending,
  canCompose,
  thinkingLevel,
  onThinkingLevelChange,
  composerModel,
  onComposerModelChange,
  onSubmit,
  onStop,
  onQueue,
  conversationId,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasContent = useComposerDraftStore((state) => {
    const messageInput = state.composerInputs[conversationId] ?? '';
    const composerImages = state.composerImagesMap[conversationId] ?? [];
    return messageInput.trim().length > 0 || composerImages.length > 0;
  });
  const setComposerImages = useComposerDraftStore((state) => state.setComposerImages);
  const actionDisabled = !canCompose || !hasContent;

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const data = dataUrl.split(',')[1];
      setComposerImages(conversationId, (prev) => [
        ...prev,
        { id: crypto.randomUUID(), mimeType: file.type, data, dataUrl },
      ]);
    };
    reader.readAsDataURL(file);
  }, [conversationId, setComposerImages]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) handleFile(file);
      }
    }
  }, [handleFile]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(handleFile);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleFile]);

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const composerEnterHandler = useCallback((event: KeyboardEvent): boolean => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return false;
    }
    if (document.activeElement !== textareaRef.current) {
      return false;
    }
    if (actionDisabled) {
      return true;
    }
    if (isSending && onQueue) {
      onQueue();
    } else {
      void onSubmit();
    }
    return true;
  }, [actionDisabled, isSending, onQueue, onSubmit]);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionDisabled) {
      return;
    }
    if (isSending && onQueue) {
      onQueue();
      return;
    }
    void onSubmit();
  }, [actionDisabled, isSending, onQueue, onSubmit]);

  const handleStop = useCallback(() => {
    void onStop();
  }, [onStop]);

  return (
    <KeyboardShortcut priority={20} enabled={canCompose} onEnter={composerEnterHandler}>
      <div className="w-full px-4 pb-3 pt-1">
        <form
          onSubmit={handleSubmit}
          className={`no-drag relative z-0 flex shrink-0 flex-col rounded-xl border p-2 shadow-sm transition-[border-color,background-color,box-shadow] ${
            isSending
              ? 'google-running-glow border-loop-600/70 bg-loop-800 shadow-[0_0_0_1px_rgba(59,130,246,0.14)]'
              : 'border-loop-700/50 bg-loop-800 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/50'
          }`}
        >
          <ComposerImageStrip conversationId={conversationId} />
          <ComposerTextarea
            conversationId={conversationId}
            textareaRef={textareaRef}
            onPaste={handlePaste}
            placeholder={canCompose ? 'Ask for follow-up changes...' : 'Select a workspace to start chatting'}
            canCompose={canCompose}
          />

          <div className="relative z-10 mt-1.5 flex items-center justify-between px-0.5">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
            />
            <ComposerToolbar
              composerModel={composerModel}
              onComposerModelChange={onComposerModelChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={onThinkingLevelChange}
              onOpenFilePicker={handleOpenFilePicker}
            />
            <ComposerActions
              isSending={isSending}
              hasContent={hasContent}
              actionDisabled={actionDisabled}
              onStop={handleStop}
            />
          </div>
        </form>
      </div>
    </KeyboardShortcut>
  );
});
