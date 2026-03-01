import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, CornerDownLeft, MessageSquare, PlusSquare, Search, Split } from 'lucide-react';
import { requestJson } from '../lib/loopClient';
import type { WorkspaceSummary } from '../types/ui';
import { asRecord, formatRelativeTime, getString } from '../utils/parsers';
import { KeyboardShortcut } from './KeyboardShortcut';

interface CommandPaletteProps {
  open: boolean;
  backendUrl: string;
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  onClose: () => void;
  onStartNewConversation: (workspaceId: string) => Promise<void> | void;
  onOpenConversation: (workspaceId: string, conversationId: string) => Promise<void> | void;
}

interface PaletteWorkspaceResult {
  workspaceId: string;
  workspaceName: string;
  workspaceRootPath: string;
}

type PaletteMatchKind = 'title' | 'message' | 'running' | 'recent';

interface PaletteConversationResult {
  workspaceId: string;
  workspaceName: string;
  conversationId: string;
  rootConversationId: string;
  parentConversationId: string;
  title: string;
  isThread: boolean;
  threadStatus: string;
  updatedAt: string;
  matchKind: PaletteMatchKind;
  snippet: string;
}

interface PaletteSearchResults {
  workspaces: PaletteWorkspaceResult[];
  conversations: PaletteConversationResult[];
  activeTasks: PaletteConversationResult[];
}

type PaletteItem =
  | {
    id: string;
    section: 'Actions';
    kind: 'new_chat';
    workspaceId: string;
    title: string;
    subtitle: string;
    badge: string;
  }
  | {
    id: string;
    section: 'Running Tasks' | 'Chats';
    kind: 'conversation';
    workspaceId: string;
    conversationId: string;
    title: string;
    subtitle: string;
    detail: string;
    badge: string;
    relativeTime: string;
  };

const EMPTY_RESULTS: PaletteSearchResults = {
  workspaces: [],
  conversations: [],
  activeTasks: [],
};

export function CommandPalette({
  open,
  backendUrl,
  workspaces,
  selectedWorkspaceId,
  onClose,
  onStartNewConversation,
  onOpenConversation,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaletteSearchResults>(EMPTY_RESULTS);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestIDRef = useRef(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery('');
    setLoadError('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const fetchTimer = window.setTimeout(() => {
      const requestID = requestIDRef.current + 1;
      requestIDRef.current = requestID;
      setIsLoading(true);
      setLoadError('');

      const params = new URLSearchParams();
      const trimmedQuery = query.trim();
      if (trimmedQuery) {
        params.set('q', trimmedQuery);
      }
      params.set('limit', '14');

      void requestJson<unknown>({
        baseUrl: backendUrl,
        endpointPath: `/command-palette/search?${params.toString()}`,
        method: 'GET',
      }).then((response) => {
        if (requestID !== requestIDRef.current) {
          return;
        }

        setIsLoading(false);
        if (!response.ok) {
          setLoadError(response.error ?? `Failed to search (${response.status})`);
          setResults(EMPTY_RESULTS);
          return;
        }

        setResults(parsePaletteSearchResponse(response.data));
      });
    }, 120);

    return () => window.clearTimeout(fetchTimer);
  }, [backendUrl, open, query]);

  const actionItems = useMemo<PaletteItem[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const fallbackWorkspaces = workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRootPath: workspace.rootPath,
    }));
    const sourceWorkspaces = results.workspaces.length > 0 ? results.workspaces : fallbackWorkspaces;

    const items: PaletteItem[] = [];
    for (const workspace of sourceWorkspaces) {
      if (
        normalizedQuery &&
        !workspace.workspaceName.toLowerCase().includes(normalizedQuery) &&
        !workspace.workspaceRootPath.toLowerCase().includes(normalizedQuery) &&
        !'new chat'.includes(normalizedQuery)
      ) {
        continue;
      }

      items.push({
        id: `action:new:${workspace.workspaceId}`,
        section: 'Actions',
        kind: 'new_chat',
        workspaceId: workspace.workspaceId,
        title: `New chat in ${workspace.workspaceName}`,
        subtitle: workspace.workspaceRootPath,
        badge: workspace.workspaceId === selectedWorkspaceId ? 'Current' : 'Workspace',
      });
    }
    return items.slice(0, 8);
  }, [query, results.workspaces, selectedWorkspaceId, workspaces]);

  const runningConversationIDs = useMemo(() => {
    const ids = new Set<string>();
    for (const task of results.activeTasks) {
      ids.add(task.conversationId);
    }
    return ids;
  }, [results.activeTasks]);

  const runningItems = useMemo<PaletteItem[]>(() => {
    return results.activeTasks.map((task) => ({
      id: `running:${task.conversationId}`,
      section: 'Running Tasks',
      kind: 'conversation',
      workspaceId: task.workspaceId,
      conversationId: task.rootConversationId || task.conversationId,
      title: task.title,
      subtitle: task.workspaceName,
      detail: task.snippet || 'Running',
      badge: task.isThread ? 'Thread' : 'Chat',
      relativeTime: formatRelativeTime(task.updatedAt),
    }));
  }, [results.activeTasks]);

  const conversationItems = useMemo<PaletteItem[]>(() => {
    return results.conversations
      .filter((conversation) => !runningConversationIDs.has(conversation.conversationId))
      .map((conversation) => ({
        id: `conversation:${conversation.conversationId}`,
        section: 'Chats',
        kind: 'conversation',
        workspaceId: conversation.workspaceId,
        conversationId: conversation.rootConversationId || conversation.conversationId,
        title: conversation.title,
        subtitle: conversation.workspaceName,
        detail: describeConversationMatch(conversation),
        badge: conversation.isThread ? 'Thread' : 'Chat',
        relativeTime: formatRelativeTime(conversation.updatedAt),
      }));
  }, [results.conversations, runningConversationIDs]);

  const allItems = useMemo<PaletteItem[]>(
    () => [...actionItems, ...runningItems, ...conversationItems],
    [actionItems, conversationItems, runningItems],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    if (allItems.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => {
      if (current >= allItems.length) {
        return allItems.length - 1;
      }
      return current;
    });
  }, [allItems.length, open]);

  useEffect(() => {
    if (!open || allItems.length === 0) {
      return;
    }
    rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, allItems.length, open]);

  const executeItem = useCallback(
    (item: PaletteItem): void => {
      onClose();
      if (item.kind === 'new_chat') {
        void Promise.resolve(onStartNewConversation(item.workspaceId));
        return;
      }
      void Promise.resolve(onOpenConversation(item.workspaceId, item.conversationId));
    },
    [onClose, onOpenConversation, onStartNewConversation],
  );

  const onArrowDown = useCallback((): boolean => {
    if (allItems.length === 0) {
      return true;
    }
    setActiveIndex((current) => (current + 1) % allItems.length);
    return true;
  }, [allItems.length]);

  const onArrowUp = useCallback((): boolean => {
    if (allItems.length === 0) {
      return true;
    }
    setActiveIndex((current) => (current - 1 + allItems.length) % allItems.length);
    return true;
  }, [allItems.length]);

  const onEnter = useCallback((): boolean => {
    const selected = allItems[activeIndex];
    if (!selected) {
      return false;
    }
    executeItem(selected);
    return true;
  }, [activeIndex, allItems, executeItem]);

  const onEscape = useCallback((): boolean => {
    onClose();
    return true;
  }, [onClose]);

  const onKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (!(event.metaKey || event.ctrlKey)) {
      return false;
    }
    if (event.key.toLowerCase() !== 'k') {
      return false;
    }
    onClose();
    return true;
  }, [onClose]);

  const renderSection = useCallback(
    (title: PaletteItem['section'], items: PaletteItem[], offset: number) => {
      if (items.length === 0) {
        return null;
      }

      return (
        <section key={title} className="py-1">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-loop-500">{title}</p>
          <div className="space-y-0.5">
            {items.map((item, idx) => {
              const index = offset + idx;
              const isActive = index === activeIndex;
              const icon = item.kind === 'new_chat'
                ? <PlusSquare size={14} className={isActive ? 'text-blue-200' : 'text-loop-400'} />
                : title === 'Running Tasks'
                  ? <Activity size={14} className={isActive ? 'text-blue-200' : 'text-emerald-300'} />
                  : item.badge === 'Thread'
                    ? <Split size={14} className={isActive ? 'text-blue-200' : 'text-loop-400'} />
                    : <MessageSquare size={14} className={isActive ? 'text-blue-200' : 'text-loop-400'} />;

              return (
                <button
                  key={item.id}
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  type="button"
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${isActive
                    ? 'border-blue-400/40 bg-blue-500/12 text-loop-100'
                    : 'border-transparent text-loop-300 hover:border-loop-700 hover:bg-loop-800/70 hover:text-loop-200'
                    }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => executeItem(item)}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 shrink-0">{icon}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium">{item.title}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${isActive
                          ? 'bg-blue-500/20 text-blue-100'
                          : 'bg-loop-700/70 text-loop-400'
                          }`}>
                          {item.badge}
                        </span>
                      </div>
                      <p className="truncate pt-0.5 text-[11px] text-loop-500">
                        {item.subtitle}
                        {' · '}
                        {item.kind === 'new_chat' ? 'Start empty draft' : item.detail}
                        {item.kind === 'conversation' && item.relativeTime ? ` · ${item.relativeTime}` : ''}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      );
    },
    [activeIndex, executeItem],
  );

  const actionsOffset = 0;
  const runningOffset = actionItems.length;
  const chatsOffset = actionItems.length + runningItems.length;

  const isEmpty = !isLoading && !loadError && allItems.length === 0;

  return (
    <KeyboardShortcut
      priority={120}
      enabled={open}
      onArrowDown={onArrowDown}
      onArrowUp={onArrowUp}
      onEnter={onEnter}
      onEscape={onEscape}
      onKeyDown={onKeyDown}
    >
      <AnimatePresence>
        {open ? (
          <div className="pointer-events-auto fixed inset-0 z-[80] no-drag">
            <motion.button
              type="button"
              aria-label="Close command palette"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 bg-loop-950/70 backdrop-blur-[1px]"
              onClick={onClose}
            />

            <div className="absolute inset-0 flex items-center justify-center px-4">
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.985 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="w-full max-w-[760px] overflow-hidden rounded-2xl border border-loop-700/80 bg-loop-900/95 shadow-[0_26px_60px_-28px_rgba(0,0,0,0.9),0_10px_22px_-14px_rgba(0,0,0,0.75)]"
              >
                <div className="border-b border-loop-700/80 px-3 py-2.5">
                  <div className="flex items-center gap-2 rounded-lg bg-loop-800/75 px-2.5 py-2">
                    <Search size={15} className="shrink-0 text-loop-400" />
                    <input
                      ref={inputRef}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search chats, threads, and running work..."
                      className="w-full bg-transparent text-[14px] text-loop-100 outline-none placeholder:text-loop-500"
                    />
                    {isLoading ? (
                      <span className="shrink-0 rounded border border-loop-700 bg-loop-800 px-1.5 py-0.5 text-[10px] text-loop-400">
                        Searching
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="max-h-[60vh] overflow-y-auto px-2 py-1.5">
                  {renderSection('Actions', actionItems, actionsOffset)}
                  {renderSection('Running Tasks', runningItems, runningOffset)}
                  {renderSection('Chats', conversationItems, chatsOffset)}

                  {loadError ? (
                    <div className="px-2 py-4 text-[12px] text-red-300">{loadError}</div>
                  ) : null}

                  {isEmpty ? (
                    <div className="px-2 py-6 text-[12px] text-loop-500">
                      No matches. Try a workspace name, chat title, or message text.
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center justify-between border-t border-loop-700/80 px-3 py-2 text-[10px] text-loop-500">
                  <span className="inline-flex items-center gap-1">
                    <CornerDownLeft size={11} />
                    Open selection
                  </span>
                  <span>Esc to close</span>
                </div>
              </motion.div>
            </div>
          </div>
        ) : null}
      </AnimatePresence>
    </KeyboardShortcut>
  );
}

function describeConversationMatch(conversation: PaletteConversationResult): string {
  if (conversation.matchKind === 'message' && conversation.snippet) {
    return conversation.snippet;
  }
  if (conversation.matchKind === 'recent') {
    return 'Recent chat';
  }
  if (conversation.matchKind === 'running') {
    return conversation.snippet || 'Running';
  }
  return conversation.isThread ? 'Thread title match' : 'Chat title match';
}

function parsePaletteSearchResponse(payload: unknown): PaletteSearchResults {
  const record = asRecord(payload);

  const parseWorkspaces = (input: unknown): PaletteWorkspaceResult[] => {
    if (!Array.isArray(input)) {
      return [];
    }
    return input
      .map((row) => {
        const data = asRecord(row);
        const workspaceId = getString(data, ['workspace_id', 'workspaceId']);
        if (!workspaceId) {
          return null;
        }
        return {
          workspaceId,
          workspaceName: getString(data, ['workspace_name', 'workspaceName']) || workspaceId,
          workspaceRootPath: getString(data, ['workspace_root_path', 'workspaceRootPath']),
        };
      })
      .filter((row): row is PaletteWorkspaceResult => row !== null);
  };

  const parseConversations = (input: unknown): PaletteConversationResult[] => {
    if (!Array.isArray(input)) {
      return [];
    }
    return input
      .map((row) => {
        const data = asRecord(row);
        const conversationId = getString(data, ['conversation_id', 'conversationId']);
        const workspaceId = getString(data, ['workspace_id', 'workspaceId']);
        if (!conversationId || !workspaceId) {
          return null;
        }

        const rawMatchKind = getString(data, ['match_kind', 'matchKind']);
        const matchKind: PaletteMatchKind = rawMatchKind === 'title' ||
          rawMatchKind === 'message' ||
          rawMatchKind === 'running' ||
          rawMatchKind === 'recent'
          ? rawMatchKind
          : 'title';

        const isThreadValue = data?.is_thread ?? data?.isThread;
        return {
          workspaceId,
          workspaceName: getString(data, ['workspace_name', 'workspaceName']) || workspaceId,
          conversationId,
          rootConversationId: getString(data, ['root_conversation_id', 'rootConversationId']) || conversationId,
          parentConversationId: getString(data, ['parent_conversation_id', 'parentConversationId']),
          title: getString(data, ['title']) || conversationId,
          isThread: Boolean(isThreadValue),
          threadStatus: getString(data, ['thread_status', 'threadStatus']),
          updatedAt: getString(data, ['updated_at', 'updatedAt']),
          matchKind,
          snippet: getString(data, ['snippet']),
        };
      })
      .filter((row): row is PaletteConversationResult => row !== null);
  };

  return {
    workspaces: parseWorkspaces(record?.workspaces),
    conversations: parseConversations(record?.conversations),
    activeTasks: parseConversations(record?.active_tasks ?? record?.activeTasks),
  };
}
