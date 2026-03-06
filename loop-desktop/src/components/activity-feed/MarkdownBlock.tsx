import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownBlockProps {
  text: string;
  compact?: boolean;
  dense?: boolean;
}

export default memo(function MarkdownBlock({
  text,
  compact = false,
  dense = false,
}: MarkdownBlockProps) {
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
            return <code className={inlineCodeClass}>{children}</code>;
          },
          pre: ({ children }) => <pre className={preClass}>{children}</pre>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
