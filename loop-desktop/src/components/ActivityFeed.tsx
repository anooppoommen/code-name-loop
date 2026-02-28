import {
  ArrowDown,
  AlertTriangle,
  Bot,
  Brain,
  Cog,
  GitBranch,
  Info,
  UserRound,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PatchViewer } from './PatchViewer';
import type { ActivityEvent, ActivityKind } from '../types/ui';
import { shortID } from '../utils/parsers';

interface ActivityFeedProps {
  events: ActivityEvent[];
  conversationId: string;
  containerRef: RefObject<HTMLDivElement | null>;
}

const BOTTOM_THRESHOLD_PX = 24;

export function ActivityFeed({ events, conversationId, containerRef }: ActivityFeedProps) {
  const [visibleChars, setVisibleChars] = useState<Record<string, number>>({});
  const [copiedToolID, setCopiedToolID] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUserScrolled, setHasUserScrolled] = useState(false);
  const programmaticScrollRef = useRef(false);
  const stickyBottomRef = useRef(true);
  const pendingInitialSnapRef = useRef(false);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      const node = containerRef.current;
      if (!node) {
        return;
      }

      programmaticScrollRef.current = true;
      node.scrollTo({
        top: node.scrollHeight,
        behavior,
      });
      setIsAtBottom(true);
      stickyBottomRef.current = true;

      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    },
    [containerRef],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const getIsNearBottom = (): boolean =>
      node.scrollHeight - (node.scrollTop + node.clientHeight) <= BOTTOM_THRESHOLD_PX;

    const onScroll = (): void => {
      if (programmaticScrollRef.current) {
        return;
      }

      setHasUserScrolled(true);
      const nearBottom = getIsNearBottom();
      setIsAtBottom(nearBottom);
      stickyBottomRef.current = nearBottom;
    };

    const nearBottom = getIsNearBottom();
    setIsAtBottom(nearBottom);
    stickyBottomRef.current = nearBottom;

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [containerRef]);

  useEffect(() => {
    setHasUserScrolled(false);
    setIsAtBottom(true);
    stickyBottomRef.current = true;
    pendingInitialSnapRef.current = true;
  }, [conversationId, scrollToBottom]);

  useLayoutEffect(() => {
    if (!pendingInitialSnapRef.current) {
      return;
    }

    scrollToBottom('auto');
    if (events.length > 0) {
      pendingInitialSnapRef.current = false;
    }
  }, [events, scrollToBottom]);

  useEffect(() => {
    setVisibleChars((prev) => {
      const next: Record<string, number> = {};
      let changed = false;

      for (const event of events) {
        const fullText = primaryTextForEvent(event, eventHeadline(event));
        const prior = prev[event.id] ?? 0;

        if (!event.streaming || (event.kind !== 'assistant' && event.kind !== 'thought')) {
          next[event.id] = fullText.length;
        } else {
          next[event.id] = Math.min(prior, fullText.length);
        }
      }

      if (Object.keys(prev).length !== Object.keys(next).length) {
        changed = true;
      } else {
        for (const key of Object.keys(next)) {
          if (next[key] !== prev[key]) {
            changed = true;
            break;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [events]);

  useEffect(() => {
    const streaming = events.filter(
      (event) => event.streaming && (event.kind === 'assistant' || event.kind === 'thought'),
    );
    if (streaming.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setVisibleChars((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const event of streaming) {
          const fullText = primaryTextForEvent(event, eventHeadline(event));
          const current = next[event.id] ?? 0;
          const step = event.kind === 'assistant' ? 3 : 5;
          const target = fullText.length;
          const advanced = Math.min(target, current + step);
          if (advanced !== current) {
            next[event.id] = advanced;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, 34);

    return () => window.clearInterval(timer);
  }, [events]);

  useEffect(() => {
    if (!stickyBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [events, scrollToBottom, visibleChars]);

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div
        ref={containerRef}
        className={`flex-1 overflow-y-auto px-6 py-4 ${hasUserScrolled ? '' : 'scrollbar-hidden'}`}
      >
        {events.length === 0 ? (
          <p className="m-0 px-4 py-3 text-sm text-neutral-500">No run activity yet. Send a task to start streaming events.</p>
        ) : (
          events.map((event) => {
            const icon = iconFor(event.kind);

            if (event.kind === 'status') {
              return (
                <div
                  key={event.id}
                  className="flex items-center gap-4 border-l-2 border-transparent px-6 py-1.5 text-[11px] font-normal text-neutral-500 opacity-75 transition-colors"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center text-neutral-600">
                    {icon}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{event.title}</span>
                    {event.body ? <span className="truncate text-neutral-600">{event.body}</span> : null}
                  </div>
                </div>
              );
            }

            const toolPhase = toolPhaseLabel(event);
            const headline = eventHeadline(event);
            const visual = visualStyleFor(event);

            const isUser = event.kind === 'user';
            const isAsst = event.kind === 'assistant';
            const isSystemEvent = !isUser && !isAsst;
            const bodyText = primaryTextForEvent(event, headline);
            const renderedText = bodyText.slice(0, visibleChars[event.id] ?? bodyText.length);
            const copyCommand = toolCommandForCopy(event);

            return (
              <article
                key={event.id}
                className={`group flex gap-4 border-l-2 px-6 py-3 transition-colors ${visual.row}`}
              >
                <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${visual.icon}`}>
                  {isUser ? <UserRound size={20} /> : isAsst ? <Bot size={20} /> : icon}
                </div>

                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold text-neutral-200">
                      {isUser ? 'You' : isAsst ? 'Agent' : 'System'}
                    </span>
                    <time className="text-[11px] font-medium text-neutral-500">
                      {new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </time>

                    {isSystemEvent ? (
                      <div className="ml-2 flex items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                          {labelFor(event.kind)}
                        </span>
                        {event.tool?.callId ? (
                          <span className="font-mono text-[10px] text-neutral-500">
                            {shortID(event.tool.callId)}
                          </span>
                        ) : null}
                        {event.tool ? (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${event.tool.success === false
                              ? 'bg-red-500/10 text-red-500'
                              : 'bg-blue-500/10 text-blue-500'
                              }`}
                          >
                            {toolPhase}
                          </span>
                        ) : null}
                        {copyCommand ? (
                          <button
                            type="button"
                            className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                            onClick={() => void copyToolCommand(copyCommand, event.id, setCopiedToolID)}
                          >
                            {copiedToolID === event.id ? 'Copied' : 'Copy cmd'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className={`text-[15px] leading-relaxed ${visual.copy}`}>
                    <MarkdownBlock text={renderedText} />

                    {(event.tool?.name === 'apply_patch' || event.tool?.name?.endsWith(':apply_patch')) && (event.tool.command || event.body) ? (
                      <div className="mt-2 text-xs">
                        {event.body && (event.tool.phase === 'result' || event.tool.error) && event.body !== event.tool.command ? (
                          <div className={`mb-2 whitespace-pre-wrap rounded-md px-3 py-2 text-xs leading-relaxed ${visual.detail}`}>
                            {event.body}
                          </div>
                        ) : null}
                        <PatchViewer patchText={event.tool.command || event.body || ''} />
                      </div>
                    ) : isSystemEvent && event.kind !== 'thought' && event.body ? (
                      <pre className={`mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md px-3 py-2 text-xs leading-relaxed scrollbar-thin ${visual.detail}`}>
                        {event.body}
                      </pre>
                    ) : null}
                    {event.streaming ? <span className="animate-pulse text-neutral-500">▍</span> : null}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
      {!isAtBottom && events.length > 0 ? (
        <button
          type="button"
          className="absolute bottom-4 right-5 z-10 inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs font-medium text-neutral-200 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:border-neutral-500 hover:bg-neutral-800"
          onClick={() => scrollToBottom('smooth')}
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={14} />
          Latest
        </button>
      ) : null}
    </section>
  );
}

function toolCommandForCopy(event: ActivityEvent): string {
  if (event.kind !== 'tool' || !event.tool?.command) {
    return '';
  }
  if (event.tool.name !== 'shell' && event.tool.name !== 'exec_command') {
    return '';
  }
  return event.tool.command;
}

async function copyToolCommand(
  command: string,
  eventID: string,
  setCopiedToolID: (value: string) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    setCopiedToolID(eventID);
    window.setTimeout(() => {
      setCopiedToolID('');
    }, 1200);
  } catch {
    // Clipboard support can vary by runtime.
  }
}

function eventHeadline(event: ActivityEvent): string {
  if (event.kind !== 'tool' || !event.tool) {
    return event.title;
  }

  const phaseLabel = toolPhaseLabel(event);
  const summary = event.tool.resultSummary ? ` (${event.tool.resultSummary})` : '';
  return `${event.tool.name} ${phaseLabel}${summary}`;
}

function toolPhaseLabel(event: ActivityEvent): string {
  if (!event.tool) {
    return '';
  }

  if (event.tool.phase === 'start') {
    return 'started';
  }

  if (event.tool.success === false) {
    return 'failed';
  }

  return 'completed';
}

function visualStyleFor(event: ActivityEvent): { row: string; icon: string; copy: string; detail: string } {
  if (event.kind === 'error' || event.tool?.success === false) {
    return {
      row: 'border-l-red-500/70 hover:bg-red-950/10',
      icon: 'bg-red-900/25 text-red-300',
      copy: 'text-red-100',
      detail: 'bg-red-950/20 text-red-100',
    };
  }

  if (event.kind === 'tool') {
    return {
      row: 'border-l-blue-500/50 hover:bg-blue-950/10',
      icon: 'bg-blue-900/25 text-blue-200',
      copy: 'text-neutral-200',
      detail: 'bg-neutral-900/40 text-blue-100',
    };
  }

  if (event.kind === 'thought') {
    return {
      row: 'border-l-neutral-500/80 hover:bg-neutral-800/35',
      icon: 'bg-neutral-700/70 text-neutral-200',
      copy: 'text-neutral-200',
      detail: 'bg-neutral-900/50 text-neutral-300',
    };
  }

  return {
    row: 'border-l-neutral-700/80 hover:bg-neutral-800/35',
    icon: 'bg-neutral-800/80 text-neutral-400',
    copy: 'text-neutral-300',
    detail: 'bg-neutral-900/50 text-neutral-400',
  };
}

function primaryTextForEvent(event: ActivityEvent, headline: string): string {
  if (event.kind === 'thought') {
    return event.body || headline;
  }

  if (event.kind === 'assistant' || event.kind === 'user') {
    return event.body || headline;
  }

  return headline;
}

function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="m-0 break-words text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-0 text-2xl font-bold tracking-tight text-neutral-100">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-4 text-xl font-semibold tracking-tight text-neutral-100">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-lg font-semibold text-neutral-100">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-2 mt-3 text-base font-semibold uppercase tracking-wide text-neutral-200">{children}</h4>
          ),
          p: ({ children }) => <p className="m-0 mb-3 leading-7 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="m-0 mb-3 list-disc space-y-1 pl-6 marker:text-neutral-500">{children}</ul>,
          ol: ({ children }) => <ol className="m-0 mb-3 list-decimal space-y-1 pl-6 marker:text-neutral-500">{children}</ol>,
          li: ({ children }) => <li className="[&>p]:mb-0">{children}</li>,
          a: ({ children, href }) => (
            <a
              className="font-medium text-sky-300 underline decoration-sky-400/60 underline-offset-2 transition-colors hover:text-sky-200"
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-neutral-600/80 pl-4 italic text-neutral-300">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-0 border-t border-neutral-700/80" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto rounded-lg border border-neutral-800">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-neutral-800/70 text-neutral-200">{children}</thead>,
          tbody: ({ children }) => <tbody className="bg-neutral-900/35">{children}</tbody>,
          tr: ({ children }) => <tr className="border-t border-neutral-800 first:border-t-0">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top text-neutral-300">{children}</td>,
          code: ({ children, className }) => {
            const isCodeBlock = Boolean(className && className.startsWith('language-'));
            if (isCodeBlock) {
              return (
                <code className="font-mono text-[12px] text-neutral-100">
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-neutral-800/95 px-1.5 py-0.5 font-mono text-[12px] text-neutral-100">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-3 mt-2 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950/85 p-3 text-[12px] leading-relaxed text-neutral-200">
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function labelFor(kind: ActivityKind): string {
  switch (kind) {
    case 'user':
      return 'USER';
    case 'assistant':
      return 'ASSISTANT';
    case 'thought':
      return 'THOUGHT';
    case 'status':
      return 'STATUS';
    case 'tool':
      return 'TOOL';
    case 'thread':
      return 'THREAD';
    case 'error':
      return 'ERROR';
    default:
      return 'LIFECYCLE';
  }
}



function iconFor(kind: ActivityKind) {
  switch (kind) {
    case 'user':
      return <UserRound size={14} />;
    case 'assistant':
      return <Bot size={14} />;
    case 'thought':
      return <Brain size={14} />;
    case 'status':
      return <Info size={14} />;
    case 'tool':
      return <Cog size={14} />;
    case 'thread':
      return <GitBranch size={14} />;
    case 'error':
      return <AlertTriangle size={14} />;
    default:
      return <Workflow size={14} />;
  }
}
