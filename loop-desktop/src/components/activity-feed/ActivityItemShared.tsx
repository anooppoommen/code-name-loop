import { Check, Copy, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActivityEvent } from '../../types/ui';
import type { MarkdownBlockProps } from './MarkdownBlock';

const LazyMarkdownBlock = lazy(() => import('./MarkdownBlock'));

export interface ActivityFrameProps {
  children: ReactNode;
  className?: string;
  left?: ReactNode;
  right?: ReactNode;
  contentClassName?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function ActivityFrame({
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

export function CopyDropdown({
  getMarkdown,
  getText,
}: {
  getMarkdown: () => string;
  getText: () => string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedMode, setCopiedMode] = useState<'text' | 'markdown' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopy = async (mode: 'text' | 'markdown') => {
    const text = mode === 'text' ? getText() : getMarkdown();
    await navigator.clipboard.writeText(text);
    setCopiedMode(mode);
    window.setTimeout(() => {
      setCopiedMode(null);
      setIsOpen(false);
    }, 2000);
  };

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      <button
        type="button"
        aria-label="Copy options"
        title="Copy options"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-loop-800/70 text-loop-300 transition hover:bg-loop-700 hover:text-loop-100 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => setIsOpen(!isOpen)}
      >
        {copiedMode ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.16 }}
            className="absolute right-0 top-full z-50 mt-1 flex w-40 flex-col rounded-md border border-loop-700 bg-loop-800 p-1 shadow-lg"
          >
            <button
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-loop-200 hover:bg-loop-700 hover:text-loop-100"
              onClick={() => handleCopy('text')}
            >
              {copiedMode === 'text' ? <Check size={12} /> : <Copy size={12} />}
              Copy as text
            </button>
            <button
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-loop-200 hover:bg-loop-700 hover:text-loop-100"
              onClick={() => handleCopy('markdown')}
            >
              {copiedMode === 'markdown' ? <Check size={12} /> : <Copy size={12} />}
              Copy as markdown
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type ActivityImage = NonNullable<ActivityEvent['images']>[number];

export function ActivityImageStrip({
  images,
  onSelect,
  className = 'mb-2 flex flex-wrap gap-2',
  buttonClassName = 'h-16 w-16 cursor-pointer overflow-hidden rounded-md border border-loop-700 bg-loop-900 transition-opacity hover:opacity-80',
  imageClassName = 'h-full w-full object-cover',
}: {
  images: ActivityImage[];
  onSelect: (imageUrl: string) => void;
  className?: string;
  buttonClassName?: string;
  imageClassName?: string;
}) {
  if (images.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      {images.map((img, idx) => (
        <button
          key={idx}
          type="button"
          className={buttonClassName}
          onClick={() => onSelect(img.dataUrl)}
        >
          <img src={img.dataUrl} alt="attached" className={imageClassName} />
        </button>
      ))}
    </div>
  );
}

export function ActivityImageLightbox({
  selectedImage,
  onClose,
}: {
  selectedImage: string | null;
  onClose: () => void;
}) {
  if (!selectedImage) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-loop-950/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        className="absolute top-6 right-6 z-50 rounded-full border border-loop-600 bg-loop-800 p-2 text-white shadow-lg transition-colors hover:bg-loop-700"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X size={20} />
      </button>
      <div className="relative flex max-h-[50vh] max-w-[50vw] items-center justify-center">
        <img
          src={selectedImage}
          alt="full size"
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
        />
      </div>
    </div>
  );
}

export const ThoughtMessage = memo(function ThoughtMessage({
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
        {!isExpanded && isOverflowing ? (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-loop-900 to-transparent" />
        ) : null}
      </motion.div>
      {isOverflowing ? (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-[11px] font-medium text-loop-500 transition-colors hover:text-loop-300"
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
});

export const MarkdownBlock = memo(function MarkdownBlock(props: MarkdownBlockProps) {
  const { text, compact = false, dense = false } = props;
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

  return (
    <Suspense
      fallback={
        <div className={rootTextClass}>
          <p className={paragraphClass}>{text}</p>
        </div>
      }
    >
      <LazyMarkdownBlock {...props} />
    </Suspense>
  );
});
