import {
  AlertTriangle,
  Bot,
  Brain,
  Cog,
  GitBranch,
  Info,
  UserRound,
  Workflow,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PatchViewer } from '../PatchViewer';
import {
  CommandToolCard,
  RequestUserInputCard,
  UpdatePlanCard,
  parseCommandToolPayload,
  parseParallelToolPayload,
  parseRequestUserInputPayload,
  parseUpdatePlanPayload,
} from '../tool-cards';
import type { ToolReplyActions } from '../tool-cards';
import type { ActivityEvent, ActivityKind } from '../../types/ui';
import { shortID } from '../../utils/parsers';
import { textTargetForEvent } from './textTarget';
import { parseToolCommand } from '../../utils/activityTimeline';

export interface ActivityItemProps extends ToolReplyActions {
  event: ActivityEvent;
  visibleChars?: number;
  isCopied: boolean;
  onCopyToolCommand: (command: string, id: string) => void;
}

export const ActivityItem = memo(function ActivityItem({
  event,
  visibleChars,
  isCopied,
  onCopyToolCommand,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
}: ActivityItemProps) {
  const icon = iconFor(event.kind);

  if (event.kind === 'status') {
    return (
      <div className="flex items-center border-l-2 border-transparent px-6 py-1 text-[11px] font-normal text-neutral-500 opacity-75 transition-colors">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{event.title}</span>
          {event.body ? <span className="truncate text-neutral-600">{event.body}</span> : null}
        </div>
      </div>
    );
  }

  const toolPhase = toolPhaseLabel(event);
  const visual = visualStyleFor(event);

  const isUser = event.kind === 'user';
  const isAsst = event.kind === 'assistant';
  const isSystemEvent = !isUser && !isAsst;
  const bodyText = textTargetForEvent(event);
  const renderedText = bodyText.slice(0, visibleChars ?? bodyText.length);
  const copyCommand = toolCommandForCopy(event);
  const requestInputPayload = parseRequestUserInputPayload(event);
  const updatePlanPayload = parseUpdatePlanPayload(event);
  const parallelToolPayload = parseParallelToolPayload(event);
  const commandToolPayload = parseCommandToolPayload(event);
  const isPatchToolEvent =
    event.tool?.name === 'apply_patch' || event.tool?.name?.endsWith(':apply_patch');
  const isReadFileEvent =
    event.tool?.name === 'read_file' || event.tool?.name?.endsWith(':read_file');

  if (event.kind === 'thought') {
    return (
      <ThoughtMessage renderedText={renderedText} isStreaming={!!event.streaming} />
    );
  }

  if (parallelToolPayload) {
    return (
      <article className="py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-6 mb-2 flex items-center gap-2">
            <Workflow size={14} className="text-neutral-500" />
            <div className="text-[12px] font-semibold tracking-wider text-neutral-500">
              Executing {parallelToolPayload.results.length} tool{parallelToolPayload.results.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="flex flex-col relative before:absolute before:inset-y-0 before:left-8 before:w-[2px] before:bg-neutral-800/50">
            {parallelToolPayload.results.map((result, idx) => {
              const nestedEvent = buildParallelNestedEvent(event, idx, result);
              const nestedRequestInputPayload = parseRequestUserInputPayload(nestedEvent);
              const nestedUpdatePlanPayload = parseUpdatePlanPayload(nestedEvent);
              const nestedCommandToolPayload = parseCommandToolPayload(nestedEvent);
              const nestedIsPatchToolEvent =
                nestedEvent.tool?.name === 'apply_patch' || nestedEvent.tool?.name?.endsWith(':apply_patch');
              const nestedIsReadFileEvent =
                nestedEvent.tool?.name === 'read_file' || nestedEvent.tool?.name?.endsWith(':read_file');
              const nestedFallbackText = textTargetForEvent(nestedEvent);

              return (
                <div key={nestedEvent.id} className="ml-6 py-2 pl-5">
                  <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500">
                    <Cog size={12} className="text-neutral-500" />
                    <span>{nestedEvent.tool?.name || 'tool'}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${nestedEvent.tool?.success === false
                          ? 'bg-red-500/10 text-red-500'
                          : 'bg-blue-500/10 text-blue-500'
                        }`}
                    >
                      {nestedEvent.tool?.success === false ? 'failed' : 'completed'}
                    </span>
                  </div>

                  {nestedRequestInputPayload ? (
                    <RequestUserInputCard
                      payload={nestedRequestInputPayload}
                      canCompose={canCompose}
                      isSending={isSending}
                      onUseToolReply={onUseToolReply}
                      onSendToolReply={onSendToolReply}
                    />
                  ) : nestedCommandToolPayload ? (
                    <CommandToolCard payload={nestedCommandToolPayload} />
                  ) : nestedUpdatePlanPayload ? (
                    <UpdatePlanCard payload={nestedUpdatePlanPayload} />
                  ) : nestedIsPatchToolEvent && (nestedEvent.tool?.command || nestedEvent.body) ? (
                    <div className="space-y-2">
                      {nestedEvent.body &&
                        (nestedEvent.tool?.phase === 'result' || nestedEvent.tool?.error) &&
                        nestedEvent.body !== nestedEvent.tool?.command ? (
                        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-900/35 px-3 py-2 text-xs leading-relaxed text-neutral-300 scrollbar-thin">
                          {nestedEvent.body}
                        </pre>
                      ) : null}
                      <PatchViewer patchText={nestedEvent.tool?.command || nestedEvent.body || ''} />
                    </div>
                  ) : nestedIsReadFileEvent && nestedEvent.tool?.command ? (
                    <div className="space-y-2">
                      <div className="text-[13px] font-bold text-blue-400">
                        {nestedEvent.tool.command}
                      </div>
                      {renderReadFileArgs(nestedEvent.tool?.args)}
                      {nestedEvent.body ? (
                        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-900/35 px-3 py-2 text-xs leading-relaxed text-neutral-300 scrollbar-thin">
                          {nestedEvent.body}
                        </pre>
                      ) : null}
                    </div>
                  ) : nestedFallbackText ? (
                    <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-900/35 px-3 py-2 text-xs leading-relaxed text-neutral-300 scrollbar-thin">
                      {nestedFallbackText}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </article>
    );
  }

  if (commandToolPayload) {
    return (
      <article className="py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <CommandToolCard payload={commandToolPayload} />
        </div>
      </article>
    );
  }

  if (isPatchToolEvent && (event.tool?.command || event.body)) {
    return (
      <article className="py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          {event.body && (event.tool?.phase === 'result' || event.tool?.error) && event.body !== event.tool?.command ? (
            <pre className="mb-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-900/35 px-3 py-2 text-xs leading-relaxed text-neutral-300 scrollbar-thin">
              {event.body}
            </pre>
          ) : null}
          <PatchViewer patchText={event.tool?.command || event.body || ''} />
        </div>
      </article>
    );
  }

  if (isReadFileEvent && event.tool?.command) {
    return (
      <article className="py-2">
        <div className="px-6">
          <div className="space-y-2">
            <div className="text-[13px] font-bold text-blue-400">
              {event.tool.command}
            </div>
            {renderReadFileArgs(event.tool?.args)}
            {event.body ? (
              <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-900/35 px-3 py-2 text-xs leading-relaxed text-neutral-300 scrollbar-thin">
                {event.body}
              </pre>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
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
                  onClick={() => onCopyToolCommand(copyCommand, event.id)}
                >
                  {isCopied ? 'Copied' : 'Copy cmd'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={`text-[15px] leading-relaxed ${visual.copy}`}>
          {event.images && event.images.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-2">
              {event.images.map((img, idx) => (
                <div key={idx} className="rounded-md border border-neutral-700 overflow-hidden w-48 h-auto bg-neutral-900">
                  <img src={img.dataUrl} alt="attached" className="w-full h-auto object-cover" />
                </div>
              ))}
            </div>
          ) : null}

          <MarkdownBlock text={renderedText} />

          {requestInputPayload ? (
            <RequestUserInputCard
              payload={requestInputPayload}
              canCompose={canCompose}
              isSending={isSending}
              onUseToolReply={onUseToolReply}
              onSendToolReply={onSendToolReply}
            />
          ) : commandToolPayload ? (
            <CommandToolCard payload={commandToolPayload} />
          ) : updatePlanPayload ? (
            <UpdatePlanCard payload={updatePlanPayload} />
          ) : isSystemEvent && event.body ? (
            <pre className={`mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md px-3 py-2 text-xs leading-relaxed scrollbar-thin ${visual.detail}`}>
              {event.body}
            </pre>
          ) : null}
          {event.streaming ? <span className="animate-pulse text-neutral-500">▍</span> : null}
        </div>
      </div>
    </article>
  );
});

function buildParallelNestedEvent(event: ActivityEvent, idx: number, result: { name: string; success: boolean; error: string; response?: Record<string, unknown> | null; arguments?: Record<string, unknown> | null }): ActivityEvent {
  const argsStr = result.arguments ? JSON.stringify(result.arguments) : '';
  const command = parseToolCommand(result.name, argsStr);

  let bodyText = '';
  if (result.response) {
    if ('output' in result.response && result.response.output !== undefined) {
      bodyText = String(result.response.output);
    } else {
      bodyText = JSON.stringify(result.response, null, 2);
    }
  } else if (result.error) {
    bodyText = result.error;
  }

  return {
    id: `${event.id}-inner-${idx}`,
    kind: 'tool',
    timestamp: event.timestamp + idx,
    title: `${result.name} ${result.success ? 'completed' : 'failed'}`,
    body: bodyText,
    tool: {
      name: result.name,
      phase: 'result',
      success: result.success,
      error: result.error || undefined,
      command: command || undefined,
      args: result.arguments || undefined,
      payload: result.response || undefined,
    },
  };
}

function renderReadFileArgs(args: Record<string, unknown> | null | undefined) {
  if (!args) {
    return null;
  }

  const filePath = typeof args.file_path === 'string' ? args.file_path : '';
  const offset = typeof args.offset === 'number' ? args.offset : null;
  const limit = typeof args.limit === 'number' ? args.limit : null;
  const hasFields = Boolean(filePath) || offset !== null || limit !== null;
  if (!hasFields) {
    return null;
  }

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px] leading-relaxed text-neutral-300">
      <div><span className="text-neutral-500">file_path:</span> {filePath || '-'}</div>
      <div><span className="text-neutral-500">offset:</span> {offset ?? 1}</div>
      <div><span className="text-neutral-500">limit:</span> {limit ?? 'default'}</div>
    </div>
  );
}

const ThoughtMessage = memo(function ThoughtMessage({
  renderedText,
  isStreaming,
}: {
  renderedText: string;
  isStreaming: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(renderedText.length > 150);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > 64);
    }
  }, [renderedText]);

  return (
    <article className="py-2">
      <div className="px-6">
        <div className="max-w-[620px] text-neutral-400">
          <div
            className={`overflow-hidden relative transition-[max-height] duration-300 ease-in-out ${isExpanded ? 'max-h-[5000px]' : (isOverflowing ? 'max-h-[64px]' : 'max-h-[5000px]')}`}
          >
            <div ref={contentRef}>
              <MarkdownBlock text={renderedText} compact />
              {isStreaming ? <span className="animate-pulse text-neutral-500">▍</span> : null}
            </div>
            {!isExpanded && isOverflowing && (
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-neutral-900 to-transparent pointer-events-none" />
            )}
          </div>
          {isOverflowing && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="mt-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              {isExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </div>
    </article>
  );
});

function toolCommandForCopy(event: ActivityEvent): string {
  if (event.kind !== 'tool' || !event.tool?.command) {
    return '';
  }
  if (event.tool.name !== 'shell' && event.tool.name !== 'exec_command') {
    return '';
  }
  return event.tool.command;
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

const MarkdownBlock = memo(function MarkdownBlock({ text, compact = false }: { text: string; compact?: boolean }) {
  const rootTextClass = compact
    ? 'm-0 break-words text-[13px] font-normal leading-relaxed text-neutral-400'
    : 'm-0 break-words text-[15px] leading-relaxed';
  const paragraphClass = compact ? 'm-0 mb-2 leading-6 last:mb-0' : 'm-0 mb-3 leading-7 last:mb-0';
  const listClass = compact
    ? 'm-0 mb-2 list-disc space-y-1 pl-6 marker:text-neutral-500'
    : 'm-0 mb-3 list-disc space-y-1 pl-6 marker:text-neutral-500';
  const orderedListClass = compact
    ? 'm-0 mb-2 list-decimal space-y-1 pl-6 marker:text-neutral-500'
    : 'm-0 mb-3 list-decimal space-y-1 pl-6 marker:text-neutral-500';
  const inlineCodeClass = compact
    ? 'rounded bg-neutral-800/95 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200'
    : 'rounded bg-neutral-800/95 px-1.5 py-0.5 font-mono text-[12px] text-neutral-100';
  const preClass = compact
    ? 'mb-2 mt-2 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950/85 p-3 text-[11px] leading-relaxed text-neutral-300'
    : 'mb-3 mt-2 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950/85 p-3 text-[12px] leading-relaxed text-neutral-200';

  return (
    <div className={rootTextClass}>
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
          p: ({ children }) => <p className={paragraphClass}>{children}</p>,
          ul: ({ children }) => <ul className={listClass}>{children}</ul>,
          ol: ({ children }) => <ol className={orderedListClass}>{children}</ol>,
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
                <code className={compact ? 'font-mono text-[11px] text-neutral-200' : 'font-mono text-[12px] text-neutral-100'}>
                  {children}
                </code>
              );
            }
            return (
              <code className={inlineCodeClass}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className={preClass}>
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

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
