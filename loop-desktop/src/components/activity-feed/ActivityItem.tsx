import {
  AlertTriangle,
  Brain,
  Cog,
  GitBranch,
  Info,
  Pencil,
  RotateCcw,
  UserRound,
  Workflow,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PatchViewer } from '../PatchViewer';
import {
  CommandToolCard,
  RequestUserInputCard,
  UpdatePlanCard,
  FileToolCard,
  parseCommandToolPayload,
  parseParallelToolPayload,
  parseRequestUserInputPayload,
  parseUpdatePlanPayload,
  parseFileToolPayload,
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
  onRetryMessage: (messageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}

interface ActivityFrameProps {
  children: ReactNode;
  className?: string;
  left?: ReactNode;
  right?: ReactNode;
  contentClassName?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

function ActivityFrame({
  children,
  className = '',
  left = null,
  right = null,
  contentClassName = '',
  onMouseEnter,
  onMouseLeave,
}: ActivityFrameProps) {
  return (
    <article className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="grid grid-cols-[48px_minmax(0,1fr)_48px] items-start gap-0">
        <div className="flex min-h-0 items-start justify-end pr-3">{left}</div>
        <div className={contentClassName}>{children}</div>
        <div className="flex min-h-0 items-start justify-start pl-2">{right}</div>
      </div>
    </article>
  );
}

export const ActivityItem = memo(function ActivityItem({
  event,
  visibleChars,
  canCompose,
  isSending,
  onUseToolReply,
  onSendToolReply,
  onRetryMessage,
  onEditMessage,
}: ActivityItemProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isUserHovered, setIsUserHovered] = useState(false);
  const icon = iconFor(event.kind);
  const userModel = event.userTurn?.model?.trim() || '';
  const userThinkingLevel = event.userTurn?.thinkingLevel?.trim() || '';
  const thinkingToneClass = userThinkingToneClass(userThinkingLevel);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedImage) {
        setSelectedImage(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedImage]);

  if (event.kind === 'status') {
    return (
      <ActivityFrame
        className="px-2 py-0.5 text-[11px] font-normal text-loop-500 opacity-75"
        left={<span className="mt-1 h-1.5 w-1.5 rounded-full bg-loop-600" />}
        contentClassName="min-w-0"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">{event.title}</span>
          {event.body ? <span className="truncate text-loop-600">{event.body}</span> : null}
        </div>
      </ActivityFrame>
    );
  }

  const toolPhase = toolPhaseLabel(event);
  const visual = visualStyleFor(event);
  const isUser = event.kind === 'user';
  const isAsst = event.kind === 'assistant';
  const isSystemEvent = !isUser && !isAsst;
  const bodyText = textTargetForEvent(event);
  const renderedText = bodyText.slice(0, visibleChars ?? bodyText.length);
  const requestInputPayload = parseRequestUserInputPayload(event);
  const updatePlanPayload = parseUpdatePlanPayload(event);
  const parallelToolPayload = parseParallelToolPayload(event);
  const commandToolPayload = parseCommandToolPayload(event);
  const fileToolPayload = parseFileToolPayload(event);
  const isPatchToolEvent =
    event.tool?.name === 'apply_patch' || event.tool?.name?.endsWith(':apply_patch');
  const systemErrorDetails = parseSystemErrorDetails(event);
  const leftGutterIcon =
    event.kind === 'tool' || event.kind === 'thought'
      ? null
      : <div className={visual.icon}>{icon}</div>;
  const userMessageActions =
    isUser && event.messageId ? (
      <AnimatePresence>
        {isUserHovered ? (
          <motion.div
            initial={{ opacity: 0, x: 6, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 6, scale: 0.96 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="flex flex-col items-center gap-1 pt-1"
          >
            <button
              type="button"
              aria-label="Retry from this message"
              title="Retry from this message"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isSending}
              onClick={() => {
                void onRetryMessage(event.messageId!);
              }}
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              aria-label="Edit this message"
              title="Edit this message"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isSending}
              onClick={() => {
                onEditMessage(event.messageId!, event.body || '', event.images || []);
              }}
            >
              <Pencil size={13} />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    ) : null;

  if (event.kind === 'thought') {
    return (
      <ActivityFrame
        className={`group px-2 py-1.5 ${visual.row}`}
        left={leftGutterIcon}
        contentClassName="min-w-0"
      >
        <ThoughtMessage renderedText={renderedText} isStreaming={!!event.streaming} />
      </ActivityFrame>
    );
  }

  if (parallelToolPayload) {
    return (
      <ActivityFrame
        className={`group px-2 py-1.5 ${visual.row}`}
        left={leftGutterIcon}
        contentClassName="min-w-0"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-2 text-[12px] font-medium text-loop-500">
            Executing {parallelToolPayload.results.length} tool{parallelToolPayload.results.length === 1 ? '' : 's'}
          </div>
          <div className="relative flex flex-col gap-1.5 before:absolute before:inset-y-2 before:left-2 before:w-px before:bg-loop-800/80">
            {parallelToolPayload.results.map((result, idx) => {
              const nestedEvent = buildParallelNestedEvent(event, idx, result);
              const nestedRequestInputPayload = parseRequestUserInputPayload(nestedEvent);
              const nestedUpdatePlanPayload = parseUpdatePlanPayload(nestedEvent);
              const nestedCommandToolPayload = parseCommandToolPayload(nestedEvent);
              const nestedFileToolPayload = parseFileToolPayload(nestedEvent);
              const nestedIsPatchToolEvent =
                nestedEvent.tool?.name === 'apply_patch' || nestedEvent.tool?.name?.endsWith(':apply_patch');
              const nestedFallbackText = textTargetForEvent(nestedEvent);

              return (
                <div key={nestedEvent.id} className="py-1 pl-6">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-loop-500">
                    <span>{nestedEvent.tool?.name || 'tool'}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${nestedEvent.tool?.success === false
                        ? 'bg-red-500/10 text-red-300'
                        : 'bg-blue-500/10 text-blue-300'
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
                  ) : nestedFileToolPayload ? (
                    <FileToolCard payload={nestedFileToolPayload} />
                  ) : nestedIsPatchToolEvent && (nestedEvent.tool?.command || nestedEvent.body) ? (
                    <div className="space-y-2">
                      {nestedEvent.body &&
                        (nestedEvent.tool?.phase === 'result' || nestedEvent.tool?.error) &&
                        nestedEvent.body !== nestedEvent.tool?.command ? (
                          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-loop-900/35 px-3 py-2 text-xs leading-relaxed text-loop-300 scrollbar-thin">
                            {nestedEvent.body}
                          </pre>
                        ) : null}
                      <PatchViewer patchText={nestedEvent.tool?.command || nestedEvent.body || ''} />
                    </div>
                  ) : nestedFallbackText ? (
                    <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-loop-900/35 px-3 py-2 text-xs leading-relaxed text-loop-300 scrollbar-thin">
                      {nestedFallbackText}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </ActivityFrame>
    );
  }

  return (
    <>
    {isUser ? (
      <ActivityFrame
        className="px-2 py-3"
        right={userMessageActions}
        contentClassName="min-w-0"
        onMouseEnter={() => setIsUserHovered(true)}
        onMouseLeave={() => setIsUserHovered(false)}
      >
        <div className="ml-auto flex max-w-[85%] flex-col rounded-2xl rounded-tr-sm bg-loop-800/80 px-5 pt-2.5 pb-3 shadow-sm">
          {event.images && event.images.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {event.images.map((img, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="h-16 w-16 cursor-pointer overflow-hidden rounded-md border border-loop-700 bg-loop-900 transition-opacity hover:opacity-80"
                  onClick={() => setSelectedImage(img.dataUrl)}
                >
                  <img src={img.dataUrl} alt="attached" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
          <div className="text-loop-200">
            <MarkdownBlock text={renderedText} dense />
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            {(userModel || userThinkingLevel) ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                {userModel ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-loop-700/80 px-2 py-0.5 text-loop-300"
                    title={`Model: ${userModel}`}
                    aria-label={`Model ${userModel}`}
                  >
                    <Cog size={11} />
                    <span className="max-w-[180px] truncate text-[10px] font-medium text-loop-300">
                      {userModel}
                    </span>
                  </span>
                ) : null}
                {userThinkingLevel ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-loop-700/80 px-2 py-0.5"
                    title={`Thinking level: ${userThinkingLevel}`}
                    aria-label={`Thinking level ${userThinkingLevel}`}
                  >
                    <Brain size={11} className={thinkingToneClass} />
                    <span className={`text-[10px] font-medium ${thinkingToneClass}`}>
                      {userThinkingLevel}
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}
            <time className="text-[10px] font-medium text-loop-500">
              {new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </time>
          </div>
        </div>
      </ActivityFrame>
    ) : (
      <ActivityFrame
        className={`group px-2 py-2 ${visual.row}`}
        left={leftGutterIcon}
        right={null}
        contentClassName="min-w-0"
      >
        <div className="flex min-w-0 w-full flex-col gap-0.5">
          {isSystemEvent ? (
            <div className="mb-0.5 flex items-baseline justify-between gap-3">
              <p className={`m-0 min-w-0 text-[15px] leading-relaxed ${visual.copy}`}>
                {renderedText}
              </p>
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-loop-500">
                <time className="font-medium text-loop-500">
                  {new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </time>
                <span>{labelFor(event.kind)}</span>
                {event.tool?.callId ? (
                  <span className="font-mono text-[10px] text-loop-500">
                    {shortID(event.tool.callId)}
                  </span>
                ) : null}
                {event.tool ? (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${event.tool.success === false
                        ? 'bg-red-500/10 text-red-300'
                        : 'bg-blue-500/10 text-blue-300'
                      }`}
                  >
                    {toolPhase}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-loop-200">
                Gemini
              </span>
              <time className="text-[11px] font-medium text-loop-500">
                {new Date(event.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </time>
            </div>
          )}

          <div className={`text-[15px] leading-relaxed ${visual.copy}`}>
            {event.images && event.images.length > 0 ? (
              <div className="flex flex-wrap gap-2 mb-2">
                {event.images.map((img, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="rounded-md border border-loop-700 overflow-hidden w-16 h-16 bg-loop-900 cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setSelectedImage(img.dataUrl)}
                  >
                    <img src={img.dataUrl} alt="attached" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            ) : null}

            {!isSystemEvent ? <MarkdownBlock text={renderedText} /> : null}

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
            ) : fileToolPayload ? (
              <FileToolCard payload={fileToolPayload} />
            ) : isPatchToolEvent && (event.tool?.command || event.body) ? (
              <div className="space-y-2">
                {event.body && (event.tool?.phase === 'result' || event.tool?.error) && event.body !== event.tool?.command ? (
                  <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-loop-800/90 bg-loop-900/35 px-3 py-2 text-xs leading-relaxed text-loop-300 scrollbar-thin">
                    {event.body}
                  </pre>
                ) : null}
                <PatchViewer patchText={event.tool?.command || event.body || ''} />
              </div>
            ) : systemErrorDetails ? (
              systemErrorDetails.mode === 'card' ? (
                <div className="mt-2 rounded-lg border border-loop-700/90 bg-loop-800/70 px-3.5 py-3">
                  <p className="m-0 text-[13px] leading-relaxed text-loop-200">
                    {systemErrorDetails.summary}
                  </p>
                  {systemErrorDetails.rows.length > 0 ? (
                    <div className="mt-3 overflow-hidden rounded-md border border-loop-700/80 bg-loop-800/60">
                      <dl className="grid text-[11px]">
                        {systemErrorDetails.rows.map((row) => (
                          <div
                            key={`${row.label}:${row.value}`}
                            className="flex items-baseline justify-between gap-3 border-t border-loop-700/80 px-3 py-2 first:border-t-0"
                          >
                            <dt className="text-loop-400">{row.label}</dt>
                            <dd className="font-medium text-loop-200">{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-loop-300">
                  {systemErrorDetails.text}
                </p>
              )
            ) : isSystemEvent && event.body ? (
              <pre className={`mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-loop-800/90 px-3 py-2 text-xs leading-relaxed scrollbar-thin ${visual.detail}`}>
                {event.body}
              </pre>
            ) : null}
            {event.streaming ? <span className="animate-pulse text-loop-500">▍</span> : null}
          </div>
        </div>
      </ActivityFrame>
    )}

    {selectedImage && (
      <div 
        className="fixed inset-0 z-50 flex items-center justify-center bg-loop-950/80 p-4 backdrop-blur-sm"
        onClick={() => setSelectedImage(null)}
      >
        <button 
          className="absolute top-6 right-6 text-white bg-loop-800 rounded-full p-2 hover:bg-loop-700 border border-loop-600 shadow-lg z-50 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedImage(null);
          }}
        >
          <X size={20} />
        </button>
        <div className="relative flex max-w-[50vw] max-h-[50vh] items-center justify-center">
          <img src={selectedImage} alt="full size" className="max-w-full max-h-full object-contain rounded-md shadow-2xl" />
        </div>
      </div>
    )}
    </>
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

const ThoughtMessage = memo(function ThoughtMessage({
  renderedText,
  isStreaming,
}: {
  renderedText: string;
  isStreaming: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(isStreaming);
  const [isOverflowing, setIsOverflowing] = useState(renderedText.length > 150);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > 64);
    }
  }, [renderedText]);

  useEffect(() => {
    if (isStreaming) {
      setIsExpanded(true);
    }
  }, [isStreaming]);

  return (
    <div className="max-w-[620px] text-loop-300">
      <motion.div
        initial={false}
        animate={{ height: isExpanded ? 'auto' : (isOverflowing ? 64 : 'auto') }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        className="relative overflow-hidden"
      >
        <div ref={contentRef}>
          <MarkdownBlock text={renderedText} compact />
          {isStreaming ? <span className="animate-pulse text-loop-500">▍</span> : null}
        </div>
        {!isExpanded && isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-loop-900 to-transparent pointer-events-none" />
        )}
      </motion.div>
      {isOverflowing && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-[11px] font-medium text-loop-500 transition-colors hover:text-loop-300"
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
});

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
      row: '',
      icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-loop-800/90 text-red-300',
      copy: 'text-loop-100',
      detail: 'bg-loop-900/65 text-loop-200',
    };
  }

  if (event.kind === 'tool') {
    return {
      row: '',
      icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-900/25 text-blue-200',
      copy: 'text-loop-200',
      detail: 'bg-loop-900/40 text-blue-100',
    };
  }

  if (event.kind === 'thought') {
    return {
      row: '',
      icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-loop-700/70 text-loop-200',
      copy: 'text-loop-200',
      detail: 'bg-loop-900/50 text-loop-300',
    };
  }

  if (event.kind === 'assistant') {
    return {
      row: '',
      icon: 'flex h-8 w-8 shrink-0 items-center justify-center',
      copy: 'text-loop-200',
      detail: 'bg-loop-900/50 text-loop-300',
    };
  }

  return {
    row: '',
    icon: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-loop-800/80 text-loop-400',
    copy: 'text-loop-300',
    detail: 'bg-loop-900/50 text-loop-400',
  };
}

interface SystemErrorDetailRow {
  label: string;
  value: string;
}

type SystemErrorDetails =
  | {
      mode: 'text';
      text: string;
    }
  | {
      mode: 'card';
      summary: string;
      rows: SystemErrorDetailRow[];
    };

function parseSystemErrorDetails(event: ActivityEvent): SystemErrorDetails | null {
  const isErrorLike =
    event.kind === 'error' || event.tool?.success === false || /error|failed/i.test(event.title);
  const body = event.body?.trim();
  if (!isErrorLike || !body) {
    return null;
  }

  const normalized = body.replace(/\r\n/g, '\n');
  const rows: SystemErrorDetailRow[] = [];
  const seenRows = new Set<string>();
  const pushRow = (label: string, value: string): void => {
    const cleaned = value.trim();
    if (!cleaned) {
      return;
    }
    const key = `${label}:${cleaned.toLowerCase()}`;
    if (seenRows.has(key)) {
      return;
    }
    seenRows.add(key);
    rows.push({ label, value: cleaned });
  };

  const codeMatch = normalized.match(/\bError\s+(\d{3})\b/i);
  if (codeMatch) {
    pushRow('Code', codeMatch[1]);
  }

  const statusMatch = normalized.match(/\bStatus:\s*([A-Z_]+)/i);
  if (statusMatch) {
    pushRow('Status', humanizeStatus(statusMatch[1]));
  }

  const phaseMatch = normalized.match(/\bPhase:\s*([A-Za-z0-9_-]+)/i);
  if (phaseMatch) {
    pushRow('Phase', phaseMatch[1]);
  }

  const detailMatch = normalized.match(/\bDetails:\s*([^\n]+)/i);
  if (detailMatch && detailMatch[1].trim() !== '[]') {
    pushRow('Details', detailMatch[1]);
  }

  for (const metricMatch of normalized.matchAll(/\b(TTFT|Stream|Total)\s+(\d+)ms\b/gi)) {
    const rawLabel = metricMatch[1];
    const label =
      rawLabel.toUpperCase() === 'TTFT'
        ? 'First token'
        : `${rawLabel.charAt(0).toUpperCase()}${rawLabel.slice(1).toLowerCase()}`;
    pushRow(label, `${metricMatch[2]}ms`);
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const messageMatch = normalized.match(/\bMessage:\s*(.+?)(?=,\s*(Status:|Details:|$)|$)/i);
  const fallbackLine = lines.find(
    (line) =>
      !/^(TTFT|Stream|Total)\s+\d+ms/i.test(line) &&
      !/^[A-Za-z ]+:\s*/.test(line) &&
      !/^Error\s+\d{3}\b/i.test(line),
  );
  const rawSummary = messageMatch?.[1] || fallbackLine || lines[0] || '';
  const summary = cleanErrorSummary(rawSummary);
  if (!summary) {
    return null;
  }

  if (rows.length === 0) {
    return { mode: 'text', text: summary };
  }

  return {
    mode: 'card',
    summary,
    rows,
  };
}

function cleanErrorSummary(rawSummary: string): string {
  return rawSummary
    .replace(/^rpc error:\s*code\s*=\s*[a-z_]+\s*desc\s*=\s*/i, '')
    .replace(/^Error\s+\d+\s*,?\s*Message:\s*/i, '')
    .replace(/^Message:\s*/i, '')
    .replace(/,\s*Status:\s*[A-Z_]+.*$/i, '')
    .replace(/,\s*Details:\s*\[[^\]]*\].*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\.,/g, '.')
    .replace(/,\s*$/, '')
    .trim();
}

function humanizeStatus(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

const MarkdownBlock = memo(function MarkdownBlock({
  text,
  compact = false,
  dense = false,
}: {
  text: string;
  compact?: boolean;
  dense?: boolean;
}) {
  const rootTextClass = dense
    ? 'm-0 break-words text-[14px] font-normal leading-user-message text-loop-200'
    : compact
      ? 'm-0 break-words text-[13px] font-normal leading-relaxed text-loop-300'
      : 'm-0 break-words text-[15px] leading-relaxed';
  const paragraphClass = dense
    ? 'm-0 mb-1.5 leading-user-message last:mb-0'
    : compact
      ? 'm-0 mb-2 leading-6 last:mb-0'
      : 'm-0 mb-3 leading-7 last:mb-0';
  const listClass = compact
    ? 'm-0 mb-2 list-disc space-y-1 pl-6 marker:text-loop-500'
    : 'm-0 mb-3 list-disc space-y-1 pl-6 marker:text-loop-500';
  const orderedListClass = compact
    ? 'm-0 mb-2 list-decimal space-y-1 pl-6 marker:text-loop-500'
    : 'm-0 mb-3 list-decimal space-y-1 pl-6 marker:text-loop-500';
  const inlineCodeClass = compact
    ? 'rounded bg-loop-800/95 px-1.5 py-0.5 font-mono text-[11px] text-loop-200'
    : 'rounded bg-loop-800/95 px-1.5 py-0.5 font-mono text-[12px] text-loop-100';
  const preClass = compact
    ? 'mb-2 mt-2 overflow-x-auto rounded-lg border border-loop-800 bg-loop-950/85 p-3 text-[11px] leading-relaxed text-loop-300'
    : 'mb-3 mt-2 overflow-x-auto rounded-lg border border-loop-800 bg-loop-950/85 p-3 text-[12px] leading-relaxed text-loop-200';

  return (
    <div className={rootTextClass}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-0 text-2xl font-bold tracking-tight text-loop-100">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-4 text-xl font-semibold tracking-tight text-loop-100">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-lg font-semibold text-loop-100">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-2 mt-3 text-base font-semibold text-loop-200">{children}</h4>
          ),
          p: ({ children }) => <p className={paragraphClass}>{children}</p>,
          ul: ({ children }) => <ul className={listClass}>{children}</ul>,
          ol: ({ children }) => <ol className={orderedListClass}>{children}</ol>,
          li: ({ children }) => <li className="[&>p]:mb-0">{children}</li>,
          a: ({ children, href }) => (
            <a
              className="font-medium text-loop-200 underline decoration-loop-400/60 underline-offset-2 transition-colors hover:text-loop-100"
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-loop-600/80 pl-4 italic text-loop-300">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-0 border-t border-loop-700/80" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto rounded-lg border border-loop-800">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-loop-800/70 text-loop-200">{children}</thead>,
          tbody: ({ children }) => <tbody className="bg-loop-900/35">{children}</tbody>,
          tr: ({ children }) => <tr className="border-t border-loop-800 first:border-t-0">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top text-loop-300">{children}</td>,
          code: ({ children, className }) => {
            const isCodeBlock = Boolean(className && className.startsWith('language-'));
            if (isCodeBlock) {
              return (
                <code className={compact ? 'font-mono text-[11px] text-loop-200' : 'font-mono text-[12px] text-loop-100'}>
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
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'thought':
      return 'Thought';
    case 'status':
      return 'Status';
    case 'tool':
      return 'Tool';
    case 'thread':
      return 'Thread';
    case 'error':
      return 'Error';
    default:
      return 'Lifecycle';
  }
}

function iconFor(kind: ActivityKind) {
  switch (kind) {
    case 'user':
      return <UserRound size={18} />;
    case 'assistant':
      return <img src="/gemini-color.svg" width={22} height={22} alt="Gemini" />;
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

function userThinkingToneClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'minimal':
      return 'text-loop-400';
    case 'low':
      return 'text-sky-300';
    case 'medium':
      return 'text-blue-300';
    case 'high':
      return 'text-violet-300';
    default:
      return 'text-loop-300';
  }
}
