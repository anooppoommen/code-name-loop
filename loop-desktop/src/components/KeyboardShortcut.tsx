import { useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { KeyboardStackContext } from '../hooks/keyboardStackCore';
import type { KeyboardShortcutHandlers } from '../hooks/keyboardStackCore';

interface KeyboardShortcutProps extends KeyboardShortcutHandlers {
  children: ReactNode;
  enabled?: boolean;
  priority?: number;
}

export function KeyboardShortcut({
  children,
  enabled = true,
  priority = 0,
  onEnter,
  onEscape,
  onArrowDown,
  onArrowUp,
  onArrowLeft,
  onArrowRight,
  onDigit1,
  onDigit2,
  onDigit3,
  onKeyDown,
}: KeyboardShortcutProps) {
  const context = useContext(KeyboardStackContext);
  if (!context) {
    throw new Error('KeyboardShortcut must be used inside KeyboardStackProvider');
  }

  const enabledRef = useRef(enabled);
  const handlersRef = useRef<KeyboardShortcutHandlers>({});

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    handlersRef.current = {
      onEnter,
      onEscape,
      onArrowDown,
      onArrowUp,
      onArrowLeft,
      onArrowRight,
      onDigit1,
      onDigit2,
      onDigit3,
      onKeyDown,
    };
  }, [onArrowDown, onArrowLeft, onArrowRight, onArrowUp, onDigit1, onDigit2, onDigit3, onEnter, onEscape, onKeyDown]);

  useEffect(() => {
    return context.registerLayer({
      priority,
      enabledRef,
      handlersRef,
    });
  }, [context, priority]);

  return <>{children}</>;
}

