import { useEffect, useState } from 'react';
import { requestJson } from '../lib/loopClient';

interface Stats {
  lines_added: number;
  lines_deleted: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cached: number;
  latest_prompt_tokens: number;
  tokens_total: number;
  context_limit: number;
  context_percent: number;
  model: string;
  cost: number;
}

export function Powerline({ backendUrl, workspaceId, conversationId }: { backendUrl: string; workspaceId: string; conversationId: string }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setStats(null);
      return;
    }

    // Clear stats immediately when conversation changes to prevent flashing old stats
    // or if transitioning to a new thread.
    setStats(null);

    let active = true;
    const fetchStats = async () => {
      try {
        const qs = conversationId ? `conversation_id=${encodeURIComponent(conversationId)}` : '';
        const res = await requestJson<Stats>({
          baseUrl: backendUrl,
          endpointPath: `/workspaces/${workspaceId}/stats${qs ? '?' + qs : ''}`,
          method: 'GET',
        });
        
        if (res.ok && active) {
          setStats(res.data);
        } else if (active) {
          // If it fails (e.g., backend not updated yet), provide empty fallback
          setStats(prev => prev || { lines_added: 0, lines_deleted: 0, tokens_input: 0, tokens_output: 0, tokens_cached: 0, latest_prompt_tokens: 0, tokens_total: 0, context_limit: 1048576, context_percent: 0, model: '', cost: 0 });
        }
      } catch (err) {
        console.error("Failed to fetch powerline stats", err);
        if (active) {
          setStats(prev => prev || { lines_added: 0, lines_deleted: 0, tokens_input: 0, tokens_output: 0, tokens_cached: 0, latest_prompt_tokens: 0, tokens_total: 0, context_limit: 1048576, context_percent: 0, model: '', cost: 0 });
        }
      }
    };

    void fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [backendUrl, workspaceId, conversationId]);

  const displayStats = stats || { lines_added: 0, lines_deleted: 0, tokens_input: 0, tokens_output: 0, tokens_cached: 0, latest_prompt_tokens: 0, tokens_total: 0, context_limit: 1048576, context_percent: 0, model: '', cost: 0 };

  const costStr = displayStats.cost > 0 ? `$${displayStats.cost.toFixed(4)}` : '$0.0000';
  const contextPercent = displayStats.context_percent.toFixed(1);
  const contextLimitLabel = displayStats.context_limit > 0 ? displayStats.context_limit.toLocaleString() : 'unknown';

  return (
    <div className="flex h-6 w-full items-center justify-between border-t border-loop-700 bg-loop-800 px-3 text-[11px] text-loop-400 font-mono shrink-0">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2" title="Git changes by conversation">
          <span className="text-green-500">+{displayStats.lines_added}</span>
          <span className="text-red-500">-{displayStats.lines_deleted}</span>
        </div>
        <div className="text-loop-500">|</div>
        <div className="flex items-center gap-2" title="Total Tokens in Conversation">
          <span>∑ {displayStats.tokens_total.toLocaleString()}</span>
        </div>
        <div className="text-loop-500">|</div>
        <div className="flex items-center gap-2" title={`Context Window Usage (${contextPercent}%)`}>
          <span className="opacity-80">CTX:</span> <span>{displayStats.latest_prompt_tokens.toLocaleString()} / {contextLimitLabel}</span>
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2" title="Model Token Usage">
          <span className="opacity-80">IN:</span> <span>{displayStats.tokens_input.toLocaleString()}</span>
          {displayStats.tokens_cached > 0 && (
            <><span className="opacity-80 ml-1 text-blue-400">(CACHE:</span> <span className="text-blue-400">{displayStats.tokens_cached.toLocaleString()})</span></>
          )}
          <span className="opacity-80 ml-2">OUT:</span> <span>{displayStats.tokens_output.toLocaleString()}</span>
        </div>
        <div className="text-loop-500">|</div>
        <div className="flex items-center gap-1 text-yellow-500/80" title="Estimated Cost (Gemini 1.5 Pro)">
          <span>{costStr}</span>
        </div>
      </div>
    </div>
  );
}
