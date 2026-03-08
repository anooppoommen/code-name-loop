import { useCallback } from 'react';
import { useEventStore } from '../../stores/eventStore';
import type { ActivityEvent } from '../../types/ui';

export function useActivityEvent(eventId: string): ActivityEvent | undefined {
  return useEventStore(useCallback((state) => state.events[eventId], [eventId]));
}
