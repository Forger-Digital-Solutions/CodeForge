import { z } from "zod";

export const TelemetryEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.enum(["run.started", "run.completed", "run.blocked", "run.failed", "worker.observed"]),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().optional(),
  occurredAt: z.string().datetime(),
  data: z.record(z.unknown()),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export interface TelemetryOptions {
  enabled?: boolean;
  maxEvents?: number;
}

/**
 * Bounded process-local telemetry buffer. Persistence remains the server's responsibility; this
 * class validates the shared shape and provides a small adapter for tests and instrumentation.
 */
export class Telemetry {
  private readonly enabled: boolean;
  private readonly maxEvents: number;
  private readonly events: TelemetryEvent[] = [];

  constructor(opts: TelemetryOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? 2_000));
  }

  record(event: TelemetryEvent): void {
    if (!this.enabled) return;
    const parsed = TelemetryEventSchema.parse(event);
    this.events.push(parsed);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  snapshot(): TelemetryEvent[] {
    return this.events.map((event) => ({ ...event, data: { ...event.data } }));
  }

  drain(): TelemetryEvent[] {
    const result = this.snapshot();
    this.events.length = 0;
    return result;
  }

  get size(): number {
    return this.events.length;
  }
}
