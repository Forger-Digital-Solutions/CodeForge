import type { ICloudDatabase } from "@codeforge/cloud-db";

/**
 * Instrumentation used to prove a NEGATIVE: that a code path did not touch the Cloud.
 *
 * Asserting "Direct still works during a Cloud outage" is weak on its own — a Direct path could be
 * silently consulting Cloud auth, the Cloud database, or Hosted accounting and simply tolerating the
 * failure. These spies make the absence of those calls mechanically checkable rather than assumed.
 */
export interface DatabaseSpy {
  db: ICloudDatabase;
  /** Every ICloudDatabase method invoked, in order. */
  calls: string[];
  callsMatching: (pattern: RegExp) => string[];
  reset: () => void;
}

/**
 * Wrap a database so every contract method invocation is recorded. The wrapper delegates faithfully,
 * so the system under test behaves identically — only observation is added.
 */
export function spyOnDatabase(db: ICloudDatabase): DatabaseSpy {
  const calls: string[] = [];
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as ICloudDatabase;

  return {
    db: proxy,
    calls,
    callsMatching: (pattern: RegExp) => calls.filter((c) => pattern.test(c)),
    reset: () => {
      calls.length = 0;
    },
  };
}

export interface FetchSpy {
  fetchFn: typeof fetch;
  /** Every URL requested through this fetch, in order. */
  urls: string[];
  /** URLs whose origin matches one of the watched Cloud origins. */
  cloudCalls: () => string[];
  reset: () => void;
}

/**
 * Wrap `fetch` so every request URL is recorded and Cloud-origin traffic can be isolated.
 *
 * @param cloudOrigins origins that count as "the Cloud" for the purposes of the assertion
 * @param inner the real fetch to delegate to
 */
export function spyOnFetch(cloudOrigins: string[], inner: typeof fetch = fetch): FetchSpy {
  const urls: string[] = [];
  const normalized = cloudOrigins.map((o) => o.replace(/\/$/, ""));

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(href);
    return inner(input as never, init);
  }) as typeof fetch;

  return {
    fetchFn,
    urls,
    cloudCalls: () => urls.filter((u) => normalized.some((origin) => u.startsWith(origin))),
    reset: () => {
      urls.length = 0;
    },
  };
}

/** Counts provider adapter invocations so ordering invariants can be asserted numerically. */
export interface ProviderCallRecorder {
  count: number;
  /** Monotonic sequence numbers at which the provider was invoked, from a shared clock. */
  sequence: number[];
  record: (seq: number) => void;
  reset: () => void;
}

export function createProviderCallRecorder(): ProviderCallRecorder {
  const recorder: ProviderCallRecorder = {
    count: 0,
    sequence: [],
    record(seq: number) {
      recorder.count++;
      recorder.sequence.push(seq);
    },
    reset() {
      recorder.count = 0;
      recorder.sequence.length = 0;
    },
  };
  return recorder;
}

/**
 * A shared monotonic counter. Using one clock for both "reservation happened" and "provider was
 * invoked" is what makes the ordering claim testable — wall-clock timestamps can tie, sequence
 * numbers cannot.
 */
export function createSequenceClock(): { next: () => number; current: () => number } {
  let value = 0;
  return {
    next: () => ++value,
    current: () => value,
  };
}
