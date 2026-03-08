import { create } from 'zustand';
import type { ActivityEvent } from '../types/ui';

export interface EventStoreState {
  events: Record<string, ActivityEvent>;
  replaceConversationEvents: (previousIds: string[], events: ActivityEvent[]) => void;
  upsertEvent: (event: ActivityEvent) => void;
  upsertEvents: (events: ActivityEvent[]) => void;
  updateEvent: (id: string, transform: (event: ActivityEvent) => ActivityEvent) => ActivityEvent | null;
  removeEvents: (ids: string[]) => void;
  clearEvents: () => void;
}

export const useEventStore = create<EventStoreState>((set, get) => ({
  events: {},
  replaceConversationEvents: (previousIds, events) =>
    set((state) => {
      const next = { ...state.events };
      for (const id of previousIds) {
        delete next[id];
      }
      for (const event of events) {
        next[event.id] = event;
      }
      return { events: next };
    }),
  upsertEvent: (event) =>
    set((state) => ({
      events: {
        ...state.events,
        [event.id]: event,
      },
    })),
  upsertEvents: (events) =>
    set((state) => {
      if (events.length === 0) {
        return state;
      }
      const next = { ...state.events };
      for (const event of events) {
        next[event.id] = event;
      }
      return { events: next };
    }),
  updateEvent: (id, transform) => {
    const current = get().events[id];
    if (!current) {
      return null;
    }

    const nextEvent = transform(current);
    set((state) => ({
      events: {
        ...state.events,
        [id]: nextEvent,
      },
    }));
    return nextEvent;
  },
  removeEvents: (ids) =>
    set((state) => {
      if (ids.length === 0) {
        return state;
      }
      const next = { ...state.events };
      for (const id of ids) {
        delete next[id];
      }
      return { events: next };
    }),
  clearEvents: () => set({ events: {} }),
}));
