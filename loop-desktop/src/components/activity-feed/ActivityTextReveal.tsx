import { useReducedMotion } from 'framer-motion';
import { memo, useEffect, useRef, useState } from 'react';
import { ACTIVITY_EASE_CSS } from './ActivityMotion';
import './ActivityTextReveal.css';

interface ActivityTextRevealProps {
  text?: string;
  className?: string;
  durationMs?: number;
  travel?: number;
  truncate?: boolean;
}

export const ActivityTextReveal = memo(function ActivityTextReveal({
  text = '',
  className,
  durationMs = 240,
  travel = 10,
  truncate = false,
}: ActivityTextRevealProps) {
  const reduced = Boolean(useReducedMotion());
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState('');
  const [ready, setReady] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [width, setWidth] = useState('auto');

  const currentValueRef = useRef(text);
  const enteringRef = useRef<HTMLSpanElement>(null);
  const leavingRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<number | null>(null);
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const widen = () => {
    if (truncate) {
      return;
    }

    const next = Math.max(
      enteringRef.current?.scrollWidth ?? 0,
      leavingRef.current?.scrollWidth ?? 0,
    );
    if (next <= 0) {
      return;
    }

    setWidth((prev) => {
      const previousWidth = Number.parseFloat(prev);
      if (Number.isFinite(previousWidth) && next <= previousWidth) {
        return prev;
      }
      return `${next}px`;
    });
  };

  useEffect(() => {
    widen();

    if (typeof requestAnimationFrame !== 'function') {
      setReady(true);
      return;
    }

    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) {
      const frameId = window.requestAnimationFrame(() => setReady(true));
      return () => window.cancelAnimationFrame(frameId);
    }

    let cancelled = false;
    void fonts.ready.finally(() => {
      if (cancelled) {
        return;
      }
      widen();
      window.requestAnimationFrame(() => {
        if (!cancelled) {
          setReady(true);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [truncate]);

  useEffect(() => {
    if (reduced) {
      currentValueRef.current = text;
      setCurrent(text);
      setPrevious('');
      setSwapping(false);
      return;
    }

    if (text === currentValueRef.current) {
      widen();
      return;
    }

    currentValueRef.current = text;
    setPrevious(current);
    setCurrent(text);
    setSwapping(true);

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    if (clearRef.current) {
      clearTimeout(clearRef.current);
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      widen();
      rootRef.current?.offsetHeight;
      setSwapping(false);
      clearRef.current = setTimeout(() => {
        clearRef.current = null;
        setPrevious('');
      }, durationMs + 32);
    });
  }, [current, durationMs, reduced, text]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    if (clearRef.current) {
      clearTimeout(clearRef.current);
    }
  }, []);

  return (
    <span
      ref={rootRef}
      data-component="activity-text-reveal"
      data-ready={ready ? 'true' : 'false'}
      data-swapping={swapping ? 'true' : 'false'}
      data-truncate={truncate ? 'true' : 'false'}
      className={className}
      aria-label={text}
      style={{
        ['--activity-text-reveal-duration' as string]: `${durationMs}ms`,
        ['--activity-text-reveal-travel' as string]: `${travel}px`,
        ['--activity-text-reveal-ease' as string]: ACTIVITY_EASE_CSS,
      }}
    >
      <span
        data-slot="activity-text-reveal-track"
        style={{ width: truncate ? '100%' : width }}
      >
        <span data-slot="activity-text-reveal-entering" ref={enteringRef}>
          {current || '\u00A0'}
        </span>
        <span data-slot="activity-text-reveal-leaving" ref={leavingRef}>
          {previous || '\u00A0'}
        </span>
      </span>
    </span>
  );
});
