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
    const bySequence = new Map<number, WorkspaceEvent>();
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0) continue;
      bySequence.set(event.seq, event);
    }
    this.events = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
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
