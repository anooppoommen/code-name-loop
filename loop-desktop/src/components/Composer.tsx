import { ArrowUp, Brain, Check, ChevronDown, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerModel, ThinkingLevel } from '../types/ui';
import type { ComposerImage } from '../hooks/useLoopDesktop';
import { getAllowedThinkingLevelsForModel } from '../hooks/useLoopDesktop.helpers';
import { KeyboardShortcut } from './KeyboardShortcut';

interface ComposerProps {
  messageInput: string;
  onMessageInputChange: (value: string) => void;
  isSending: boolean;
  canCompose: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (value: ThinkingLevel) => void;
  composerModel: ComposerModel;
  onComposerModelChange: (value: ComposerModel) => void;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onQueue?: () => void;
  conversationId: string | null;
  composerImages: ComposerImage[];
  setComposerImages: React.Dispatch<React.SetStateAction<ComposerImage[]>>;
}

const THINKING_OPTIONS: Array<{
  value: ThinkingLevel;
  label: string;
  toneClass: string;
}> = [
  { value: 'minimal', label: 'Minimal', toneClass: 'text-loop-300' },
  { value: 'low', label: 'Low', toneClass: 'text-sky-300' },
  { value: 'medium', label: 'Medium', toneClass: 'text-blue-300' },
  { value: 'high', label: 'High', toneClass: 'text-violet-300' },
];

const MODEL_OPTIONS: Array<{ value: ComposerModel; label: string }> = [
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
];

export function Composer({
  messageInput,
  onMessageInputChange,
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
  composerImages,
  setComposerImages,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isThinkingMenuOpen, setIsThinkingMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const hasContent = messageInput.trim().length > 0 || composerImages.length > 0;
  // If isSending is true, we can still Queue, so only disable if we can't compose at all
  const actionDisabled = !canCompose || !hasContent;
  const thinkingOptionsForModel = useMemo(() => {
    const allowed = new Set(getAllowedThinkingLevelsForModel(composerModel));
    return THINKING_OPTIONS.filter((option) => allowed.has(option.value));
  }, [composerModel]);
  const activeThinking = useMemo(
    () => thinkingOptionsForModel.find((option) => option.value === thinkingLevel) ?? thinkingOptionsForModel[0],
    [thinkingLevel, thinkingOptionsForModel],
  );
  const activeModel = useMemo(
    () => MODEL_OPTIONS.find((option) => option.value === composerModel) ?? MODEL_OPTIONS[0],
    [composerModel],
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
    if (!isThinkingMenuOpen && !isModelMenuOpen) {
      return;
    }

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const outsideThinking = !dropdownRef.current?.contains(target);
      const outsideModel = !modelDropdownRef.current?.contains(target);
      if (outsideThinking && outsideModel) {
        setIsThinkingMenuOpen(false);
        setIsModelMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsThinkingMenuOpen(false);
        setIsModelMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isModelMenuOpen, isThinkingMenuOpen]);

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

  return (
    <KeyboardShortcut priority={20} enabled={canCompose} onEnter={composerEnterHandler}>
      <div className="w-full px-4 pb-3 pt-1">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (actionDisabled) {
              return;
            }
            if (isSending && onQueue) {
              onQueue();
            } else {
              void onSubmit();
            }
          }}
          className="no-drag relative flex shrink-0 flex-col rounded-xl border border-loop-700/50 bg-loop-800 p-2 shadow-sm transition-all focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/50"
        >
          {composerImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1">
              {composerImages.map((img) => (
                <div
                  key={img.id}
                  className="group relative h-16 w-16 overflow-hidden rounded-md border border-loop-700 bg-loop-900"
                >
                  <img src={img.dataUrl} alt="attachment" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setComposerImages((prev) => prev.filter((i) => i.id !== img.id))}
                    className="absolute right-1 top-1 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/80"
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
            className="max-h-[132px] min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-loop-200 outline-none placeholder:text-loop-500 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={canCompose ? 'Ask for follow-up changes...' : 'Select a workspace to start chatting'}
            disabled={!canCompose}
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
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-loop-400 transition hover:bg-loop-800 hover:text-loop-200"
                title="Attach image"
              >
                <Plus size={14} />
              </button>

              <div ref={modelDropdownRef} className="relative">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1.5 rounded-full border border-loop-700/80 bg-loop-900 px-2 text-[11px] font-medium text-loop-200 transition hover:border-blue-500/60 hover:bg-loop-800"
                  aria-haspopup="menu"
                  aria-expanded={isModelMenuOpen}
                  onClick={() => {
                    setIsModelMenuOpen((prev) => !prev);
                    setIsThinkingMenuOpen(false);
                  }}
                >
                  <span>{activeModel.label}</span>
                  <ChevronDown
                    size={12}
                    className={`text-loop-400 transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                {isModelMenuOpen ? (
                  <div
                    className="absolute bottom-full left-0 z-20 mb-2 w-48 rounded-xl border border-loop-700/80 bg-loop-900 p-1 shadow-2xl shadow-black/40"
                    role="menu"
                  >
                    {MODEL_OPTIONS.map((option) => {
                      const isActive = option.value === composerModel;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isActive}
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11px] transition ${
                            isActive
                              ? 'bg-blue-500/15 text-blue-100'
                              : 'text-loop-300 hover:bg-loop-800 hover:text-loop-100'
                          }`}
                          onClick={() => {
                            onComposerModelChange(option.value);
                            setIsModelMenuOpen(false);
                          }}
                        >
                          <span>{option.label}</span>
                          {isActive ? <Check size={12} className="text-blue-300" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div ref={dropdownRef} className="relative">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1.5 rounded-full border border-loop-700/80 bg-loop-900 px-2 text-[11px] font-medium text-loop-200 transition hover:border-blue-500/60 hover:bg-loop-800"
                  aria-haspopup="menu"
                  aria-expanded={isThinkingMenuOpen}
                  onClick={() => {
                    setIsThinkingMenuOpen((prev) => !prev);
                    setIsModelMenuOpen(false);
                  }}
                >
                  <Brain size={12} className={activeThinking.toneClass} />
                  <span>{activeThinking.label}</span>
                  <ChevronDown
                    size={12}
                    className={`text-loop-400 transition-transform ${isThinkingMenuOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                {isThinkingMenuOpen ? (
                  <div
                    className="absolute bottom-full left-0 z-20 mb-2 w-32 rounded-xl border border-loop-700/80 bg-loop-900 p-1 shadow-2xl shadow-black/40"
                    role="menu"
                  >
                    {thinkingOptionsForModel.map((option) => {
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
                              : 'text-loop-300 hover:bg-loop-800 hover:text-loop-100'
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

            <div className="flex items-center gap-1.5">
              {isSending && (
                <button
                  className="inline-flex h-7 min-w-[32px] items-center justify-center gap-1.5 rounded-full bg-loop-700 px-2.5 text-[11px] font-semibold text-loop-300 shadow-sm transition hover:bg-loop-600 hover:text-white"
                  type="button"
                  onClick={() => void onStop()}
                >
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                  <span>Stop</span>
                </button>
              )}
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
          </div>
        </form>
      </div>
    </KeyboardShortcut>
  );
}
