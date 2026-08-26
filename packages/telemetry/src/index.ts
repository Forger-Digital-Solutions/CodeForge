export class Telemetry {
  constructor(opts?: { enabled?: boolean }) {}
  record(event: unknown): void {}
  drain(): unknown[] {
    return [];
  }
}
