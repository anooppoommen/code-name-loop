import { ArrowDown, ArrowUp, Send, Trash2 } from 'lucide-react';
import type { ComposerImage } from '../hooks/useLoopDesktop';

export interface QueuedMessage {
  id: string;
  text: string;
  images: ComposerImage[];
}

interface QueuedMessagesProps {
  messages: QueuedMessage[];
  onReorder: (id: string, direction: 'up' | 'down') => void;
  onRemove: (id: string) => void;
  onSteer: (id: string) => Promise<void>;
}

export function QueuedMessages({ messages, onReorder, onRemove, onSteer }: QueuedMessagesProps) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-2 w-full">
      {messages.map((msg, index) => (
        <div
          key={msg.id}
          className="flex flex-col gap-2 rounded-xl border border-loop-700/50 bg-loop-800 p-2 shadow-sm relative group"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-[13px] leading-relaxed text-loop-200 whitespace-pre-wrap break-words min-w-0 flex-1">
              {msg.text || '(Images attached)'}
            </div>
            <div className="flex items-center gap-1 opacity-100 group-hover:opacity-100 transition-opacity shrink-0">
              <button
                type="button"
                onClick={() => onReorder(msg.id, 'up')}
                disabled={index === 0}
                className="p-1 rounded text-loop-400 hover:text-loop-200 hover:bg-loop-700 disabled:opacity-30 disabled:hover:bg-transparent"
                title="Move Up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                onClick={() => onReorder(msg.id, 'down')}
                disabled={index === messages.length - 1}
                className="p-1 rounded text-loop-400 hover:text-loop-200 hover:bg-loop-700 disabled:opacity-30 disabled:hover:bg-transparent"
                title="Move Down"
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                onClick={() => onRemove(msg.id)}
                className="p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-400/10 ml-1"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                onClick={() => void onSteer(msg.id)}
                className="flex items-center gap-1.5 p-1 px-2.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 hover:text-blue-300 text-[11px] font-medium ml-1 transition-colors"
                title="Interrupt and send this message"
              >
                <Send size={12} />
                Steer
              </button>
            </div>
          </div>
          
          {msg.images && msg.images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {msg.images.map((img: ComposerImage) => (
                <div key={img.id} className="rounded-md border border-loop-700 overflow-hidden w-12 h-12 bg-loop-900">
                  <img src={img.dataUrl} alt="attachment" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
