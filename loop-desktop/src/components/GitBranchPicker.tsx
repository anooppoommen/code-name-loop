import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface GitBranchPickerProps {
  value: string;
  branches: string[];
  onSelect: (branch: string) => void | Promise<void>;
  onCreate?: (branch: string) => void | Promise<void>;
  allowCreate?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyStateLabel?: string;
}

export function GitBranchPicker({
  value,
  branches,
  onSelect,
  onCreate,
  allowCreate = false,
  disabled = false,
  searchPlaceholder = 'Find a branch...',
  emptyStateLabel = 'No branches found',
}: GitBranchPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const normalizedValue = value || 'main';
  const availableBranches = useMemo(() => {
    const merged = new Set(branches);
    if (normalizedValue) {
      merged.add(normalizedValue);
    }
    return Array.from(merged);
  }, [branches, normalizedValue]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      return;
    }

    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    window.setTimeout(() => inputRef.current?.focus(), 50);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const filteredBranches = availableBranches.filter((branch) =>
    branch.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const exactMatch = availableBranches.some((branch) => branch.toLowerCase() === searchQuery.toLowerCase());
  const createCandidate = searchQuery.trim();
  const showCreateOption = allowCreate && !!onCreate && createCandidate !== '' && !exactMatch;

  const handleSelect = async (branch: string, create = false) => {
    if (disabled) {
      return;
    }

    if (create && onCreate) {
      await onCreate(branch);
    } else {
      await onSelect(branch);
    }
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
        className={`flex items-center gap-1.5 text-[12px] transition-colors focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 ${
          disabled ? 'cursor-not-allowed text-loop-500' : 'group text-white/70 hover:text-white'
        }`}
      >
        <span
          className={`font-mono pb-[1px] leading-none ${
            disabled
              ? ''
              : 'border-b border-dotted border-white/40 transition-colors group-hover:border-white/80'
          }`}
        >
          {normalizedValue}
        </span>
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </button>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 bottom-full z-50 mb-2 flex w-56 flex-col rounded-xl border border-loop-700 bg-loop-900 p-1.5 shadow-xl shadow-black/50"
          >
            <div className="px-1.5 py-1">
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded border border-loop-800 bg-loop-950 px-2 py-1 text-[11px] text-loop-200 placeholder-loop-500 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              />
            </div>

            <div className="mt-1 max-h-48 flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-loop-700 scrollbar-track-transparent">
              {showCreateOption ? (
                <button
                  type="button"
                  onClick={() => void handleSelect(createCandidate, true)}
                  className="group flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] text-loop-200 hover:bg-blue-500/15 hover:text-blue-200"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">Create branch</span>
                    <span className="truncate font-mono text-loop-400 group-hover:text-blue-300">
                      {createCandidate}
                    </span>
                  </div>
                  <svg
                    className="h-3 w-3 shrink-0 text-loop-500 group-hover:text-blue-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              ) : null}

              {filteredBranches.length > 0 && showCreateOption ? (
                <div className="mx-1 my-1 h-px bg-loop-800" />
              ) : null}

              {filteredBranches.map((branch) => {
                const isActive = branch === normalizedValue;
                return (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => void handleSelect(branch)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors ${
                      isActive ? 'bg-blue-500/10 text-blue-300' : 'text-loop-200 hover:bg-loop-800'
                    }`}
                  >
                    <span className="truncate font-mono">{branch}</span>
                    {isActive ? (
                      <svg
                        className="h-3 w-3 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : null}
                  </button>
                );
              })}

              {filteredBranches.length === 0 && !showCreateOption ? (
                <div className="px-2 py-3 text-center text-[11px] text-loop-500">
                  {emptyStateLabel}
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
