import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronUp,
  Edit3,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Settings2,
  Trash2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { shortID, formatRelativeTime } from '../utils/parsers';
import type { ConversationSummary, WorkspaceSummary } from '../types/ui';

interface SidebarProps {
  backendUrl: string;
  onBackendUrlChange: (value: string) => void;

  onPickFolder: () => void;
  onDeleteWorkspace: (workspaceId: string) => void;

  hideLifecycle: boolean;
  onHideLifecycleChange: (value: boolean) => void;

  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;

  conversations: ConversationSummary[];
  selectedConversationId: string;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
}

function ThreadItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onRename,
}: {
  conversation: ConversationSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(conversation.title);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
    if (editValue.trim() && editValue.trim() !== conversation.title) {
      onRename(editValue.trim());
    } else {
      setEditValue(conversation.title);
    }
    setIsEditing(false);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`group relative flex w-full cursor-pointer items-center justify-between rounded-lg pl-8 pr-2 py-1.5 text-[13px] transition-all ${isActive
        ? 'bg-blue-500/10 text-blue-400 font-medium'
        : 'text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
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
        {isEditing ? (
          <input
            ref={inputRef}
            className="w-full bg-neutral-900 border border-blue-500/50 rounded px-1.5 py-0.5 text-neutral-200 outline-none"
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
          <div className="flex flex-col min-w-0">
            <span className="truncate leading-tight pl-0">{conversation.title}</span>
            {conversation.updatedAt && (
              <span className="truncate text-[10px] text-neutral-500">
                {formatRelativeTime(conversation.updatedAt)}
              </span>
            )}
          </div>
        )}
      </div>

      {!isEditing && (
        <div className="flex items-center gap-2 relative">
          <button
            ref={buttonRef}
            type="button"
            className={`text-neutral-500 hover:text-neutral-200 transition-colors ${isActive || isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} p-0.5`}
            onClick={(event) => {
              event.stopPropagation();
              setIsMenuOpen(!isMenuOpen);
            }}
            aria-label="More options"
          >
            <MoreHorizontal size={14} />
          </button>

          {isMenuOpen && menuCoords && createPortal(
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
                  transform: 'translateX(-100%)', // Shift left by its own width since x is the right edge
                }}
                className="w-32 rounded-lg bg-neutral-800 border border-neutral-700/50 shadow-2xl shadow-black/50 z-[9999] overflow-hidden py-1"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
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
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-neutral-700/50 hover:text-red-300 transition-colors"
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
            document.body
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  backendUrl,
  onBackendUrlChange,
  onPickFolder,
  onDeleteWorkspace,
  hideLifecycle,
  onHideLifecycleChange,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
}: SidebarProps) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <aside className="no-drag flex h-full min-h-0 w-[260px] flex-col gap-3 border-r border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-300 pt-10">
      <nav className="flex flex-col gap-1">
        <button
          className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          onClick={onNewConversation}
          disabled={!selectedWorkspaceId}
        >
          <Edit3 size={15} className="text-neutral-400 group-hover:text-neutral-200" />
          <span>New thread</span>
        </button>
      </nav>

      <section className="flex min-h-0 flex-col gap-2 mt-2">
        <header className="flex items-center justify-between px-2 text-xs font-medium text-neutral-400">
          <div className="flex items-center gap-2">
            <span>Workspace</span>
          </div>
          <div className="flex gap-3">
            <button
              className="hover:text-neutral-200 transition-colors"
              onClick={onPickFolder}
              title="Pick Folder to Create Workspace from"
            >
              <FolderPlus size={14} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto mt-1">
          {workspaces.map((ws) => {
            const isSelected = ws.id === selectedWorkspaceId;
            return (
              <div key={ws.id} className="flex flex-col gap-0.5">
                <div className="group/ws relative flex w-full flex-col">
                  {/* Workspace Folder Header */}
                  <button
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] text-neutral-300 transition-colors hover:bg-neutral-700"
                    onClick={() => onSelectWorkspace(ws.id)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isSelected ? (
                        <FolderOpen size={15} className="text-neutral-400 shrink-0" />
                      ) : (
                        <Folder size={15} className="text-neutral-400 shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="truncate leading-tight font-medium text-neutral-200">{ws.name}</span>
                        <span className="truncate text-[10px] text-neutral-400 font-mono" title={ws.rootPath}>{shortID(ws.id)} • {ws.rootPath}</span>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="absolute right-0 top-[50%] -translate-y-[50%] text-neutral-500 hover:text-red-400 opacity-0 group-hover/ws:opacity-100 p-2 transition-all"
                    onClick={() => onDeleteWorkspace(ws.id)}
                    title="Delete Workspace"
                    aria-label="Delete workspace"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                {/* Workspace Threads (if expanded) */}
                {isSelected && (
                  <div className="flex flex-col gap-0.5 pr-2">
                    {conversations.length === 0 ? (
                      <p className="pl-8 text-[12px] text-neutral-500 py-1">No threads</p>
                    ) : (
                      conversations.map((conversation) => {
                        const isActive = conversation.id === selectedConversationId;
                        return (
                          <ThreadItem
                            key={conversation.id}
                            conversation={conversation}
                            isActive={isActive}
                            onSelect={() => onSelectConversation(conversation.id)}
                            onDelete={() => onDeleteConversation(conversation.id)}
                            onRename={(title) => onRenameConversation(conversation.id, title)}
                          />
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Settings at Bottom */}
      <section className="mt-auto flex flex-col pt-4">
        <button
          type="button"
          className="group flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-neutral-200"
          onClick={() => setShowSettings((prev) => !prev)}
        >
          <span className="inline-flex items-center gap-3">
            <Settings2 size={15} className="text-neutral-400 group-hover:text-neutral-200" />
            Settings
          </span>
          {showSettings ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {showSettings && (
          <div className="mt-3 flex flex-col gap-2 rounded-xl bg-neutral-900 border border-neutral-800/50 p-3 text-[12px] shadow-sm">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-neutral-500">API</label>
              <input
                className="w-full rounded-md border border-neutral-700/50 bg-neutral-900 px-2 py-1.5 text-neutral-300 outline-none transition-colors focus:border-blue-500/50 focus:bg-neutral-800 focus:ring-1 focus:ring-blue-500/50"
                value={backendUrl}
                onChange={(event) => onBackendUrlChange(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer pt-1 text-neutral-400 hover:text-neutral-300 transition-colors">
              <input
                type="checkbox"
                checked={hideLifecycle}
                onChange={(e) => onHideLifecycleChange(e.target.checked)}
                className="rounded border-neutral-700 bg-neutral-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-neutral-900 cursor-pointer"
              />
              <span className="text-[11px] font-medium uppercase tracking-wider">Hide Lifecycle</span>
            </label>
          </div>
        )}
      </section>
    </aside>
  );
}
