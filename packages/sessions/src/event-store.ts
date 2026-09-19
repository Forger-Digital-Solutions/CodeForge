import type { WorkspaceEvent, WorkspaceEventType } from "@codeforge/protocol";

export interface EventFilter {
  sessionId?: string;
  types?: WorkspaceEventType[];
  afterSeq?: number;
  limit?: number;
}

export class EventStore {
  private events: WorkspaceEvent[] = [];
  private seq = 0;
  private listeners: Set<(event: WorkspaceEvent) => void> = new Set();

  append(event: WorkspaceEvent): void {
    this.seq++;
    const sequenced = { ...event, seq: this.seq } as WorkspaceEvent;
    this.events.push(sequenced);
    this.listeners.forEach((listener) => listener(sequenced));
  }

  getAll(filter?: EventFilter): WorkspaceEvent[] {
    let result = this.events;
    if (filter?.sessionId) {
      result = result.filter((e) => e.sessionId === filter.sessionId);
    }
    if (filter?.types && filter.types.length > 0) {
      const typeSet = new Set(filter.types);
      result = result.filter((e) => typeSet.has(e.type));
    }
    if (filter?.afterSeq !== undefined) {
      result = result.filter((e) => e.seq > filter.afterSeq!);
    }
    if (filter?.limit !== undefined) {
      result = result.slice(-filter.limit);
    }
    return result;
  }

  getBySession(sessionId: string): WorkspaceEvent[] {
    return this.getAll({ sessionId });
  }

  getLastSeq(): number {
    return this.seq;
  }

  subscribe(listener: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hydrate(events: WorkspaceEvent[]): void {
    const valid = events.filter((event) => Number.isSafeInteger(event.seq) && event.seq > 0);
    const uniqueSeqs = new Set(valid.map((event) => event.seq));
    if (uniqueSeqs.size === valid.length) {
      this.events = [...valid].sort((left, right) => left.seq - right.seq);
    } else {
      // Sequence numbers restarted at some point in this store's history (releases before the
      // sequence was hydrated from persistence numbered every process from 1), so seq alone can
      // neither order nor dedupe. Keying by seq would silently drop whole turns and interleave a
      // later run's events before an earlier one. Re-sequence deterministically by wall-clock
      // timestamp (then original seq, then persisted order) so replay, the conversation timeline
      // and the SSE cursor all agree on one chronological order.
      this.events = valid
        .map((event, index) => ({ event, index }))
        .sort((left, right) =>
          (left.event.timestamp ?? "").localeCompare(right.event.timestamp ?? "") ||
          left.event.seq - right.event.seq ||
          left.index - right.index)
        .map(({ event }, position) => ({ ...event, seq: position + 1 }) as WorkspaceEvent);
    }
    this.seq = this.events.at(-1)?.seq ?? 0;
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
  }
}

export function createEventStore(): EventStore {
  return new EventStore();
}
