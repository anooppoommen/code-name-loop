import { ArrowUp, Brain, Check, ChevronDown, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThinkingLevel } from '../types/ui';
import type { ComposerImage } from '../hooks/useLoopDesktop';

interface ComposerProps {
  messageInput: string;
  onMessageInputChange: (value: string) => void;
  isSending: boolean;
  canCompose: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (value: ThinkingLevel) => void;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onNewConversation: () => void;
  conversationId: string | null;
  composerImages: ComposerImage[];
  setComposerImages: React.Dispatch<React.SetStateAction<ComposerImage[]>>;
}

const THINKING_OPTIONS: Array<{
  value: ThinkingLevel;
  label: string;
  toneClass: string;
}> = [
  { value: 'minimal', label: 'Minimal', toneClass: 'text-neutral-300' },
  { value: 'low', label: 'Low', toneClass: 'text-sky-300' },
  { value: 'medium', label: 'Medium', toneClass: 'text-blue-300' },
  { value: 'high', label: 'High', toneClass: 'text-violet-300' },
];

export function Composer({
  messageInput,
  onMessageInputChange,
  isSending,
  canCompose,
  thinkingLevel,
  onThinkingLevelChange,
  onSubmit,
  onStop,
  onNewConversation,
  conversationId,
  composerImages,
  setComposerImages,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isThinkingMenuOpen, setIsThinkingMenuOpen] = useState(false);
  const hasContent = messageInput.trim().length > 0 || composerImages.length > 0;
  const sendDisabled = !canCompose || !hasContent || isSending;
  const activeThinking = useMemo(
    () => THINKING_OPTIONS.find((option) => option.value === thinkingLevel) ?? THINKING_OPTIONS[2],
    [thinkingLevel],
  );

  // Auto-focus when conversation/thread changes
  useEffect(() => {
    if (textareaRef.current && canCompose) {
      textareaRef.current.focus();
    }
  }, [conversationId, canCompose]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = '0px';
    const nextHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 48), 130);
    textareaRef.current.style.height = `${nextHeight}px`;
  }, [messageInput]);

  useEffect(() => {
    if (!isThinkingMenuOpen) {
      return;
    }

    const handleOutsideClick = (event: MouseEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) {
        setIsThinkingMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsThinkingMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isThinkingMenuOpen]);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const data = dataUrl.split(',')[1];
      setComposerImages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), mimeType: file.type, data, dataUrl },
      ]);
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) handleFile(file);
      }
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(handleFile);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="w-full px-4 pb-3 pt-1">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (sendDisabled) {
            return;
          }
          void onSubmit();
        }}
        className="no-drag relative flex shrink-0 flex-col rounded-xl border border-neutral-700/50 bg-neutral-800 p-2 shadow-sm transition-all focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/50"
      >
        {composerImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 px-1">
            {composerImages.map((img) => (
              <div key={img.id} className="relative group rounded-md border border-neutral-700 overflow-hidden w-16 h-16 bg-neutral-900">
                <img src={img.dataUrl} alt="attachment" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => setComposerImages((prev) => prev.filter((i) => i.id !== img.id))}
                  className="absolute top-1 right-1 p-0.5 bg-black/50 hover:bg-black/80 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={messageInput}
          onPaste={handlePaste}
          onChange={(event) => onMessageInputChange(event.target.value)}
          onKeyDown={(event) => {
            // Cmd + N (Mac) or Ctrl + N (Windows/Linux) to start a new thread
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
              event.preventDefault();
              onNewConversation();
              return;
            }
            if (event.key !== 'Enter' || event.shiftKey) {
              return;
            }
            event.preventDefault();
            if (sendDisabled) {
              return;
            }
            void onSubmit();
          }}
          className="max-h-[132px] min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-neutral-200 outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={canCompose ? 'Ask for follow-up changes...' : 'Select a workspace to start chatting'}
          disabled={!canCompose || isSending}
        />

        <div className="mt-1.5 flex items-center justify-between px-0.5">
          <div className="flex items-center gap-1.5">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition"
              title="Attach image"
            >
              <Plus size={14} />
            </button>

            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-neutral-700/80 bg-neutral-900 px-2 text-[11px] font-medium text-neutral-200 transition hover:border-blue-500/60 hover:bg-neutral-800"
                aria-haspopup="menu"
                aria-expanded={isThinkingMenuOpen}
                onClick={() => setIsThinkingMenuOpen((prev) => !prev)}
              >
                <Brain size={12} className={activeThinking.toneClass} />
                <span>{activeThinking.label}</span>
                <ChevronDown
                  size={12}
                  className={`text-neutral-400 transition-transform ${isThinkingMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {isThinkingMenuOpen ? (
                <div
                  className="absolute bottom-full left-0 z-20 mb-2 w-32 rounded-xl border border-neutral-700/80 bg-neutral-900 p-1 shadow-2xl shadow-black/40"
                  role="menu"
                >
                  {THINKING_OPTIONS.map((option) => {
                    const isActive = option.value === thinkingLevel;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isActive}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11px] transition ${
                          isActive
                            ? 'bg-blue-500/15 text-blue-100'
                            : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100'
                        }`}
                        onClick={() => {
                          onThinkingLevelChange(option.value);
                          setIsThinkingMenuOpen(false);
                        }}
                      >
                        <span className="inline-flex items-center gap-2">
                          <Brain size={12} className={isActive ? 'text-blue-300' : option.toneClass} />
                          {option.label}
                        </span>
                        {isActive ? <Check size={12} className="text-blue-300" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          <button
            className="inline-flex h-7 min-w-[32px] items-center justify-center gap-1.5 rounded-full bg-blue-600 px-2.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            type={isSending ? 'button' : 'submit'}
            onClick={isSending ? () => void onStop() : undefined}
            disabled={!isSending && sendDisabled}
          >
            {isSending ? (
              <>
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                <span>Stop</span>
              </>
            ) : hasContent ? (
              'Send'
            ) : (
              <ArrowUp size={13} />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
