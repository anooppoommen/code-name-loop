import { useEffect } from 'react';

let reactScanModulePromise: Promise<typeof import('react-scan')> | null = null;
let reactScanStarted = false;
const REACT_SCAN_STORAGE_KEY = 'react-scan-options';

function loadReactScan() {
  if (!reactScanModulePromise) {
    reactScanModulePromise = import('react-scan');
  }
  return reactScanModulePromise;
}

function syncReactScanStorage(enabled: boolean): void {
  try {
    const raw = window.localStorage.getItem(REACT_SCAN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};

    window.localStorage.setItem(
      REACT_SCAN_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        enabled,
        showToolbar: enabled,
        animationSpeed: 'fast',
      }),
    );
  } catch {
    // Ignore localStorage sync failures and fall back to runtime options.
  }
}

export function useReactScan(enabled: boolean): void {
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') {
      return;
    }

    let disposed = false;

    void loadReactScan()
      .then(({ scan, setOptions }) => {
        if (disposed) {
          return;
        }

        syncReactScanStorage(enabled);

        const options = {
          enabled,
          showToolbar: enabled,
          animationSpeed: 'fast' as const,
        };

        if (!reactScanStarted) {
          scan(options);
          reactScanStarted = true;
          return;
        }

        setOptions(options);
      })
      .catch((error: unknown) => {
        console.error('Failed to initialize react-scan', error);
      });

    return () => {
      disposed = true;
    };
  }, [enabled]);
}
