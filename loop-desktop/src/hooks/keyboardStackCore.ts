import { createContext } from 'react';
import type { MutableRefObject } from 'react';

export type KeyboardShortcutHandler = (event: KeyboardEvent) => boolean | void;

export interface KeyboardShortcutHandlers {
  onEnter?: KeyboardShortcutHandler;
  onEscape?: KeyboardShortcutHandler;
  onArrowDown?: KeyboardShortcutHandler;
  onArrowUp?: KeyboardShortcutHandler;
  onArrowLeft?: KeyboardShortcutHandler;
  onArrowRight?: KeyboardShortcutHandler;
  onDigit1?: KeyboardShortcutHandler;
  onDigit2?: KeyboardShortcutHandler;
  onDigit3?: KeyboardShortcutHandler;
  onKeyDown?: KeyboardShortcutHandler;
}

export interface RegisterKeyboardLayerOptions {
  priority?: number;
  enabledRef: MutableRefObject<boolean>;
  handlersRef: MutableRefObject<KeyboardShortcutHandlers>;
}

export interface KeyboardLayerRecord {
  id: number;
  order: number;
  priority: number;
  enabledRef: MutableRefObject<boolean>;
  handlersRef: MutableRefObject<KeyboardShortcutHandlers>;
}

export interface KeyboardStackContextValue {
  registerLayer: (options: RegisterKeyboardLayerOptions) => () => void;
}

export const KeyboardStackContext = createContext<KeyboardStackContextValue | null>(null);

function hasShortcutModifiers(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

export function resolveShortcutHandler(
  event: KeyboardEvent,
  handlers: KeyboardShortcutHandlers,
): KeyboardShortcutHandler | null {
  if (hasShortcutModifiers(event)) {
    return handlers.onKeyDown ?? null;
  }

  switch (event.key) {
    case 'Enter':
      return handlers.onEnter ?? null;
    case 'Escape':
      return handlers.onEscape ?? null;
    case 'ArrowDown':
      return handlers.onArrowDown ?? null;
    case 'ArrowUp':
      return handlers.onArrowUp ?? null;
    case 'ArrowLeft':
      return handlers.onArrowLeft ?? null;
    case 'ArrowRight':
      return handlers.onArrowRight ?? null;
    case '1':
      return handlers.onDigit1 ?? null;
    case '2':
      return handlers.onDigit2 ?? null;
    case '3':
      return handlers.onDigit3 ?? null;
    default:
      return handlers.onKeyDown ?? null;
  }
}
