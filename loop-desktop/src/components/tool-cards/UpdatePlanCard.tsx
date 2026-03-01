import { memo } from 'react';
import type { UpdatePlanPayload } from './types';
import { statusGlyph, statusTone } from './toolPayloadParsers';

export const UpdatePlanCard = memo(function UpdatePlanCard({ payload }: { payload: UpdatePlanPayload }) {
  if (payload.plan.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs">
      <p className="mb-2 text-xs font-semibold text-emerald-300">Plan update</p>
      <div className="space-y-1.5">
        {payload.plan.map((item, index) => (
          <div key={`${item.step}:${index}`} className="flex items-start gap-2">
            <span className={`mt-0.5 font-mono text-[10px] ${statusTone(item.status)}`}>
              {statusGlyph(item.status)}
            </span>
            <span className="text-loop-200">{item.step}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
