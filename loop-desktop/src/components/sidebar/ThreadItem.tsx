import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '../../types/ui';
import { formatRelativeTime } from '../../utils/parsers';

const SPINNER_FRAMES = ['⣾', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽'];

function BrailleSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="mt-[-1px] inline-block animate-googleText font-sans text-[15px] leading-none">
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

interface ThreadItemProps {
  conversation: ConversationSummary;
  isActive: boolean;
  isWorking: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

export function ThreadItem({
  conversation,
  isActive,
  isWorking,
  onSelect,
  onDelete,
  onRename,
}: ThreadItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(conversation.title);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEditValue(conversation.title);
  }, [conversation.title]);

  useLayoutEffect(() => {
    if (isMenuOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuCoords({
        x: rect.right,
        y: rect.bottom + 4,
      });
    }
  }, [isMenuOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRenameSubmit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed);
    } else {
      setEditValue(conversation.title);
    }
    setIsEditing(false);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`group relative flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-[13px] transition-all ${
        isActive ? 'bg-blue-500/10 font-medium text-blue-400' : 'text-loop-400 hover:bg-loop-700 hover:text-loop-200'
      }`}
      onClick={() => {
        if (!isEditing && !isMenuOpen) {
          onSelect();
        }
      }}
      onKeyDown={(event) => {
        if (!isEditing && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex w-[15px] shrink-0 items-center justify-center">{isWorking && <BrailleSpinner />}</div>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 pr-1">
          {isEditing ? (
            <input
              ref={inputRef}
              className="w-full select-text rounded border border-blue-500/50 bg-loop-900 px-1.5 py-0.5 text-loop-200 outline-none"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') handleRenameSubmit();
                if (e.key === 'Escape') {
                  setEditValue(conversation.title);
                  setIsEditing(false);
                }
              }}
              onBlur={handleRenameSubmit}
            />
          ) : (
            <>
              <span className="truncate leading-tight">{conversation.title}</span>
              {conversation.updatedAt && (
                <span className="shrink-0 whitespace-nowrap text-[10px] text-loop-500 opacity-60 transition-opacity group-hover:opacity-0">
                  {formatRelativeTime(conversation.updatedAt)}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {!isEditing && (
        <div className="relative flex items-center gap-2">
          <button
            ref={buttonRef}
            type="button"
            className={`p-0.5 text-loop-500 transition-colors hover:text-loop-200 ${
              isActive || isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
            onClick={(event) => {
              event.stopPropagation();
              setIsMenuOpen(!isMenuOpen);
            }}
            aria-label="More options"
          >
            <MoreHorizontal size={14} />
          </button>

          {isMenuOpen &&
            menuCoords &&
            createPortal(
              <AnimatePresence>
                <motion.div
                  ref={menuRef}
                  initial={{ opacity: 0, scale: 0.95, y: -5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -5 }}
                  transition={{ duration: 0.1 }}
                  style={{
                    position: 'fixed',
                    top: menuCoords.y,
                    left: menuCoords.x,
                    transform: 'translateX(-100%)',
                  }}
                  className="z-[9999] w-32 overflow-hidden rounded-lg border border-loop-700/50 bg-loop-800 py-1 shadow-2xl shadow-black/50"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-loop-300 transition-colors hover:bg-loop-700 hover:text-loop-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      setIsEditing(true);
                    }}
                  >
                    <Pencil size={12} />
                    Rename
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 transition-colors hover:bg-loop-700/50 hover:text-red-300"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                </motion.div>
              </AnimatePresence>,
              document.body,
            )}
        </div>
      )}
    </div>
  );
}
