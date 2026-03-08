import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, Plus } from 'lucide-react';
import type { ComposerModel, ThinkingLevel } from '../../types/ui';
import { getAllowedThinkingLevelsForModel } from '../../hooks/useLoopDesktop.helpers';

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

interface ComposerToolbarProps {
  composerModel: ComposerModel;
  onComposerModelChange: (value: ComposerModel) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (value: ThinkingLevel) => void;
  onOpenFilePicker: () => void;
}

export const ComposerToolbar = memo(function ComposerToolbar({
  composerModel,
  onComposerModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  onOpenFilePicker,
}: ComposerToolbarProps) {
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const [isThinkingMenuOpen, setIsThinkingMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);

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

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onOpenFilePicker}
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
            setIsModelMenuOpen((previous) => !previous);
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
            setIsThinkingMenuOpen((previous) => !previous);
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
  );
});
