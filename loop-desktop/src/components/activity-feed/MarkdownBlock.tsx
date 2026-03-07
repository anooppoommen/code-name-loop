import DOMPurify from 'dompurify';
import { marked } from 'marked';
import morphdom from 'morphdom';
import { memo, useEffect, useMemo, useRef } from 'react';

export interface MarkdownBlockProps {
  text: string;
  compact?: boolean;
  dense?: boolean;
}

const MARKDOWN_CACHE_LIMIT = 200;
const markdownCache = new Map<string, string>();

marked.setOptions({
  gfm: true,
  breaks: false,
});

function touchCache(key: string, value: string) {
  markdownCache.delete(key);
  markdownCache.set(key, value);

  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) {
    return;
  }

  const oldest = markdownCache.keys().next().value;
  if (oldest) {
    markdownCache.delete(oldest);
  }
}

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fallback(text: string) {
  return escapeHtml(text).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}

function renderMarkdown(text: string) {
  const cached = markdownCache.get(text);
  if (cached) {
    touchCache(text, cached);
    return cached;
  }

  let parsed = '';
  try {
    parsed = marked.parse(text) as string;
  } catch {
    parsed = fallback(text);
  }

  const safe = DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ['style'],
    FORBID_CONTENTS: ['style', 'script'],
  });
  touchCache(text, safe);
  return safe;
}

function decorate(container: HTMLDivElement) {
  container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
  });
}

export default memo(function MarkdownBlock({
  text,
  compact = false,
  dense = false,
}: MarkdownBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const baseClass = dense
    ? 'text-[14px] font-normal leading-user-message text-loop-200'
    : compact
      ? 'text-[13px] font-normal leading-relaxed text-loop-300'
      : 'text-[15px] leading-relaxed';
  const paragraphClass = dense
    ? '[&_p]:m-0 [&_p:not(:last-child)]:mb-1.5 [&_p]:leading-user-message'
    : compact
      ? '[&_p]:m-0 [&_p:not(:last-child)]:mb-2 [&_p]:leading-6'
      : '[&_p]:m-0 [&_p:not(:last-child)]:mb-3 [&_p]:leading-7';
  const listClass = compact
    ? '[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6'
    : '[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6';
  const inlineCodeClass = compact
    ? '[&_code]:rounded [&_code]:bg-loop-800/95 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-loop-200'
    : '[&_code]:rounded [&_code]:bg-loop-800/95 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-loop-100';
  const preClass = compact
    ? '[&_pre]:mb-2 [&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-loop-800 [&_pre]:bg-loop-950/85 [&_pre]:p-3 [&_pre]:text-[11px] [&_pre]:leading-relaxed [&_pre]:text-loop-300 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11px] [&_pre_code]:text-loop-200'
    : '[&_pre]:mb-3 [&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-loop-800 [&_pre]:bg-loop-950/85 [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:leading-relaxed [&_pre]:text-loop-200 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px] [&_pre_code]:text-loop-100';
  const headingClass = '[&_h1]:mb-3 [&_h1]:mt-0 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:text-loop-100 [&_h2]:mb-3 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-loop-100 [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-loop-100 [&_h4]:mb-2 [&_h4]:mt-3 [&_h4]:text-base [&_h4]:font-semibold [&_h4]:text-loop-200';
  const miscClass = '[&_a]:font-medium [&_a]:text-loop-200 [&_a]:underline [&_a]:decoration-loop-400/60 [&_a]:underline-offset-2 [&_a]:transition-colors hover:[&_a]:text-loop-100 [&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-loop-600/80 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-loop-300 [&_hr]:my-4 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-loop-700/80 [&_table]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_table]:overflow-hidden [&_thead]:bg-loop-800/70 [&_thead]:text-loop-200 [&_tr]:border-t [&_tr]:border-loop-800 first:[&_tr]:border-t-0 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-loop-300';

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const next = document.createElement('div');
    next.innerHTML = html;
    decorate(next);

    morphdom(root, next, {
      childrenOnly: true,
      onBeforeElUpdated: (fromEl: Element, toEl: Element) => !fromEl.isEqualNode(toEl),
    });
  }, [html]);

  return <div ref={rootRef} className={[baseClass, 'break-words', paragraphClass, listClass, inlineCodeClass, preClass, headingClass, miscClass].join(' ')} />;
});
