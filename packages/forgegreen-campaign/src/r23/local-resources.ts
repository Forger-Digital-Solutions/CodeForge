import { execFile } from "node:child_process";
import type { MeasuredNumber } from "./run-record.js";
import { measured, unknownMetric } from "./run-record.js";

/**
 * Local resource sampling for the harness process (protocol §12 — MEASURED, local only).
 *
 * CPU time and RSS come from Node's own process accounting (`process.cpuUsage`, `memoryUsage`),
 * which is exact for the harness process that hosts the agent runtime and its tools' parent
 * process. Child processes spawned by tools (verifiers, `run_command`) are NOT included — stated
 * on every record via `sampler`. GPU power is a single `nvidia-smi` sample taken as "idle local
 * GPU" evidence; it is never attributed to remote inference.
 */

export interface LocalResourceSample {
  cpuUserMs: MeasuredNumber;
  cpuSystemMs: MeasuredNumber;
  peakRssBytes: MeasuredNumber;
  gpuPowerDrawWattsIdleSample: MeasuredNumber;
  sampler: string;
}

export const LOCAL_RESOURCE_SAMPLER_ID = "node-process-cpu-rss-1 (harness process only; tool child processes excluded)";

export class LocalResourceSampler {
  private startCpu?: NodeJS.CpuUsage;
  private peakRss = 0;
  private timer?: NodeJS.Timeout;
  private readonly intervalMs: number;

  constructor(options: { intervalMs?: number } = {}) {
    this.intervalMs = options.intervalMs ?? 250;
  }

  start(): void {
    this.startCpu = process.cpuUsage();
    this.peakRss = process.memoryUsage().rss;
    this.timer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > this.peakRss) this.peakRss = rss;
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(options: { sampleGpu?: boolean } = {}): Promise<LocalResourceSample> {
    if (this.timer) clearInterval(this.timer);
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRss) this.peakRss = rss;
    const delta = this.startCpu ? process.cpuUsage(this.startCpu) : undefined;
    const gpu = options.sampleGpu ? await sampleGpuPowerWatts() : undefined;
    return {
      cpuUserMs: delta ? measured(Math.round(delta.user / 1000), "HARNESS") : unknownMetric("sampler not started"),
      cpuSystemMs: delta ? measured(Math.round(delta.system / 1000), "HARNESS") : unknownMetric("sampler not started"),
      peakRssBytes: this.startCpu ? measured(this.peakRss, "HARNESS") : unknownMetric("sampler not started"),
      gpuPowerDrawWattsIdleSample: gpu === undefined ? unknownMetric(options.sampleGpu ? "nvidia-smi unavailable" : "not sampled") : measured(gpu, "HARNESS", "single nvidia-smi sample; local GPU is idle — not inference"),
      sampler: LOCAL_RESOURCE_SAMPLER_ID,
    };
  }
}

export function sampleGpuPowerWatts(timeoutMs = 3000): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile("nvidia-smi", ["--query-gpu=power.draw", "--format=csv,noheader,nounits"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) return done(undefined);
        const value = Number.parseFloat(String(stdout).trim().split(/\r?\n/)[0] ?? "");
        done(Number.isFinite(value) && value >= 0 ? value : undefined);
      });
      child.on("error", () => done(undefined));
    } catch {
      done(undefined);
    }
  });
}
