import { memo } from 'react';
import type { ParallelToolPayload } from './types';

export const ParallelToolCard = memo(function ParallelToolCard({ payload }: { payload: ParallelToolPayload }) {
  if (payload.results.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-xs">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-300">
        Parallel Tool Run
      </p>
      <p className="mb-2 text-[11px] text-loop-300">
        Success {payload.successCount} · Failed {payload.failureCount}
      </p>
      <div className="space-y-1.5">
        {payload.results.slice(0, 8).map((item, index) => (
          <div key={`${item.name}:${index}`} className="rounded border border-loop-700 bg-loop-900/50 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-loop-100">{item.name}</span>
              <span className={`text-[10px] font-semibold uppercase ${item.success ? 'text-emerald-300' : 'text-red-300'}`}>
                {item.success ? 'ok' : 'error'}
              </span>
            </div>
            {!item.success && item.error ? (
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-red-200/90">{item.error}</p>
            ) : null}
          </div>
        ))}
      </div>
      {payload.results.length > 8 ? (
        <p className="mt-2 text-[11px] text-loop-400">...and {payload.results.length - 8} more</p>
      ) : null}
    </div>
  );
});
