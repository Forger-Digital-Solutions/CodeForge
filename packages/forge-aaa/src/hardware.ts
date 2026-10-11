import os from "node:os";
import { execFile } from "node:child_process";

/**
 * Hardware-aware execution (mission §12). The probe reports what it actually measured —
 * VRAM is only populated when a real OS query returns it; an unmeasured GPU is reported
 * as unknown and the scheduler treats heavy work conservatively rather than assuming.
 */
export interface ForgeAaaGpuInfo {
  name: string;
  adapterRamMb?: number;
  vramMeasured: boolean;
}

export interface ForgeAaaHardwareProfile {
  platform: NodeJS.Platform;
  cpuCount: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  gpus: ForgeAaaGpuInfo[];
  probedAt: string;
}

export interface ForgeAaaWorkloadPolicy {
  /** Heavy jobs (editor launches, local model inference, big exports) run sequentially. */
  maxConcurrentHeavy: number;
  maxConcurrentLight: number;
  /** Headroom required before a heavy job may start (MB of free RAM). */
  minFreeMemoryMb: number;
}

export function defaultWorkloadPolicy(hw: ForgeAaaHardwareProfile): ForgeAaaWorkloadPolicy {
  const gpuVram = hw.gpus.map((g) => g.adapterRamMb ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const lowVram = hw.gpus.length > 0 && gpuVram > 0 && gpuVram <= 6144;
  return {
    maxConcurrentHeavy: 1,
    maxConcurrentLight: lowVram || hw.totalMemoryMb <= 16_384 ? 2 : 4,
    minFreeMemoryMb: 2048,
  };
}

/** OS-reported CPU/RAM; GPU query is injectable so tests never touch WMI/PowerShell. */
export async function probeHardware(deps: {
  gpuProbe?: () => Promise<ForgeAaaGpuInfo[]>;
  now?: () => string;
} = {}): Promise<ForgeAaaHardwareProfile> {
  const gpus = deps.gpuProbe ? await deps.gpuProbe().catch(() => []) : [];
  return {
    platform: process.platform,
    cpuCount: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
    gpus,
    probedAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
}

/**
 * Windows GPU probe via CIM — bounded 15s, fail-quiet (no GPU info is a legal answer).
 * AdapterRAM wraps negative on >4 GB devices via the uint32 field, so values ≤ 0 are
 * reported unmeasured rather than trusted.
 */
export async function probeWindowsGpus(): Promise<ForgeAaaGpuInfo[]> {
  if (process.platform !== "win32") return [];
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"],
      { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) { resolve([]); return; }
        try {
          const raw = JSON.parse(stdout) as { Name?: string; AdapterRAM?: number } | { Name?: string; AdapterRAM?: number }[];
          const list = Array.isArray(raw) ? raw : [raw];
          resolve(list.filter((g) => typeof g.Name === "string").map((g) => {
            const ram = typeof g.AdapterRAM === "number" && g.AdapterRAM > 0 ? Math.round(g.AdapterRAM / (1024 * 1024)) : undefined;
            return { name: g.Name!, ...(ram !== undefined ? { adapterRamMb: ram } : {}), vramMeasured: ram !== undefined };
          }));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

export type ForgeAaaWorkloadClass = "heavy" | "light";

interface Queued {
  id: string;
  cls: ForgeAaaWorkloadClass;
  resolve: (release: () => void) => void;
}

/**
 * Bounded scheduler: heavy work (editor, generation, exports) is strictly sequential —
 * one editor launch on a 4 GB VRAM laptop is already the whole machine. Light checks may
 * run in parallel within the cap. Acquisition is FIFO; release returns capacity.
 */
export class ForgeAaaWorkloadScheduler {
  private readonly queue: Queued[] = [];
  private activeHeavy = 0;
  private activeLight = 0;
  private readonly counts = new Map<string, number>();

  constructor(private readonly policy: ForgeAaaWorkloadPolicy) {}

  getPolicy(): ForgeAaaWorkloadPolicy {
    return { ...this.policy };
  }

  active(): { heavy: number; light: number; queued: number } {
    return { heavy: this.activeHeavy, light: this.activeLight, queued: this.queue.length };
  }

  async acquire(id: string, cls: ForgeAaaWorkloadClass, opts: { freeMemoryMb?: number } = {}): Promise<() => void> {
    if (cls === "heavy" && opts.freeMemoryMb !== undefined && opts.freeMemoryMb < this.policy.minFreeMemoryMb) {
      throw new Error(`FORGE_AAA_RESOURCE_LIMIT: ${opts.freeMemoryMb}MB free < required headroom ${this.policy.minFreeMemoryMb}MB`);
    }
    return new Promise((resolve) => {
      this.queue.push({ id, cls, resolve });
      this.drain();
    });
  }

  private drain(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i]!;
      const cap = item.cls === "heavy" ? this.policy.maxConcurrentHeavy : this.policy.maxConcurrentLight;
      const active = item.cls === "heavy" ? this.activeHeavy : this.activeLight;
      // Heavy work also excludes concurrent light work — an editor launch owns the GPU.
      if (active >= cap || (item.cls === "heavy" && this.activeLight > 0 && this.policy.maxConcurrentHeavy === 1)) continue;
      this.queue.splice(i, 1);
      i--;
      if (item.cls === "heavy") this.activeHeavy++; else this.activeLight++;
      this.counts.set(item.cls, (this.counts.get(item.cls) ?? 0) + 1);
      item.resolve(() => this.release(item.cls));
    }
  }

  private release(cls: ForgeAaaWorkloadClass): void {
    if (cls === "heavy") this.activeHeavy = Math.max(0, this.activeHeavy - 1);
    else this.activeLight = Math.max(0, this.activeLight - 1);
    this.drain();
  }
}
