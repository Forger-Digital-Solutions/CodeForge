import { redactSecrets } from "./redaction.js";

/**
 * Security audit events: the facts a reviewer needs after redaction — who (opaque user id), from
 * where (IP), what happened, and whether it succeeded — never the credential itself.
 *
 * Event names are stable identifiers; add new ones rather than repurposing existing ones.
 */
export type SecurityAuditEventType =
  | "auth.login.succeeded"
  | "auth.login.failed"
  | "auth.logout"
  | "auth.session.refreshed"
  | "auth.session.replay_detected"
  | "auth.session.rejected"
  | "auth.oauth.state_invalid"
  | "auth.oauth.denied"
  | "account.settings.changed"
  | "account.deleted"
  | "github.app.authorized"
  | "github.app.authorization_failed"
  | "billing.checkout.started"
  | "billing.portal.opened"
  | "billing.webhook.signature_invalid"
  | "billing.webhook.duplicate"
  | "billing.webhook.processed"
  | "billing.webhook.rejected"
  | "billing.subscription.changed"
  | "tenant.access.denied"
  | "ratelimit.exceeded"
  | "crypto.decrypt.failed"
  | "crypto.key.rotation"
  | "request.rejected";

export type SecurityAuditOutcome = "success" | "failure" | "denied" | "info";

export interface SecurityAuditEvent {
  type: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  /** Opaque CodeForge user id. Never an email or GitHub login. */
  userId?: string;
  ipAddress?: string;
  /** Small, redacted, low-cardinality details (error codes, event kinds). Never raw payloads. */
  details?: Record<string, string | number | boolean | null>;
  occurredAt?: string;
}

export interface SecurityAuditSink {
  record(event: SecurityAuditEvent): void | Promise<void>;
}

const MAX_DETAIL_STRING = 256;
const MAX_DETAIL_KEYS = 16;

/**
 * Normalize an event before it reaches any sink: bounded, redacted, and never throwing. A sink
 * failure must not break the authenticated operation it observes, so `emit` swallows errors.
 */
export function sanitizeSecurityAuditEvent(event: SecurityAuditEvent): SecurityAuditEvent {
  const details: Record<string, string | number | boolean | null> = {};
  if (event.details) {
    for (const [key, value] of Object.entries(event.details).slice(0, MAX_DETAIL_KEYS)) {
      if (typeof value === "string") {
        details[key.slice(0, 64)] = redactSecrets(value).slice(0, MAX_DETAIL_STRING);
      } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
        details[key.slice(0, 64)] = value;
      }
    }
  }
  return {
    type: event.type,
    outcome: event.outcome,
    ...(event.userId ? { userId: String(event.userId).slice(0, 128) } : {}),
    ...(event.ipAddress ? { ipAddress: String(event.ipAddress).slice(0, 64) } : {}),
    details,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
}

export class SecurityAuditLog {
  private readonly sinks: SecurityAuditSink[];
  private readonly counters = new Map<string, number>();

  constructor(sinks: SecurityAuditSink[] = []) {
    this.sinks = [...sinks];
  }

  addSink(sink: SecurityAuditSink): void {
    this.sinks.push(sink);
  }

  /** Fire-and-forget. Never throws, never blocks the caller on sink I/O. */
  emit(event: SecurityAuditEvent): void {
    const safe = sanitizeSecurityAuditEvent(event);
    const counterKey = `${safe.type}:${safe.outcome}`;
    this.counters.set(counterKey, (this.counters.get(counterKey) ?? 0) + 1);
    for (const sink of this.sinks) {
      try {
        const result = sink.record(safe);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // A failing audit sink must never take down the operation being audited.
      }
    }
  }

  /** Aggregate, secret-free counters suitable for a health/metrics endpoint. */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** In-memory sink for tests and for the local (desktop) process where no database sink exists. */
export class MemorySecurityAuditSink implements SecurityAuditSink {
  readonly events: SecurityAuditEvent[] = [];
  constructor(private readonly maxEvents = 1000) {}
  record(event: SecurityAuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }
}

/**
 * Console sink that writes one redacted JSON line per event. Suitable for platform log
 * aggregation (Render/Docker stdout). Uses `console.info` so it is separable from application
 * errors; the line never contains a credential because every field passed through
 * {@link sanitizeSecurityAuditEvent}.
 */
export class ConsoleSecurityAuditSink implements SecurityAuditSink {
  constructor(private readonly write: (line: string) => void = (line) => console.info(line)) {}
  record(event: SecurityAuditEvent): void {
    this.write(`[security-audit] ${JSON.stringify(event)}`);
  }
}
