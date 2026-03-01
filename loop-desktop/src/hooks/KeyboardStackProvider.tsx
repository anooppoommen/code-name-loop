import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { KeyboardStackContext, resolveShortcutHandler } from './keyboardStackCore';
import type { KeyboardLayerRecord, KeyboardStackContextValue, RegisterKeyboardLayerOptions } from './keyboardStackCore';

export function KeyboardStackProvider({ children }: { children: ReactNode }) {
  const layersRef = useRef<KeyboardLayerRecord[]>([]);
  const nextIDRef = useRef(1);
  const nextOrderRef = useRef(1);

  const registerLayer = useCallback((options: RegisterKeyboardLayerOptions): (() => void) => {
    const layer: KeyboardLayerRecord = {
      id: nextIDRef.current,
      order: nextOrderRef.current,
      priority: options.priority ?? 0,
      enabledRef: options.enabledRef,
      handlersRef: options.handlersRef,
    };
    nextIDRef.current += 1;
    nextOrderRef.current += 1;

    layersRef.current = [...layersRef.current, layer];

    return () => {
      layersRef.current = layersRef.current.filter((item) => item.id !== layer.id);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const stack = [...layersRef.current].sort((a, b) => {
        if (a.priority === b.priority) {
          return b.order - a.order;
        }
        return b.priority - a.priority;
      });

      for (const layer of stack) {
        if (!layer.enabledRef.current) {
          continue;
        }
        const handlers = layer.handlersRef.current;
        const handler = resolveShortcutHandler(event, handlers);
        if (!handler) {
          continue;
        }
        const handled = handler(event);
        if (handled === false) {
          continue;
        }
        if (!event.defaultPrevented) {
          event.preventDefault();
        }
        event.stopPropagation();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const value = useMemo<KeyboardStackContextValue>(
    () => ({
      registerLayer,
    }),
    [registerLayer],
  );

  return <KeyboardStackContext.Provider value={value}>{children}</KeyboardStackContext.Provider>;
}
