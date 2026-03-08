import { BookOpen, Pencil, Search } from 'lucide-react';
import { memo } from 'react';
import type { ToolTag } from '../../types/ui';

const tagStyles: Record<ToolTag, { label: string; className: string; Icon: typeof BookOpen }> = {
  read: {
    label: 'Read',
    className: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
    Icon: BookOpen,
  },
  discovery: {
    label: 'Discovery',
    className: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
    Icon: Search,
  },
  write: {
    label: 'Write',
    className: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
    Icon: Pencil,
  },
};

export const ToolTagBadges = memo(function ToolTagBadges({ tags }: { tags: ToolTag[] }) {
  if (!tags.length) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      {tags.map((tag) => {
        const spec = tagStyles[tag];
        if (!spec) {
          return null;
        }
        const Icon = spec.Icon;
        return (
          <span key={tag} title={spec.label} className={`inline-flex items-center justify-center ${spec.className}`}>
            <Icon size={11} strokeWidth={2} />
          </span>
        );
      })}
    </div>
  );
});
