import type { ActivityEvent } from '../../types/ui';

export function textTargetForEvent(event: ActivityEvent): string {
  if (event.kind === 'thought') {
    return event.body || event.title;
  }

  if (event.kind === 'assistant' || event.kind === 'user') {
    return event.body || event.title;
  }

  return event.title;
}
