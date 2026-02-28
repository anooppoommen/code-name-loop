import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { NoticeToast } from '../hooks/useLoopDesktop';

interface ToastStackProps {
  toasts: NoticeToast[];
  onDismiss: (id: string) => void;
}

interface ToneMeta {
  title: string;
  cardClassName: string;
  iconClassName: string;
  Icon: typeof CheckCircle2;
  durationMs: number;
}

const toneMeta: Record<NoticeToast['tone'], ToneMeta> = {
  success: {
    title: 'Success',
    cardClassName: 'border-emerald-500/35 bg-emerald-950/70 text-emerald-100',
    iconClassName: 'text-emerald-300',
    Icon: CheckCircle2,
    durationMs: 3600,
  },
  error: {
    title: 'Error',
    cardClassName: 'border-red-500/35 bg-red-950/70 text-red-100',
    iconClassName: 'text-red-300',
    Icon: AlertTriangle,
    durationMs: 7000,
  },
  info: {
    title: 'Heads up',
    cardClassName: 'border-sky-500/35 bg-sky-950/70 text-sky-100',
    iconClassName: 'text-sky-300',
    Icon: Info,
    durationMs: 5000,
  },
};

function ToastCard({ toast, onDismiss }: { toast: NoticeToast; onDismiss: (id: string) => void }) {
  const meta = toneMeta[toast.tone];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, meta.durationMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [meta.durationMs, onDismiss, toast.id]);

  return (
    <motion.div
      key={toast.id}
      layout
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}
      className={`pointer-events-auto no-drag rounded-xl border shadow-2xl shadow-black/35 backdrop-blur-xl ${meta.cardClassName}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <meta.Icon size={18} className={`mt-[1px] shrink-0 ${meta.iconClassName}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] opacity-90">{meta.title}</p>
          <p className="mt-0.5 text-sm leading-snug">{toast.message}</p>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="rounded-md p-1 text-white/60 transition-colors hover:bg-black/25 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>
    </motion.div>
  );
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="pointer-events-none fixed right-4 top-12 z-50 flex w-[min(440px,calc(100vw-2rem))] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}
